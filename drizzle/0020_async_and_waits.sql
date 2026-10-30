-- Helper reports delivered (by report time), async calls still running, and what a work
-- lane waits on.

CREATE TABLE "delivered_reports" (
	"task" text PRIMARY KEY NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_async" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"targets" text[] NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_async" ADD CONSTRAINT "pending_async_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_async_agent_id_idx" ON "pending_async" USING btree ("agent_id");
