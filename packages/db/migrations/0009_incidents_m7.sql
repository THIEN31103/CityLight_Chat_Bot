CREATE TABLE "incident_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"path" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "overdue_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident_photos" ADD CONSTRAINT "incident_photos_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_photos_incident_idx" ON "incident_photos" USING btree ("incident_id");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_assignee_idx" ON "incidents" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "incidents_cabinet_idx" ON "incidents" USING btree ("cabinet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_alarm_open_uq" ON "incidents" USING btree ("alarm_id") WHERE status in ('new','assigned','deferred');--> statement-breakpoint
-- incident codes SC00001… (M7); start after any code already used
CREATE SEQUENCE IF NOT EXISTS incident_code_seq;--> statement-breakpoint
SELECT setval('incident_code_seq', greatest(1, coalesce((SELECT max(substring(code from 3)::int) FROM incidents WHERE code ~ '^SC[0-9]+$'), 0) + 1), false);
