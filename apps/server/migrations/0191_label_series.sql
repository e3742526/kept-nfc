SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "label_aliases" (
	"code" char(6) PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_aliases_series_sequence_uq" UNIQUE("series_id","sequence"),
	CONSTRAINT "label_aliases_sequence_chk" CHECK (sequence BETWEEN 1 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "label_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"prefix" char(3) NOT NULL,
	"series" char(4) NOT NULL,
	"batch_id" uuid,
	"label_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_series_prefix_series_uq" UNIQUE("prefix","series"),
	CONSTRAINT "label_series_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "label_series_prefix_chk" CHECK (prefix ~ '^[A-Z]{3}$'),
	CONSTRAINT "label_series_series_chk" CHECK (series ~ '^[0-9A-Z]{4}$'),
	CONSTRAINT "label_series_count_chk" CHECK (label_count BETWEEN 1 AND 9999)
);
--> statement-breakpoint
ALTER TABLE "label_aliases" ADD CONSTRAINT "label_aliases_code_short_ids_code_fk" FOREIGN KEY ("code") REFERENCES "public"."short_ids"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_aliases" ADD CONSTRAINT "label_aliases_series_fk" FOREIGN KEY ("location_id","series_id") REFERENCES "public"."label_series"("location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_aliases_location_idx" ON "label_aliases" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "label_series_batch_idx" ON "label_series" USING btree ("batch_id");
--> statement-breakpoint
-- Numbered label series (`PPP-XXXX-NNNN`). Above, drizzle's part: label_series and label_aliases
-- (src/db/schema/labels.ts). A series is reserved by the server when its blank batch is made
-- (labels/series.ts): its prefix and random base36 series ID are unique across the instance (a
-- collision with another household's series inserts nothing and reveals nothing, ON CONFLICT DO
-- NOTHING, and the next ID is tried), and each alias stands for one blank short ID of the same
-- location. Like short IDs, neither is ever updated, deleted or reissued: no foreign key to
-- locations, so a purged location's series stay as tombstones nobody can read, and its printed
-- labels never resolve to someone else's.
-- Row-level security as label_batches (0042): read by whoever sees the location, made by its
-- writers (`labels.use`), an alias only for a blank short ID of its own location, so the foreign
-- key can't probe another household's codes. Additive: the release before ignores both tables.
-- test/leak-capture.ts fills them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['label_series', 'label_aliases'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY app_select ON public.label_series FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.label_series FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND (batch_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.label_batches b
                               WHERE b.id = label_series.batch_id
                                 AND b.location_id = label_series.location_id
                                 AND b.kind = 'blank')));
--> statement-breakpoint
CREATE POLICY app_select ON public.label_aliases FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.label_aliases FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND EXISTS (SELECT 1 FROM public.short_ids s
                           WHERE s.code = label_aliases.code
                             AND s.location_id = label_aliases.location_id
                             AND s.state = 'blank'));
