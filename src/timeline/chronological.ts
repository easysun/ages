import type { EventAt } from "./validation";
import type { Viewport } from "./viewport";

export type ChronologicalOverviewRow = Readonly<{
  id: string;
  position: number;
  event_at: unknown;
}>;

export type CalendarDateBand = Readonly<{
  id: string;
  position: number;
  date: string;
  time_zone: string;
  dayOrdinal: number;
  start: number;
  end: number;
}>;

export type ExactInstantPoint = Readonly<{
  id: string;
  position: number;
  instant: string;
  time_zone: string;
  epochMs: number;
}>;

export type DateBinAggregate = Readonly<{
  bin: number;
  pixelStart: number;
  pixelEnd: number;
  spanCoverageCount: number;
  itemCount: number;
  firstItemIndex: number;
  endItemIndex: number;
  firstDate: string | null;
  lastDate: string | null;
}>;

export type ChoiceRange = Readonly<{
  firstItemIndex: number;
  endItemIndex: number;
}>;

export type ChoicePage<T> = Readonly<{
  items: readonly T[];
  nextOffset: number | null;
}>;

export type ChronologicalIndex = Readonly<{
  dates: readonly CalendarDateBand[];
  instants: readonly ExactInstantPoint[];
  instantCoordinates: readonly number[];
  undated: readonly Readonly<{ id: string; position: number }>[];
  storyOrdinalById: ReadonlyMap<string, number>;
}>;

const maximumDateTime = 8.64e15;
const defaultDateBinWidth = 48;
const maximumChoicePageSize = 100;
const dateLabelPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const normalizedInstantPattern =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ValidatedEvent =
  | Readonly<{
      kind: "date";
      date: string;
      time_zone: string;
      dayOrdinal: number;
    }>
  | Readonly<{
      kind: "instant";
      instant: string;
      time_zone: string;
      epochMs: number;
    }>
  | null;

function invalidProjection(): never {
  throw new TypeError("Invalid chronological overview projection.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function dayOrdinalForDateLabel(value: string) {
  const match = dateLabelPattern.exec(value);
  if (!match) return invalidProjection();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return invalidProjection();

  const monthLengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > (monthLengths[month - 1] as number))
    return invalidProjection();

  let adjustedYear = year;
  if (month <= 2) adjustedYear--;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function validateTimeZone(value: unknown, validatedZones: Set<string>) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    /^[+-]/.test(value)
  )
    return invalidProjection();
  if (validatedZones.has(value)) return value;

  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    return invalidProjection();
  }
  validatedZones.add(value);
  return value;
}

function epochForNormalizedInstant(value: unknown) {
  if (typeof value !== "string" || !normalizedInstantPattern.test(value))
    return invalidProjection();

  const date = new Date(value);
  const epochMs = date.getTime();
  if (
    !Number.isFinite(epochMs) ||
    epochMs < -maximumDateTime ||
    epochMs > maximumDateTime ||
    date.toISOString() !== value
  )
    return invalidProjection();
  return epochMs;
}

function validateEventAt(
  value: unknown,
  validatedZones: Set<string>,
): ValidatedEvent {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string")
    return invalidProjection();

  if (value.kind === "date") {
    if (
      !hasExactKeys(value, ["kind", "date", "time_zone", "calendar"]) ||
      value.calendar !== "iso8601" ||
      typeof value.date !== "string"
    )
      return invalidProjection();
    const event = value as Extract<EventAt, { kind: "date" }>;
    return {
      kind: "date",
      date: event.date,
      time_zone: validateTimeZone(event.time_zone, validatedZones),
      dayOrdinal: dayOrdinalForDateLabel(event.date),
    };
  }

  if (value.kind === "instant") {
    if (
      !hasExactKeys(value, ["kind", "instant", "time_zone"]) ||
      typeof value.instant !== "string"
    )
      return invalidProjection();
    const event = value as Extract<EventAt, { kind: "instant" }>;
    return {
      kind: "instant",
      instant: event.instant,
      time_zone: validateTimeZone(event.time_zone, validatedZones),
      epochMs: epochForNormalizedInstant(event.instant),
    };
  }

  return invalidProjection();
}

