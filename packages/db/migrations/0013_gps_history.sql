ALTER TABLE "telemetry" ADD COLUMN "gps_lat" double precision;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "gps_lng" double precision;--> statement-breakpoint
ALTER TABLE "unknown_devices" ADD COLUMN "gps" geometry(point, 4326);