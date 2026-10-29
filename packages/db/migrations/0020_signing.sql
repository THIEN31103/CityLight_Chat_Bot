ALTER TABLE "cabinets" ADD COLUMN "uid" text;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "uid_pending" text;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "signed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "sig_boot" bigint;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "cmd_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "key_fp" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cabinets_uid_uq" ON "cabinets" USING btree ("uid");