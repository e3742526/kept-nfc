SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "location_photo_taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_location_photo_chk" CHECK (location_photo_taken_at IS NULL OR
          (role = 'document' AND file_id IS NOT NULL AND num_nonnulls(thing_id, place_id) = 1));