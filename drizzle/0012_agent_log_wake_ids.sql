-- Wake ids on agent logs: every row a wake writes (its lanes' turns and tool results,
-- the messages it received and sent) carries the wake's id, so the activity feed groups
-- a wake by what hath ran instead of guessing from gaps between rows.

ALTER TABLE "agent_logs" ADD COLUMN "wake_id" uuid;
--> statement-breakpoint
CREATE INDEX "agent_logs_wake_id_idx" ON "agent_logs" USING btree ("wake_id");
