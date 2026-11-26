ALTER TABLE "label_batches" ADD COLUMN "thermal" jsonb;--> statement-breakpoint
ALTER TABLE "label_series" ADD COLUMN "guarded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "label_series" ADD COLUMN "label_origin" text;