ALTER TYPE "public"."batch_kind" ADD VALUE 'control';--> statement-breakpoint
ALTER TABLE "command_batches" ADD COLUMN "command_type" text;--> statement-breakpoint
ALTER TABLE "command_batches" ADD COLUMN "params" jsonb;