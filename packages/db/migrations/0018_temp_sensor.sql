ALTER TABLE "cabinets" ADD COLUMN "has_temp_sensor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- S54: no cabinet has a DS18B20 fitted yet: close the temperature alarms raised so far (ingest reloads them on start)
UPDATE "alarms" SET "active" = false, "ended_at" = now() WHERE "active" AND "type" IN ('temp_sensor_fault', 'over_temp');
