-- Jobs as first-class objects, and the activity record. A job gains the routine whose firing
-- opened it, Ankur's answer-by time and who stopped it, and its requester may be the agent
-- itself (a routine run: nobody asked). Every message and every log row carries the job it
-- belongs to, `agent_activity` records what each agent did (written by hath from tool results),
-- and `helper_steers` remembers the job each helper task was steered in, so a report joins it.
-- A progress line is no longer a status: `running` is gone from messages (rows that carried it
-- lose the status; hath's own pickups among them are marked `sent_by = 'hath'` first).

ALTER TABLE "jobs" ADD COLUMN "routine_id" uuid;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "answer_by" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stopped_by" text;
--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "progress_seq";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_state_check";
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" IN ('open', 'needs_input', 'done', 'blocked', 'noop', 'stopped'));
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_stopped_check" CHECK (("jobs"."state" = 'stopped') = ("jobs"."stopped_at" IS NOT NULL));
--> statement-breakpoint
DROP INDEX "jobs_open_line_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_open_line_idx" ON "jobs" USING btree ("requester_id", "agent_id") NULLS NOT DISTINCT WHERE "state" IN ('open', 'needs_input') AND "requester_id" IS DISTINCT FROM "agent_id";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_by" text;
--> statement-breakpoint
UPDATE "messages" SET "sent_by" = 'hath' WHERE "status" = 'running' AND "content" = 'Working on it.' AND "from_agent_id" IS NOT NULL AND "to_agent_id" IS NULL;
--> statement-breakpoint
UPDATE "messages" SET "status" = NULL WHERE "status" = 'running';
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_status_check";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_check" CHECK ("messages"."status" IS NULL OR "messages"."status" IN ('needs_input', 'blocked', 'done'));
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_check" CHECK ("messages"."sent_by" IS NULL OR "messages"."sent_by" = 'hath');
--> statement-breakpoint
CREATE INDEX "messages_job_id_idx" ON "messages" USING btree ("job_id");
--> statement-breakpoint
ALTER TABLE "agent_logs" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
CREATE INDEX "agent_logs_job_id_idx" ON "agent_logs" USING btree ("job_id");
--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
CREATE TABLE "agent_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"job_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "agent_activity_kind_check" CHECK ("agent_activity"."kind" IN ('site_read', 'store', 'recall_digest', 'send', 'routine', 'reminder', 'stop'))
);
--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_activity_agent_id_at_idx" ON "agent_activity" USING btree ("agent_id","at");
--> statement-breakpoint
CREATE INDEX "agent_activity_job_id_idx" ON "agent_activity" USING btree ("job_id");
--> statement-breakpoint
CREATE TABLE "helper_steers" (
	"task" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"job_id" uuid,
	"message" text NOT NULL,
	"steered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helper_steers" ADD CONSTRAINT "helper_steers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
