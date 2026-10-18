ALTER TABLE "dimming_profiles" DROP CONSTRAINT "dimming_profiles_zone_id_zones_id_fk";
--> statement-breakpoint
ALTER TABLE "dimming_profiles" ADD CONSTRAINT "dimming_profiles_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dimming_cabinet_uq" ON "dimming_profiles" USING btree ("cabinet_id","lamp_group") WHERE cabinet_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "dimming_zone_uq" ON "dimming_profiles" USING btree ("zone_id","lamp_group") WHERE cabinet_id is null and zone_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "dimming_system_uq" ON "dimming_profiles" USING btree ("lamp_group") WHERE cabinet_id is null and zone_id is null;