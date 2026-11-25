SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '45s';
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_description_length_chk" CHECK (char_length(description) <= 500);
--> statement-breakpoint
GRANT UPDATE (description) ON public.places TO kept_app;
