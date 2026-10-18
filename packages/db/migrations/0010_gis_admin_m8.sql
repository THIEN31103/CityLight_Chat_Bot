CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "decommissioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cabinets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "poles" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poles" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cabinets_code_uq" ON "cabinets" USING btree ("code");--> statement-breakpoint
CREATE INDEX "lamps_pole_idx" ON "lamps" USING btree ("pole_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poles_code_uq" ON "poles" USING btree ("code");--> statement-breakpoint
CREATE INDEX "poles_route_idx" ON "poles" USING btree ("route_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_cabinet_branch_uq" ON "routes" USING btree ("cabinet_id","branch");--> statement-breakpoint
CREATE INDEX "routes_path_gix" ON "routes" USING gist ("path");