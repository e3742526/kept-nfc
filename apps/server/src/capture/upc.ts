import { productCodeForms } from '@kept/shared';
import type pg from 'pg';
import { AppError } from '../http/errors.js';

export class UpcCaptureConflict extends AppError {
  constructor(readonly matches: readonly { id: string; locationId: string }[]) {
    super('conflict', 409, 'An inventory item already has this UPC.', {
      candidates: matches,
    });
  }
}

/** Serialize equivalent UPC spellings across captures in the same inventory account. */
export async function checkCaptureUpc(client: pg.ClientBase, locationId: string, barcode: string) {
  const forms = productCodeForms(barcode);
  const canonical = forms.find((value) => value.length === 12);
  if (!canonical || forms.length < 2) return;
  const { rows: locations } = await client.query<{ account: string }>(
    'SELECT owner_account_id AS account FROM public.locations WHERE id = $1',
    [locationId],
  );
  const account = locations[0]?.account;
  if (!account) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('kept.capture.upc'), hashtext($1))", [
    `${account}:${canonical}`,
  ]);
  const { rows } = await client.query<{ id: string; locationId: string }>(
    `SELECT t.id, t.location_id AS "locationId"
       FROM public.things t JOIN public.locations l ON l.id = t.location_id
      WHERE l.owner_account_id = $1 AND t.barcode = ANY($2::text[]) AND t.deleted_at IS NULL
      ORDER BY t.id LIMIT 50`,
    [account, forms],
  );
  if (rows.length) throw new UpcCaptureConflict(rows);
}
