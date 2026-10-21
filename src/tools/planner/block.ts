import { z } from "zod";

/** What a planner block is; the planner draws each kind differently. */
export const PLANNER_KINDS = [
  "wake",
  "meal",
  "class",
  "exam",
  "study",
  "gym",
  "shower",
  "recruiting",
  "free",
  "lights_out",
  "fixed",
] as const;

/** The glyphs a planner block can carry. */
export const PLANNER_ICONS = [
  "sun",
  "cup",
  "fork",
  "book",
  "pulse",
  "drop",
  "brief",
  "leaf",
  "moon",
  "flag",
  "pencil",
  "walk",
  "users",
  "phone",
] as const;

const instant = z.string().datetime({ offset: true });

/** The fields of one planner block, as every planner write tool takes them. */
export const blockFields = {
  start_at: instant,
  end_at: instant,
  title: z.string().min(1),
  note: z.string().nullable().optional(),
  kind: z.enum(PLANNER_KINDS),
  icon: z.enum(PLANNER_ICONS),
  fixed: z.boolean().optional(),
  overlap_ok: z.boolean().optional(),
};

/** JSON Schema for {@link blockFields}, shown to the model. */
export const blockProperties = {
  start_at: { type: "string", description: "ISO 8601 with offset, e.g. 2026-10-21T07:00:00-04:00" },
  end_at: { type: "string", description: "ISO 8601 with offset; after start_at" },
  title: { type: "string", description: "Short and the same every day: Wake up, Breakfast, Gym, Study, Free time, Lights out. Details go in note." },
  note: { type: ["string", "null"], description: "Room, split, exam name, rules for the block." },
  kind: { type: "string", enum: PLANNER_KINDS },
  icon: { type: "string", enum: PLANNER_ICONS, description: "Pick one that fits; Gym is pulse." },
  fixed: { type: "boolean", description: "Default true. False only for time that can give way, such as free time." },
  overlap_ok: { type: "boolean", description: "Default false. True only where Ankur said the overlap is fine." },
} as const;

/** One block as `planner_replace_range` takes it. */
export const blockInput = z.object(blockFields).strict();
