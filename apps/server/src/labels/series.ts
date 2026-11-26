import { parseDeviceLabel, parseScan, randomDeviceBatchId } from '@kept/shared';
import type pg from 'pg';
import { AppError } from '../http/errors.js';

// Numbered label series (`PPP-XXXX-NNNN`, @kept/shared device-labels.ts; tables in 0191).
//
// A series is made with its blank batch (`POST /labels/batches` with `kind: 'blank'` and
// `series: {prefix}`): the batch's new blank short IDs become its labels 0001…N in print order.
// The series ID is random base36 and unique across the instance with its prefix: a collision with
// any series, visible or not, inserts nothing and reveals nothing (ON CONFLICT DO NOTHING) and the
// next ID is tried, as short IDs are. Uniqueness is the database's, never a phone's.
//
// An alias is only ever a way to print and read its short ID: everything else (claiming, moving,
// retiring, printing again, the scanner) works on the short ID. A reprint of the batch, or of a
// thing or place whose label is a numbered one, prints the same alias.

/** 36⁴ ≈ 1.7 million series per prefix: sixteen misses in a row means something is broken. */
export const SERIES_TRIES = 16;

/** SQL for a code's alias, `PPP-XXXX-NNNN`, or null; `code` is a short ID column or param. */
export const aliasOfSql = (code: string) =>
  `(SELECT ls.prefix || '-' || ls.series || '-' || lpad(la.sequence::text, 4, '0')
      FROM public.label_aliases la JOIN public.label_series ls ON ls.id = la.series_id
     WHERE la.code = ${code})`;

/**
 * Registers `codes` (new blank short IDs of `locationId`, in print order) as series `prefix` on
 * `batchId`, on the request's transaction. Returns the series ID (`A09Z`).
 */
export async function reserveSeries(
  client: pg.ClientBase,
  locationId: string,
  prefix: string,
  batchId: string,
  codes: readonly string[],
  exact?: { id: string; origin: string },
  generate: () => string = randomDeviceBatchId,
): Promise<string> {
  for (let i = 0; i < (exact ? 1 : SERIES_TRIES); i++) {
    const { rows } = await client.query<{ id: string; series: string }>(
      `INSERT INTO public.label_series (location_id, prefix, series, batch_id, label_count,
                                        created_by, guarded, label_origin)
       VALUES ($1, $2, $3, $4, $5, kept.current_user_id(), $6, $7)
       ON CONFLICT (prefix, series) DO NOTHING
       RETURNING id, series::text AS series`,
      [
        locationId,
        prefix,
        exact?.id ?? generate(),
        batchId,
        codes.length,
        !!exact,
        exact?.origin ?? null,
      ],
    );
    const row = rows[0];
    if (!row) continue;
    await client.query(
      `INSERT INTO public.label_aliases (code, location_id, series_id, sequence)
       SELECT c, $2, $3, n::int FROM unnest($1::text[]) WITH ORDINALITY u(c, n)`,
      [codes, locationId, row.id],
    );
    return row.series;
  }
  if (exact)
    throw new AppError('label_series_collision', 409, 'This label series is already reserved.');
  throw new Error(`no free label series after ${SERIES_TRIES} tries`);
}

/**
 * The short ID a numbered label stands for, when the caller can see its location (row-level
 * security decides); null for a malformed alias, an unknown one and another household's alike.
 * An equality on label_series' (prefix, series) key and label_aliases' (series_id, sequence) key.
 */
export async function codeOfAlias(
  client: pg.ClientBase,
  alias: string,
  guard?: string,
): Promise<string | null> {
  const parsed = parseDeviceLabel(alias);
  if (!parsed) return null;
  const { rows } = await client.query<{ code: string }>(
    `SELECT la.code::text AS code
       FROM public.label_series ls
       JOIN public.label_aliases la ON la.series_id = ls.id AND la.sequence = $3
      WHERE ls.prefix = $1 AND ls.series = $2
        AND ($4::text IS NULL OR (ls.guarded AND right(ls.batch_id::text, 12) = $4))`,
    [parsed.prefix, parsed.batchId, parsed.sequence, guard ?? null],
  );
  return rows[0]?.code ?? null;
}

/** A typed or scanned label reference, resolved through the existing short-ID registry. */
export async function shortId(client: pg.ClientBase, text: string): Promise<string | null> {
  const scan = parseScan(text);
  if (scan.kind === 'kept') return scan.code;
  if (scan.kind === 'alias') return codeOfAlias(client, scan.alias, scan.guard);
  return null;
}
