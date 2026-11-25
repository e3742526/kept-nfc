import type { VisualSearchCoverage, VisualSearchMatch } from '@kept/shared';
import type pg from 'pg';
import { vectorLiteral } from '../embeddings/provider.js';
import { placeEvidenceForPaths } from '../places/reference-evidence.js';
import { isContainerSql } from '../search/query.js';
import type { FileStorage } from '../storage/blob-store.js';

const DIMENSIONS = 512;

export function validVector(vector: readonly number[]): boolean {
  return (
    vector.length === DIMENSIONS &&
    vector.every((value) => Number.isFinite(value) && Math.abs(value) <= 1.01) &&
    vector.some((value) => value !== 0)
  );
}

export async function visualLocations(
  client: pg.ClientBase,
  requested: string[] | undefined,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM kept.visual_locations($1) AS l(id) ORDER BY id',
    [requested ?? null],
  );
  return rows.map(({ id }) => id);
}

export const EMPTY_COVERAGE: VisualSearchCoverage = {
  generation: null,
  ready: 0,
  pending: 0,
  failed: 0,
  paused: 0,
};

export async function visualCoverage(
  client: pg.ClientBase,
  generation: string,
  ids: string[],
): Promise<VisualSearchCoverage> {
  const { rows } = await client.query<
    Pick<VisualSearchCoverage, 'ready' | 'pending' | 'failed' | 'unsupported'>
  >(
    `SELECT c.*, (SELECT count(*)::int FROM kept.visual_photo_sources($1, NULL) s
                    WHERE NOT s.use_original AND s.display_key IS NULL) AS unsupported
       FROM kept.visual_coverage($1, $2) c`,
    [ids, generation],
  );
  return { ...EMPTY_COVERAGE, generation, ...rows[0] };
}

export async function visualMatches(
  client: pg.ClientBase,
  generation: string,
  ids: string[],
  vector: number[],
  minScore: number,
  limit: number,
  ambiguityMargin: number,
  files: FileStorage | null,
): Promise<{ matches: VisualSearchMatch[]; ambiguous: boolean }> {
  const { rows } = await client.query<
    Omit<VisualSearchMatch, 'capturedAt' | 'path'> & {
      capturedAt: Date;
      is_alternate: boolean;
      path: (VisualSearchMatch['path'][number] & { kind?: 'place' | 'container' })[];
    }
  >(
    `SELECT t.id AS "thingId", l.id AS "locationId", t.name,
            jsonb_build_array(jsonb_build_object('id', l.id, 'name', l.name)) ||
            coalesce((SELECT jsonb_agg(p.entry ORDER BY p.ordinal)
                       FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                            WITH ORDINALITY AS p(entry, ordinal)
                      WHERE p.entry->>'name' IS NOT NULL), '[]'::jsonb) AS path,
            r.attachment_id AS "attachmentId", f.id AS "fileId", r.captured_at AS "capturedAt",
            f.mime, t.container_id AS "containerId",
            ${isContainerSql('t.id', 't.type_id')} AS "isContainer", r.score, r.is_alternate
       FROM kept.visual_matches($1, $2, $3, $4, $5, $6) r
       JOIN public.things t ON t.id = r.thing_id AND t.location_id = r.location_id
       JOIN public.locations l ON l.id = t.location_id
       JOIN public.attachments a ON a.id = r.attachment_id AND a.thing_id = t.id
       JOIN public.files f ON f.id = r.file_id AND f.id = a.file_id
      WHERE t.deleted_at IS NULL AND t.review_state <> 'draft' AND NOT a.in_review
      ORDER BY r.score DESC, r.attachment_id`,
    [ids, generation, vectorLiteral(vector), minScore, limit, ambiguityMargin],
  );
  const evidence = await placeEvidenceForPaths(
    client,
    files,
    rows.map(({ path }) => path.filter((step) => step.kind === 'place').map(({ id }) => id)),
  );
  return {
    matches: rows.map(({ is_alternate: _alternate, capturedAt, ...match }, index) => ({
      ...match,
      capturedAt: capturedAt.toISOString(),
      ...(evidence[index] ? { placeEvidence: evidence[index] } : {}),
    })),
    ambiguous: rows.some(({ is_alternate }) => is_alternate),
  };
}

export type VisualSource = {
  attachment_id: string;
  location_id: string;
  file_id: string;
  content_hash: string;
  storage_key: string;
  bytes: string;
  display_key: string | null;
  display_bytes: string | null;
  ready: boolean;
};

export async function visualSource(
  client: pg.ClientBase,
  attachmentId: string,
  generation: string,
) {
  const { rows } = await client.query<VisualSource>(
    `SELECT s.attachment_id, s.location_id, s.file_id, s.content_hash, s.storage_key, s.bytes,
            CASE WHEN NOT s.use_original THEN s.display_key END AS display_key,
            CASE WHEN NOT s.use_original THEN s.display_bytes END AS display_bytes,
            kept.visual_current(s.attachment_id, s.location_id, s.file_id, s.content_hash, $2) AS ready
       FROM kept.visual_photo_sources(ARRAY(SELECT kept.writable_location_ids()), $1) s
      WHERE s.use_original OR s.display_key IS NOT NULL`,
    [attachmentId, generation],
  );
  return rows[0];
}

export async function storeVisualVector(
  client: pg.ClientBase,
  source: VisualSource,
  generation: string,
  vector: number[] | null,
): Promise<boolean> {
  const { rows } = await client.query<{ stored: boolean }>(
    'SELECT kept.visual_store($1, $2, $3, $4, $5, $6, $7) AS stored',
    [
      source.attachment_id,
      source.location_id,
      source.file_id,
      source.content_hash,
      generation,
      vector ? vectorLiteral(vector) : null,
      source.display_key,
    ],
  );
  return rows[0]?.stored === true;
}

export async function pendingVisualAttachments(
  client: pg.ClientBase,
  locationId: string,
  generation: string,
  after?: string,
): Promise<{ attachments: string[]; next?: string }> {
  const batchLimit = 100;
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM kept.visual_backlog($1, $2, $3, $4) AS b(id)',
    [locationId, generation, batchLimit + 1, after ?? null],
  );
  const attachments = rows.slice(0, batchLimit).map(({ id }) => id);
  return { attachments, next: rows.length > batchLimit ? attachments.at(-1) : undefined };
}
