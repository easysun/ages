import { z } from "zod";

const slugSchema = z.string().regex(/^[a-z0-9-]{3,64}$/);
const urlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    if (
      [...value].some(
        (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
      )
    )
      return false;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).href);
const expirySchema = z.iso
  .datetime()
  .refine((value) => {
    const parsed = new Date(value);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value.slice(0, 10) &&
      parsed.getTime() > Date.now()
    );
  })
  .transform((value) => new Date(value).toISOString())
  .nullable();
export const createLinkSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("url"), url: urlSchema }),
    z.strictObject({
      kind: z.literal("timeline"),
      timeline_id: z.string().min(1).max(100),
    }),
  ]),
  slug: slugSchema.optional(),
  expires_at: expirySchema.default(null),
});
export const updateLinkSchema = z
  .strictObject({
    active: z.boolean().optional(),
    expires_at: expirySchema.optional(),
  })
  .refine(
    (value) => value.active !== undefined || value.expires_at !== undefined,
  );
export type Link = {
  id: string;
  owner_id: string;
  slug: string;
  target_kind: "url" | "timeline";
  target_url: string | null;
  timeline_id: string | null;
  active: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};
export function linkPayload(link: Link) {
  return {
    id: link.id,
    slug: link.slug,
    target:
      link.target_kind === "url"
        ? { kind: "url" as const, url: link.target_url }
        : { kind: "timeline" as const, timeline_id: link.timeline_id },
    active: link.active === 1,
    expires_at: link.expires_at,
    created_at: link.created_at,
    updated_at: link.updated_at,
  };
}
