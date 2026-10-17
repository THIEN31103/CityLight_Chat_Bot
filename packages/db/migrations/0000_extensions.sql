-- Extensions must exist before tables that use geometry / hypertables.
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;
