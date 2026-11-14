-- Routines and reminders replace scheduled messages. A routine is an agent's own standing duty
-- (an owner, a procedure, a time of day and weekdays, and no recipient); a reminder is a later
-- step of a job. The rows of `scheduled_messages` are converted by `convertScheduledMessages`
-- (src/db/convert-schedules.ts), which `migrate` runs after the SQL migrations because it needs
-- the box's time zone: it copies the table to `scheduled_messages_backup_20261114`, then drops it.

CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"procedure" text NOT NULL,
	"at_local" text NOT NULL,
	"days" text[],
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_job_id" uuid,
	"active" boolean NOT NULL,
	"set_up_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_at_local_check" CHECK ("routines"."at_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "routines_days_check" CHECK ("routines"."days" IS NULL OR (cardinality("routines"."days") >= 1 AND "routines"."days" <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]))
);
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_set_up_by_agents_id_fk" FOREIGN KEY ("set_up_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "routines_agent_title_idx" ON "routines" USING btree ("agent_id","title");
--> statement-breakpoint
CREATE INDEX "routines_next_run_at_idx" ON "routines" USING btree ("next_run_at");
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"job_id" uuid,
	"author_id" text,
	"note" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reminders_job_or_author_check" CHECK ("reminders"."job_id" IS NOT NULL OR "reminders"."author_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "reminders_run_at_idx" ON "reminders" USING btree ("run_at");
--> statement-breakpoint
CREATE INDEX "reminders_job_id_idx" ON "reminders" USING btree ("job_id");