function validateRow(value: unknown): ChronologicalOverviewRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "position", "event_at"]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 100 ||
    typeof value.position !== "number" ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0
  )
    return invalidProjection();
  return value as unknown as ChronologicalOverviewRow;
}

function comparePositionAndId(
  left: Readonly<{ id: string; position: number }>,
  right: Readonly<{ id: string; position: number }>,
) {
  return left.position - right.position || compareStrings(left.id, right.id);
}

export function buildChronologicalIndex(
  rows: readonly ChronologicalOverviewRow[],
): ChronologicalIndex {
  if (!Array.isArray(rows)) return invalidProjection();

  const dates: CalendarDateBand[] = [];
  const instants: ExactInstantPoint[] = [];
  const undated: Array<{ id: string; position: number }> = [];
  const storyRows: Array<{ id: string; position: number }> = [];
  const ids = new Set<string>();
  const validatedZones = new Set<string>();

  for (const candidate of rows) {
    const input = validateRow(candidate);
    if (ids.has(input.id)) return invalidProjection();
    ids.add(input.id);
    storyRows.push({ id: input.id, position: input.position });

    const event = validateEventAt(input.event_at, validatedZones);
    if (event === null) {
      undated.push({ id: input.id, position: input.position });
    } else if (event.kind === "date") {
      dates.push({
        id: input.id,
        position: input.position,
        date: event.date,
        time_zone: event.time_zone,
        dayOrdinal: event.dayOrdinal,
        start: event.dayOrdinal,
        end: event.dayOrdinal + 1,
      });
    } else {
      instants.push({
        id: input.id,
        position: input.position,
        instant: event.instant,
        time_zone: event.time_zone,
        epochMs: event.epochMs,
      });
    }
  }

  dates.sort(
    (left, right) =>
      left.dayOrdinal - right.dayOrdinal ||
      compareStrings(left.time_zone, right.time_zone) ||
      compareStrings(left.id, right.id),
  );
  instants.sort(
    (left, right) =>
      left.epochMs - right.epochMs || compareStrings(left.id, right.id),
  );
  undated.sort(comparePositionAndId);
  storyRows.sort(comparePositionAndId);

  const storyOrdinalById = new Map<string, number>();
  for (const [index, item] of storyRows.entries())
    storyOrdinalById.set(item.id, index + 1);

  return {
    dates,
    instants,
    instantCoordinates: instants.map((item) => item.epochMs),
    undated,
    storyOrdinalById,
  };
}

function validateViewport(view: Viewport, extent: number, binWidth: number) {
  if (
    !Number.isFinite(view.center) ||
    !Number.isFinite(view.span) ||
    view.span <= 0 ||
    !Number.isFinite(extent) ||
    extent <= 0 ||
    !Number.isFinite(binWidth) ||
    binWidth <= 0
  )
    throw new RangeError(
      "Date-bin viewport values must be finite and positive.",
    );

  const left = view.center + (0 / extent - 0.5) * view.span;
  const right = view.center + (extent / extent - 0.5) * view.span;
  const binCount = Math.ceil(extent / binWidth);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(right) ||
    left >= right ||
    !Number.isSafeInteger(binCount) ||
    binCount < 1
  )
    throw new RangeError("Date-bin viewport range is not representable.");
  return { left, right, binCount };
}

function dateSpanCoverageStart(
  dates: readonly CalendarDateBand[],
  worldLeft: number,
) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((dates[middle] as CalendarDateBand).end <= worldLeft) low = middle + 1;
    else high = middle;
  }
  return low;
}

function dateSpanCoverageEnd(
  dates: readonly CalendarDateBand[],
  worldRight: number,
) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((dates[middle] as CalendarDateBand).start < worldRight)
      low = middle + 1;
    else high = middle;
  }
  return low;
}

