import type { Context } from "hono";
import type { z } from "zod";
import type { AppContext } from "../bindings";
import { ApiError } from "./errors";

export async function parseJson<S extends z.ZodType>(
  context: Context<AppContext>,
  schema: S,
): Promise<z.output<S>> {
  const mediaType = context.req
    .header("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError("INVALID_REQUEST");
  }

  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("INVALID_REQUEST");
  }
  return result.data;
}
