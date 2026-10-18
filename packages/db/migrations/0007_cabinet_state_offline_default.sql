ALTER TABLE "cabinet_state" ALTER COLUMN "status" SET DEFAULT 'offline';--> statement-breakpoint
-- rows created with the old default ('unknown') for cabinets never heard from: online=false must mean offline
UPDATE "cabinet_state" SET "status" = 'offline' WHERE NOT "online" AND "status" <> 'offline';
