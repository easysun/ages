import { z } from "zod";

const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    if (/^[+-]/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const date = z.iso.date().refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
});
export const eventAtSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("date"),
    date,
    time_zone: timeZone,
    calendar: z.literal("iso8601"),
  }),
  z.strictObject({
    kind: z.literal("instant"),
    instant: z.iso
      .datetime({ offset: true })
      .refine((value) => date.safeParse(value.slice(0, 10)).success)
      .transform((value) => new Date(value).toISOString()),
    time_zone: timeZone,
  }),
]);
const expectedVersion = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
const id = z.string().min(1).max(100);
const title = z.string().trim().min(1).max(200);
export const createTimelineSchema = z.strictObject({ title });
export const updateTimelineSchema = z
  .strictObject({
    expected_version: expectedVersion,
    title: title.optional(),
    visibility: z.enum(["private", "unlisted", "public"]).optional(),
    cover_asset_id: id.nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.visibility !== undefined ||
      value.cover_asset_id !== undefined,
  );
export const appendItemSchema = z.strictObject({
  expected_version: expectedVersion,
  asset_id: id,
  caption: z.string().max(10000).default(""),
  event_at: eventAtSchema.nullable().default(null),
});
export const updateItemSchema = z
  .strictObject({
    expected_version: expectedVersion,
    caption: z.string().max(10000).optional(),
    event_at: eventAtSchema.nullable().optional(),
  })
  .refine(
    (value) => value.caption !== undefined || value.event_at !== undefined,
  );
export const removeItemSchema = z.strictObject({
  expected_version: expectedVersion,
});
export const orderSchema = z.strictObject({
  expected_version: expectedVersion,
  item_ids: z
    .array(id)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const listSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(),
});
export const cursorSchema = z.strictObject({
  created_at: z.iso.datetime(),
  id,
});
export type EventAt = z.output<typeof eventAtSchema>;
