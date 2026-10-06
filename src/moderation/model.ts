import { z } from "zod";

const id = z.string().min(1).max(100);
const text = z.string().refine((value) =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 ? code !== 127 : code === 9 || code === 10 || code === 13;
  }),
);
export const reportTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("timeline"), timeline_id: id }),
  z.strictObject({
    kind: z.literal("link"),
    slug: z.string().regex(/^[a-z0-9-]{3,64}$/),
  }),
]);
export const reportSchema = z.strictObject({
  target: reportTargetSchema,
  category: z.enum(["spam", "abuse", "copyright", "illegal", "other"]),
  detail: text.pipe(z.string().max(1000)).default(""),
});
export const moderationSchema = z.strictObject({
  target: z.strictObject({ kind: z.enum(["asset", "timeline", "link"]), id }),
  blocked: z.boolean(),
  reason: text.pipe(z.string().trim().min(1).max(500)),
});
export type ReportInput = z.infer<typeof reportSchema>;
export type ReportTarget = z.infer<typeof reportTargetSchema>;
export type ModerationInput = z.infer<typeof moderationSchema>;
export const moderationTables = {
  asset: "assets",
  timeline: "timelines",
  link: "distribution_links",
} as const;
