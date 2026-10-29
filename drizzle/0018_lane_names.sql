-- The lanes are named for what they do: `reasoning` is now `work` (the job, with its
-- tools) and `conversation` is now `process` (reading what arrives and answering it).
-- Logged rows and the process lane's steering tool (`steer_reasoning` -> `steer_work`)
-- move with them, so an agent's history shows only the names it is given now.

ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_lane_check";
--> statement-breakpoint
UPDATE "agent_logs" SET "lane" = CASE "lane" WHEN 'reasoning' THEN 'work' WHEN 'conversation' THEN 'process' ELSE "lane" END WHERE "lane" IN ('reasoning', 'conversation');
--> statement-breakpoint
UPDATE "agent_logs" SET "payload" = replace("payload"::text, '"steer_reasoning"', '"steer_work"')::jsonb WHERE "payload"::text LIKE '%"steer_reasoning"%';
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_lane_check" CHECK ("agent_logs"."lane" IN ('work', 'process', 'router'));
