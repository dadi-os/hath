-- One loop per agent: a log row and an async call no longer name a lane. The router's rows are
-- the ones with no agent. Rows the old front desk wrote are copied to a backup table and
-- removed, so a job's history holds one loop's steps. Jobs open at deploy never get an answer-by
-- notice: only jobs opened after it can.

CREATE TABLE "agent_logs_process_backup_20261114" AS
SELECT * FROM "agent_logs" WHERE "lane" = 'process';
--> statement-breakpoint
DELETE FROM "agent_logs" WHERE "lane" = 'process';
--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_lane_check";
--> statement-breakpoint
ALTER TABLE "agent_logs" DROP COLUMN "lane";
--> statement-breakpoint
ALTER TABLE "pending_async" DROP COLUMN "lane";
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "answer_noticed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "jobs" SET "answer_noticed_at" = now() WHERE "answer_by" IS NOT NULL;
