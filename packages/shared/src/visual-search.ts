import { z } from 'zod';

export const VISUAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const VISUAL_IMAGE_MAX_PIXELS = 20_000_000;
export const VISUAL_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VISUAL_INPUT_TTL_MS = 15 * 60 * 1000;
export const VISUAL_LOCATION_LIMIT = 100;

const scope = {
  locationIds: z.array(z.uuid().toLowerCase()).min(1).max(VISUAL_LOCATION_LIMIT).optional(),
  limit: z.number().int().min(1).max(20).optional(),
};

/** Whole-image search. A crop is reserved for a later model generation. */
export const VisualSearchRequestSchema = z.union([
  z.strictObject({ ...scope, text: z.string().trim().min(1).max(1000) }),
  z.strictObject({ ...scope, inputId: z.uuid().toLowerCase() }),
]);
export type VisualSearchRequest = z.infer<typeof VisualSearchRequestSchema>;

export const VisualSearchCoverageSchema = z.object({
  generation: z.string().nullable(),
  ready: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative().optional(),
  encoder: z.enum(['ready', 'unavailable', 'disabled']).optional(),
  access: z.literal('denied').optional(),
});
export type VisualSearchCoverage = z.infer<typeof VisualSearchCoverageSchema>;

export const VisualSearchMatchSchema = z.object({
  thingId: z.uuid(),
  locationId: z.uuid(),
  name: z.string(),
  path: z.array(z.object({ id: z.uuid(), name: z.string() })),
  attachmentId: z.uuid(),
  fileId: z.uuid(),
  capturedAt: z.iso.datetime(),
  mime: z.string().optional(),
  isContainer: z.boolean().optional(),
  containerId: z.uuid().nullable().optional(),
  /** Cosine similarity for ranking and evaluation, not an estimated probability. */
  score: z.number().min(-1).max(1),
});
export type VisualSearchMatch = z.infer<typeof VisualSearchMatchSchema>;

export const VisualSearchResultSchema = z.object({
  outcome: z.enum(['matches', 'ambiguous', 'no_close_match', 'partial_coverage', 'unavailable']),
  coverage: VisualSearchCoverageSchema,
  matches: z.array(VisualSearchMatchSchema),
  /** Leading evidence close to the provisional minimum. Scores are not probabilities. */
  uncertain: z.literal(true).optional(),
});
export type VisualSearchResult = z.infer<typeof VisualSearchResultSchema>;

export const VisualSearchInputResponseSchema = z.object({
  inputId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type VisualSearchInputResponse = z.infer<typeof VisualSearchInputResponseSchema>;

export const VisualSearchReindexSchema = z.strictObject({
  locationId: z.uuid(),
  after: z.uuid().optional(),
});
export const VisualSearchReindexResponseSchema = z.object({
  queued: z.number().int().nonnegative(),
  next: z.uuid().optional(),
});
