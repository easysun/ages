import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { analyzeTrace, parseTrace } from "./chromium-trace-metrics.mjs";

const USAGE =
  "Usage: node scripts/analyze-chromium-traces.mjs <manifest.json> [--out <new-report.json>]";
const METADATA_TEXT_LIMIT = 256;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value) {
  const hasControlCharacters =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    });
  return (
    typeof value === "string" &&
    value.length <= METADATA_TEXT_LIMIT &&
    !hasControlCharacters &&
    !/https?:\/\//i.test(value)
  );
}

function selectTextFields(record, fieldNames) {
  if (!isRecord(record)) return {};
  return Object.fromEntries(
    fieldNames
      .filter((name) => safeText(record[name]))
      .map((name) => [name, record[name]]),
  );
}

function selectNumberFields(record, fieldNames) {
  if (!isRecord(record)) return {};
  return Object.fromEntries(
    fieldNames
      .filter(
        (name) =>
          typeof record[name] === "number" && Number.isFinite(record[name]),
      )
      .map((name) => [name, record[name]]),
  );
}

function selectedMetadata(manifest) {
  const hardware = isRecord(manifest.hardware) ? manifest.hardware : {};
  const activeDisplay = isRecord(hardware.activeDisplay)
    ? hardware.activeDisplay
    : {};
  const metadata = {
    inputMethod: safeText(manifest.inputMethod) ? manifest.inputMethod : null,
    renderer: safeText(manifest.renderer) ? manifest.renderer : null,
    browser: selectTextFields(manifest.browser, ["product", "version"]),
    hardware: {
      ...selectTextFields(hardware, [
        "qualification",
        "modelIdentifier",
        "chip",
        "os",
        "osBuild",
      ]),
      ...selectNumberFields(hardware, ["memoryGB"]),
      activeDisplay: selectNumberFields(activeDisplay, [
        "width",
        "height",
        "refreshRateHz",
      ]),
    },
    viewport: selectNumberFields(manifest.viewport, [
      "innerWidth",
      "innerHeight",
      "devicePixelRatio",
      "screenWidth",
      "screenHeight",
    ]),
    cache: safeText(manifest.cache) ? manifest.cache : null,
  };

  if (safeText(manifest.sourceRevision))
    metadata.sourceRevision = manifest.sourceRevision;
  if (
    typeof manifest.sourceHashSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(manifest.sourceHashSha256)
  ) {
    metadata.sourceHashSha256 = manifest.sourceHashSha256;
  }

  return metadata;
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.traces)) {
    throw new Error("Invalid manifest: expected a traces array.");
  }
  if (manifest.traces.length === 0) {
    throw new Error("Invalid manifest: traces array must not be empty.");
  }
  if (
    manifest.measurementSegments !== undefined &&
    !Array.isArray(manifest.measurementSegments)
  ) {
    throw new Error("Invalid manifest: measurementSegments must be an array.");
  }

  const traceNames = new Set();
  for (const record of manifest.traces) {
    if (
      !isRecord(record) ||
      !safeText(record.fixture) ||
      record.fixture.length === 0 ||
      !safeText(record.trace) ||
      record.trace.length === 0
    ) {
      throw new Error("Invalid manifest: each trace needs a fixture and path.");
    }
    if (
      record.trace !== basename(record.trace) ||
      /[\\/]/.test(record.trace) ||
      !record.trace.endsWith(".trace.json")
    ) {
      throw new Error("Trace path must be a basename ending in .trace.json.");
    }
    if (traceNames.has(record.trace)) {
      throw new Error("Invalid manifest: duplicate trace basename.");
    }
    traceNames.add(record.trace);
    if (
      record.dataLossOccurred !== undefined &&
      record.dataLossOccurred !== null &&
      typeof record.dataLossOccurred !== "boolean"
    ) {
      throw new Error(
        "Invalid manifest: dataLossOccurred must be boolean or unknown.",
      );
    }
  }

  return manifest;
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid manifest JSON.");
  }
  return validateManifest(manifest);
}

function readTrace(directory, record) {
  const tracePath = resolve(directory, record.trace);
  let fileInfo;
  try {
    fileInfo = lstatSync(tracePath);
  } catch {
    throw new Error(`Unable to read trace '${record.trace}'.`);
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Trace '${record.trace}' must be a regular file.`);
  }

  let bytes;
  try {
    bytes = readFileSync(tracePath);
  } catch {
    throw new Error(`Unable to read trace '${record.trace}'.`);
  }

  let trace;
  try {
    trace = parseTrace(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid trace JSON '${record.trace}'.`);
  }

  return { bytes, trace };
}

function buildTraceReport(directory, record, measurementSegments) {
  const { bytes, trace } = readTrace(directory, record);
  const analysis = analyzeTrace(
    trace,
    {
      trace: record.trace,
      dataLossOccurred:
        typeof record.dataLossOccurred === "boolean"
          ? record.dataLossOccurred
          : undefined,
    },
    measurementSegments,
  );

  return {
    fixture: record.fixture,
    trace: record.trace,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dataLossOccurred:
      typeof record.dataLossOccurred === "boolean"
        ? record.dataLossOccurred
        : null,
    counts: analysis.counts,
    inputToPresentedFrameSamples: analysis.inputToPresentedFrameSamples.map(
      ({ durationUs, status, reasonCodes }) => ({
        duration: durationUs,
        unit: "microseconds",
        status,
        reasonCodes,
      }),
    ),
    frameIntervals: {
      ...analysis.frameIntervals,
      unit: "microseconds",
    },
    diagnostics: analysis.diagnostics,
  };
}

function buildReport(manifest, manifestPath) {
  const manifestDirectory = dirname(manifestPath);
  return {
    schemaVersion: 1,
    status: "diagnostic-only",
    metric: "input-to-presented-frame",
    metadata: selectedMetadata(manifest),
    traces: manifest.traces.map((record) =>
      buildTraceReport(
        manifestDirectory,
        record,
        manifest.measurementSegments ?? [],
      ),
    ),
  };
}

function writeExclusive(outputPath, contents) {
  let descriptor;
  try {
    descriptor = openSync(outputPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already have been closed.
      }
      try {
        unlinkSync(outputPath);
      } catch {
        // Preserve the original output error.
      }
    }
    if (error?.code === "EEXIST") {
      throw new Error(
        `Output already exists or is not exclusive: ${outputPath}`,
      );
    }
    throw new Error(`Unable to write output report: ${outputPath}`);
  }
}

function parseArguments(args) {
  if (args.length === 1 && typeof args[0] === "string" && args[0].length > 0) {
    return { manifestPath: args[0], outputPath: null };
  }
  if (
    args.length === 3 &&
    typeof args[0] === "string" &&
    args[0].length > 0 &&
    args[1] === "--out" &&
    typeof args[2] === "string" &&
    args[2].length > 0
  ) {
    return { manifestPath: args[0], outputPath: args[2] };
  }
  throw new Error(USAGE);
}

function main(args) {
  const parsedArgs = parseArguments(args);
  const manifestPath = resolve(parsedArgs.manifestPath);
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new Error("Unable to read manifest.");
  }

  const manifest = parseManifest(manifestBytes);
  const report = buildReport(manifest, manifestPath);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;

  if (parsedArgs.outputPath === null) {
    process.stdout.write(reportText);
    return;
  }

  const outputPath = resolve(parsedArgs.outputPath);
  writeExclusive(outputPath, reportText);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Trace analysis failed."}\n`,
  );
  process.exitCode = 1;
}
