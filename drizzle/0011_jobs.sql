-- Jobs: the open work on each requester → agent line, and the status an
-- agent reports it with, so hath can hold every agent to the same report gates.

ALTER TABLE "messages" ADD COLUMN "status" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_status_check" CHECK ("status" IS NULL OR "status" IN ('running', 'needs_input', 'blocked', 'done'));
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requester_id" text,
	"agent_id" text NOT NULL,
	"state" text NOT NULL,
	"opened_seq" bigint NOT NULL,
	"progress_seq" bigint,
	"question_seq" bigint,
	"closed_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_state_check" CHECK ("state" IN ('open', 'needs_input', 'done', 'blocked', 'noop'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_requester_id_agents_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_open_line_idx" ON "jobs" USING btree ("requester_id", "agent_id") NULLS NOT DISTINCT WHERE "state" IN ('open', 'needs_input');
--> statement-breakpoint
CREATE INDEX "jobs_agent_id_idx" ON "jobs" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "jobs_requester_id_idx" ON "jobs" USING btree ("requester_id");
