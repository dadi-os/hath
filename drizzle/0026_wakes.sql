-- One fact, one home: speech lives in `messages`, activity in `agent_logs`, and a stretch of
-- work is a `wakes` row. The `message` log rows duplicated `messages` and are removed after
-- their facts move: wakes and messages.wake_id come from them, router utterances become
-- `messages` rows of kind `utterance`. The deleted rows are kept in a backup table.

CREATE TABLE "agent_logs_message_backup_20261108" AS
SELECT * FROM "agent_logs" WHERE "event" = 'message';
--> statement-breakpoint
CREATE TABLE "wakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"reason_kind" text NOT NULL,
	"reason_ref" text,
	"opened_by_message_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "wakes_reason_kind_check" CHECK ("wakes"."reason_kind" IN ('message', 'schedule', 'recovery', 'steer', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "wakes_agent_id_started_at_idx" ON "wakes" USING btree ("agent_id","started_at" DESC NULLS LAST,"id");
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "wake_id" uuid;
--> statement-breakpoint
CREATE INDEX "messages_wake_id_idx" ON "messages" USING btree ("wake_id");
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_kind_check";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('message', 'notice', 'utterance'));
--> statement-breakpoint
INSERT INTO "wakes" ("id", "agent_id", "reason_kind", "reason_ref", "opened_by_message_id", "started_at", "ended_at")
SELECT
	w."wake_id",
	w."agent_id",
	CASE WHEN o."schedule_id" IS NOT NULL THEN 'schedule' WHEN o."message_id" IS NOT NULL THEN 'message' ELSE 'manual' END,
	CASE WHEN o."schedule_id" IS NOT NULL THEN o."schedule_id" WHEN o."message_id" IS NOT NULL THEN o."sender" END,
	o."message_id",
	w."started_at",
	w."ended_at"
FROM (
	SELECT "wake_id", min("agent_id") AS "agent_id", min("created_at") AS "started_at", max("created_at") AS "ended_at"
	FROM "agent_logs"
	WHERE "wake_id" IS NOT NULL AND "agent_id" IS NOT NULL
	GROUP BY "wake_id"
) w
LEFT JOIN LATERAL (
	SELECT ("payload"->>'message_id')::uuid AS "message_id", "payload"->>'from_agent_id' AS "sender", "payload"->>'schedule_id' AS "schedule_id"
	FROM "agent_logs" l
	WHERE l."wake_id" = w."wake_id" AND l."event" = 'message' AND l."payload"->>'direction' = 'receive'
	ORDER BY l."created_at", l."id"
	LIMIT 1
) o ON true;
--> statement-breakpoint
UPDATE "messages" m
SET "wake_id" = l."wake_id"
FROM "agent_logs" l
WHERE l."event" = 'message'
	AND l."payload"->>'direction' = 'receive'
	AND l."wake_id" IS NOT NULL
	AND (l."payload"->>'message_id')::uuid = m."id";
--> statement-breakpoint
INSERT INTO "messages" ("id", "from_agent_id", "to_agent_id", "content", "kind", "created_at")
SELECT gen_random_uuid(), NULL, NULL, "payload"->>'content', 'utterance', "created_at"
FROM "agent_logs"
WHERE "lane" = 'router'
	AND "event" = 'message'
	AND "payload"->>'direction' = 'receive'
	AND "payload"->>'message_id' IS NULL
	AND "payload"->>'from_agent_id' IS NULL
	AND "payload"->>'to_agent_id' IS NULL
ORDER BY "created_at", "id";
--> statement-breakpoint
DELETE FROM "agent_logs" WHERE "event" = 'message';
--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT "agent_logs_event_check";
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_event_check" CHECK ("agent_logs"."event" IN ('response', 'tool_result'));
