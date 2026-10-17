-- Time-series setup (spec 3.2). Runs inside the drizzle migration transaction.
-- Continuous aggregates cannot run in a transaction: see sql/post/continuous_aggregates.sql (applied by src/migrate.ts).

-- telemetry: 1-day chunks, compress after 2 days, keep raw 90 days
SELECT create_hypertable('telemetry', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);--> statement-breakpoint
ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'cabinet_id', timescaledb.compress_orderby = 'ts DESC');--> statement-breakpoint
SELECT add_compression_policy('telemetry', INTERVAL '2 days', if_not_exists => TRUE);--> statement-breakpoint
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);--> statement-breakpoint

-- frames_raw: debugging only, keep 7 days
SELECT create_hypertable('frames_raw', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);--> statement-breakpoint
SELECT add_retention_policy('frames_raw', INTERVAL '7 days', if_not_exists => TRUE);