function clippedSpanMidpoint(
  dayOrdinal: number,
  viewportLeft: number,
  viewportRight: number,
) {
  const bandEnd = dayOrdinal + 1;
  if (bandEnd <= viewportLeft) return Number.NEGATIVE_INFINITY;
  if (dayOrdinal >= viewportRight) return Number.POSITIVE_INFINITY;
  const clippedStart = Math.max(dayOrdinal, viewportLeft);
  const clippedEnd = Math.min(bandEnd, viewportRight);
  return clippedStart + (clippedEnd - clippedStart) / 2;
}

function dateMidpointBound(
  dates: readonly CalendarDateBand[],
  worldPoint: number,
  viewportLeft: number,
  viewportRight: number,
) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const date = dates[middle] as CalendarDateBand;
    if (
      clippedSpanMidpoint(date.dayOrdinal, viewportLeft, viewportRight) <
      worldPoint
    )
      low = middle + 1;
    else high = middle;
  }
  return low;
}

export function aggregateDateBins(
  index: ChronologicalIndex,
  view: Viewport,
  extent: number,
  binWidth = defaultDateBinWidth,
): readonly DateBinAggregate[] {
  const { left, right, binCount } = validateViewport(view, extent, binWidth);
  const aggregates: DateBinAggregate[] = [];

  for (let bin = 0; bin < binCount; bin++) {
    const pixelStart = bin * binWidth;
    const pixelEnd = Math.min(extent, (bin + 1) * binWidth);
    const worldLeft = view.center + (pixelStart / extent - 0.5) * view.span;
    const worldRight = view.center + (pixelEnd / extent - 0.5) * view.span;
    if (pixelEnd <= pixelStart || worldRight <= worldLeft)
      throw new RangeError("Date-bin width is below viewport precision.");

    const firstCoverageIndex = dateSpanCoverageStart(index.dates, worldLeft);
    const endCoverageIndex = dateSpanCoverageEnd(index.dates, worldRight);
    const firstItemIndex = dateMidpointBound(
      index.dates,
      worldLeft,
      left,
      right,
    );
    const endItemIndex = dateMidpointBound(
      index.dates,
      worldRight,
      left,
      right,
    );
    const spanCoverageCount = Math.max(
      0,
      endCoverageIndex - firstCoverageIndex,
    );
    const itemCount = endItemIndex - firstItemIndex;
    if (spanCoverageCount === 0 && itemCount === 0) continue;

    const firstDate =
      itemCount === 0
        ? null
        : (index.dates[firstItemIndex] as CalendarDateBand).date;
    const lastDate =
      itemCount === 0
        ? null
        : (index.dates[endItemIndex - 1] as CalendarDateBand).date;
    aggregates.push({
      bin,
      pixelStart,
      pixelEnd,
      spanCoverageCount,
      itemCount,
      firstItemIndex,
      endItemIndex,
      firstDate,
      lastDate,
    });
  }

  return aggregates;
}

export function pageChoices<T>(
  items: readonly T[],
  range: ChoiceRange,
  offset = 0,
  limit = maximumChoicePageSize,
): ChoicePage<T> {
  const { firstItemIndex, endItemIndex } = range;
  if (
    !Array.isArray(items) ||
    !Number.isSafeInteger(firstItemIndex) ||
    !Number.isSafeInteger(endItemIndex) ||
    firstItemIndex < 0 ||
    endItemIndex < firstItemIndex ||
    endItemIndex > items.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    throw new RangeError("Choice page range is invalid.");

  const rangeLength = endItemIndex - firstItemIndex;
  const pageOffset = Math.min(offset, rangeLength);
  const pageEndOffset = Math.min(
    rangeLength,
    pageOffset + Math.min(limit, maximumChoicePageSize),
  );
  const pageItems: T[] = [];
  for (
    let index = firstItemIndex + pageOffset;
    index < firstItemIndex + pageEndOffset;
    index++
  )
    pageItems.push(items[index] as T);

  return {
    items: pageItems,
    nextOffset: pageEndOffset < rangeLength ? pageEndOffset : null,
  };
}
