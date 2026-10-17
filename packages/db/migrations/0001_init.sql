CREATE TYPE "public"."batch_kind" AS ENUM('schedule', 'dimming', 'time');--> statement-breakpoint
CREATE TYPE "public"."batch_result" AS ENUM('pending', 'ok', 'failed', 'offline');--> statement-breakpoint
CREATE TYPE "public"."cabinet_status" AS ENUM('offline', 'fault', 'dimming', 'on', 'off', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('queued', 'sent', 'acked', 'confirmed', 'acked_unconfirmed', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fw_profile" AS ENUM('v2-1307ebc', 'v2-current', 'v3');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('new', 'assigned', 'deferred', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'operator', 'viewer', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'major', 'minor');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_email" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_name" text,
	"old_value" text,
	"new_value" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "alarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"severity" "severity" NOT NULL,
	"message" text NOT NULL,
	"value" double precision,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"acked_by" uuid,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cabinet_state" (
	"cabinet_id" uuid PRIMARY KEY NOT NULL,
	"status" "cabinet_status" DEFAULT 'unknown' NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_boot_at" timestamp with time zone,
	"bus_status" text,
	"branch1_on" boolean,
	"branch2_on" boolean,
	"manual_mode" boolean,
	"plc_online" boolean,
	"pm_online" boolean,
	"v_l1" real,
	"v_l2" real,
	"v_l3" real,
	"i_l1" real,
	"i_l2" real,
	"i_l3" real,
	"pf_total" real,
	"p_total_kw" real,
	"leak_ma" real,
	"temp_c" real,
	"temp_sensor_fault" boolean DEFAULT false NOT NULL,
	"battery_mv" integer,
	"gps_device" geometry(point, 4326),
	"gps_sats" smallint,
	"device_time" timestamp with time zone,
	"device_time_changed_at" timestamp with time zone,
	"door_open" boolean,
	"contactor_fault" boolean,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_alarm_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cabinets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ltid" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"street" text,
	"ward_id" uuid,
	"district_id" uuid,
	"management_unit_id" uuid,
	"zone1_id" uuid,
	"zone2_id" uuid,
	"location" geometry(point, 4326) NOT NULL,
	"fw_profile" "fw_profile" DEFAULT 'v2-current' NOT NULL,
	"imei" text,
	"sim_iccid" text,
	"photo_url" text,
	"installed_at" timestamp with time zone,
	"status_override" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_batch_items" (
	"batch_id" uuid NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"command_id" uuid,
	"result" "batch_result" DEFAULT 'pending' NOT NULL,
	"error" text,
	CONSTRAINT "command_batch_items_batch_id_cabinet_id_pk" PRIMARY KEY("batch_id","cabinet_id")
);
--> statement-breakpoint
CREATE TABLE "command_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "batch_kind" NOT NULL,
	"scope" text NOT NULL,
	"total" integer NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frame" text NOT NULL,
	"batch_id" uuid,
	"idempotency_key" text,
	"status" "command_status" DEFAULT 'queued' NOT NULL,
	"ack_rc" jsonb,
	"requested_by" uuid NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_field_map" (
	"key" text PRIMARY KEY NOT NULL,
	"field" text NOT NULL,
	"type" text NOT NULL,
	"scale" double precision,
	"unit" text,
	"note" text,
	"supported" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimming_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lamp_group" smallint NOT NULL,
	"zone_id" uuid,
	"cabinet_id" uuid,
	"segments" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frames_raw" (
	"ts" timestamp with time zone NOT NULL,
	"topic" text NOT NULL,
	"ltid" text,
	"payload" text NOT NULL,
	"parse_error" text
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" text NOT NULL,
	"action" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"cabinet_id" uuid,
	"alarm_id" uuid,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"location" geometry(point, 4326),
	"reported_by" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "incident_status" DEFAULT 'new' NOT NULL,
	"assignee" text,
	"deadline" timestamp with time zone,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lamps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pole_id" uuid NOT NULL,
	"code" text NOT NULL,
	"lamp_group" smallint DEFAULT 0 NOT NULL,
	"rated_power_w" integer,
	"is_smart" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "management_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"min_severity" "severity" DEFAULT 'major' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"code" text NOT NULL,
	"legacy_code" text,
	"location" geometry(point, 4326) NOT NULL,
	"lamp_count" smallint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"code" text NOT NULL,
	"branch" smallint NOT NULL,
	"path" geometry(point, 4326)
);
--> statement-breakpoint
CREATE TABLE "schedule_applied" (
	"cabinet_id" uuid PRIMARY KEY NOT NULL,
	"values" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"command_id" uuid
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid,
	"cabinet_id" uuid,
	"mode" smallint DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"on1" text NOT NULL,
	"off1" text NOT NULL,
	"on2" text,
	"off2" text,
	"branch1_enabled" boolean DEFAULT true NOT NULL,
	"branch2_enabled" boolean DEFAULT true NOT NULL,
	"offset_on_min" integer DEFAULT 10 NOT NULL,
	"offset_off_min" integer DEFAULT -10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"ts" timestamp with time zone NOT NULL,
	"cabinet_id" uuid NOT NULL,
	"online" boolean,
	"bus_status" text,
	"branch1_on" boolean,
	"branch2_on" boolean,
	"manual_mode" boolean,
	"v_l1" real,
	"v_l2" real,
	"v_l3" real,
	"i_l1" real,
	"i_l2" real,
	"i_l3" real,
	"pf_l1" real,
	"pf_l2" real,
	"pf_l3" real,
	"pf_total" real,
	"p_total_kw" real,
	"leak_ma" real,
	"temp_c" real,
	"battery_mv" integer,
	"extra" jsonb,
	CONSTRAINT "telemetry_cabinet_id_ts_pk" PRIMARY KEY("cabinet_id","ts")
);
--> statement-breakpoint
CREATE TABLE "thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid,
	"cabinet_id" uuid,
	"values" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unknown_devices" (
	"ltid" text PRIMARY KEY NOT NULL,
	"imei" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frames" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_scopes" (
	"user_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	CONSTRAINT "user_scopes_user_id_area_id_pk" PRIMARY KEY("user_id","area_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'viewer' NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"center" geometry(point, 4326) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinet_state" ADD CONSTRAINT "cabinet_state_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_ward_id_areas_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_district_id_areas_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_management_unit_id_management_units_id_fk" FOREIGN KEY ("management_unit_id") REFERENCES "public"."management_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_zone1_id_zones_id_fk" FOREIGN KEY ("zone1_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinets" ADD CONSTRAINT "cabinets_zone2_id_zones_id_fk" FOREIGN KEY ("zone2_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_batch_items" ADD CONSTRAINT "command_batch_items_batch_id_command_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."command_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_batch_items" ADD CONSTRAINT "command_batch_items_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_batch_items" ADD CONSTRAINT "command_batch_items_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_batch_id_command_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."command_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimming_profiles" ADD CONSTRAINT "dimming_profiles_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimming_profiles" ADD CONSTRAINT "dimming_profiles_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_alarm_id_alarms_id_fk" FOREIGN KEY ("alarm_id") REFERENCES "public"."alarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lamps" ADD CONSTRAINT "lamps_pole_id_poles_id_fk" FOREIGN KEY ("pole_id") REFERENCES "public"."poles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_units" ADD CONSTRAINT "management_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_applied" ADD CONSTRAINT "schedule_applied_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thresholds" ADD CONSTRAINT "thresholds_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thresholds" ADD CONSTRAINT "thresholds_cabinet_id_cabinets_id_fk" FOREIGN KEY ("cabinet_id") REFERENCES "public"."cabinets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_logs_ts_idx" ON "activity_logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "activity_logs_user_idx" ON "activity_logs" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "alarms_active_idx" ON "alarms" USING btree ("active","severity");--> statement-breakpoint
CREATE INDEX "alarms_cabinet_idx" ON "alarms" USING btree ("cabinet_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alarms_one_active_uq" ON "alarms" USING btree ("cabinet_id","type") WHERE active;--> statement-breakpoint
CREATE INDEX "areas_parent_idx" ON "areas" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cabinets_ltid_uq" ON "cabinets" USING btree ("ltid");--> statement-breakpoint
CREATE INDEX "cabinets_location_gix" ON "cabinets" USING gist ("location");--> statement-breakpoint
CREATE INDEX "cabinets_district_idx" ON "cabinets" USING btree ("district_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commands_idem_uq" ON "commands" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "commands_cabinet_idx" ON "commands" USING btree ("cabinet_id","queued_at");--> statement-breakpoint
CREATE INDEX "commands_open_idx" ON "commands" USING btree ("status") WHERE status in ('queued','sent','acked');--> statement-breakpoint
CREATE INDEX "device_events_cabinet_idx" ON "device_events" USING btree ("cabinet_id","ts");--> statement-breakpoint
CREATE INDEX "frames_raw_ltid_ts_idx" ON "frames_raw" USING btree ("ltid","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_code_uq" ON "incidents" USING btree ("code");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status","reported_at");--> statement-breakpoint
CREATE INDEX "poles_location_gix" ON "poles" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_zone_uq" ON "schedules" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_cabinet_uq" ON "schedules" USING btree ("cabinet_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));