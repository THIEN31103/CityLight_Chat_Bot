ALTER TABLE "commands" ADD COLUMN "step" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "commands_waiting_idx" ON "commands" USING btree ("cabinet_id") WHERE deadline_at is not null;