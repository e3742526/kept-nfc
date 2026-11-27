import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';
import { shortIds } from './things.js';

// Label batches (D44, D97, D137, D175, D185). One print job: which codes, on
// which stock, from which cell. Row-level security, the blank-label cap, blank claims and
// duplicate merges are in the custom migration that follows (0042); see src/db/labels.test.ts
// and src/db/merge-things.test.ts.

export const LABEL_BATCH_KINDS = ['things', 'places', 'blank'] as const;
const batchKind = textEnum('kind', LABEL_BATCH_KINDS);

export const labelBatches = pgTable(
  'label_batches',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: batchKind.col().notNull(),
    /** A `LABEL_STOCKS` key (@kept/shared label-stocks.ts). */
    stock: text('stock').notNull(),
    startCell: integer('start_cell').notNull().default(1),
    codeCount: integer('code_count').notNull(),
    thermal: jsonb('thermal'),
    templateKey: text('template_key'),
    createdBy: uuid('created_by').notNull(),
    /** "Printed OK?" answered yes. */
    printedConfirmedAt: tstz('printed_confirmed_at'),
    /** Set aside from the labels screen without printing it ("Not printed"); a later "Printed
     * OK?" clears it. */
    dismissedAt: tstz('dismissed_at'),
    ...mutable(),
  },
  (t) => [
    batchKind.check('label_batches'),
    unique('label_batches_location_id_uq').on(t.locationId, t.id),
    check('label_batches_stock_chk', sql`stock ~ '^[a-z0-9_]{1,40}$'`),
    check('label_batches_start_cell_chk', sql`start_cell BETWEEN 1 AND 200`),
    check('label_batches_code_count_chk', sql`code_count BETWEEN 1 AND 1000`),
    index('label_batches_location_idx').on(t.locationId, t.createdAt),
  ],
);

/** The codes of a batch, in print order. Short IDs are never deleted, so neither side cascades
 * from the code. Never updated. */
export const labelBatchCodes = pgTable(
  'label_batch_codes',
  {
    batchId: uuid('batch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    code: char('code', { length: 6 })
      .notNull()
      .references(() => shortIds.code, { onDelete: 'no action' }),
    sort: integer('sort').notNull(),
  },
  (t) => [
    primaryKey({ name: 'label_batch_codes_pk', columns: [t.batchId, t.code] }),
    foreignKey({
      name: 'label_batch_codes_batch_fk',
      columns: [t.locationId, t.batchId],
      foreignColumns: [labelBatches.locationId, labelBatches.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('label_batch_codes_code_idx').on(t.code),
  ],
);

const queueKind = textEnum('kind', ['thing', 'place'] as const);

export const labelPrintQueue = pgTable(
  'label_print_queue',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: queueKind.col().notNull(),
    recordId: uuid('record_id').notNull(),
    batchId: uuid('batch_id').references(() => labelBatches.id, { onDelete: 'set null' }),
    queuedAt: tstz('queued_at').notNull().defaultNow(),
  },
  (t) => [
    queueKind.check('label_print_queue'),
    primaryKey({
      name: 'label_print_queue_pk',
      columns: [t.userId, t.kind, t.recordId, t.locationId],
    }),
    index('label_print_queue_batch_idx').on(t.batchId),
  ],
);

// Numbered label series (`PPP-XXXX-NNNN`, @kept/shared device-labels.ts). A series is a blank
// batch whose labels print an alias instead of their short ID: each alias stands for exactly one
// short ID for good, so a numbered label is claimed, moved, retired and reprinted as its short ID
// is. The physical label's identity is the short ID; the alias is how it is printed and read.
// Like short IDs, series and aliases are never updated, deleted or reissued: no foreign key to
// locations, so they outlive a purged location as tombstones its printed labels can't be
// mistaken for. Row-level security and grants are in the custom migration that follows.

/** One numbered series: its purpose prefix and random base36 series ID, unique across the
 * instance, and the blank batch that first printed it (gone with its location; the series
 * stays). */
export const labelSeries = pgTable(
  'label_series',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    prefix: char('prefix', { length: 3 }).notNull(),
    series: char('series', { length: 4 }).notNull(),
    batchId: uuid('batch_id'),
    guarded: boolean('guarded').notNull().default(false),
    labelOrigin: text('label_origin'),
    labelCount: integer('label_count').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('label_series_prefix_series_uq').on(t.prefix, t.series),
    unique('label_series_location_id_uq').on(t.locationId, t.id),
    check('label_series_prefix_chk', sql`prefix ~ '^[A-Z]{3}$'`),
    check('label_series_series_chk', sql`series ~ '^[0-9A-Z]{4}$'`),
    check('label_series_count_chk', sql`label_count BETWEEN 1 AND 9999`),
    index('label_series_batch_idx').on(t.batchId),
  ],
);

/** A numbered label: its place in its series, and the short ID it stands for (one alias per
 * short ID, in the series' location). */
export const labelAliases = pgTable(
  'label_aliases',
  {
    code: char('code', { length: 6 })
      .primaryKey()
      .references(() => shortIds.code, { onDelete: 'no action' }),
    locationId: uuid('location_id').notNull(),
    seriesId: uuid('series_id').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('label_aliases_series_sequence_uq').on(t.seriesId, t.sequence),
    check('label_aliases_sequence_chk', sql`sequence BETWEEN 1 AND 9999`),
    foreignKey({
      name: 'label_aliases_series_fk',
      columns: [t.locationId, t.seriesId],
      foreignColumns: [labelSeries.locationId, labelSeries.id],
    }),
    index('label_aliases_location_idx').on(t.locationId),
  ],
);
