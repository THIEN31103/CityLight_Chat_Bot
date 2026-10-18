CREATE UNIQUE INDEX "notification_subscriptions_user_channel_uq" ON "notification_subscriptions" USING btree ("user_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "thresholds_cabinet_uq" ON "thresholds" USING btree ("cabinet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thresholds_zone_uq" ON "thresholds" USING btree ("zone_id");