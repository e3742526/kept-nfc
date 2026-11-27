CREATE TABLE "label_print_queue" (
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"batch_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_print_queue_pk" PRIMARY KEY("user_id","kind","record_id","location_id"),
	CONSTRAINT "label_print_queue_kind_chk" CHECK ("kind" IN ('thing', 'place'))
);
--> statement-breakpoint
ALTER TABLE "label_print_queue" ADD CONSTRAINT "label_print_queue_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_print_queue" ADD CONSTRAINT "label_print_queue_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_print_queue" ADD CONSTRAINT "label_print_queue_batch_id_label_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."label_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_print_queue_batch_idx" ON "label_print_queue" USING btree ("batch_id");
