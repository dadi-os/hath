-- Read state for Ankur's threads: how far he has read each agent's thread, one
-- row per agent, so unread counts follow him across every device.

CREATE TABLE "thread_reads" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"read_seq" bigint NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
