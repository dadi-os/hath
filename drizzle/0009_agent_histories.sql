-- An agent's summary of the messages that left its transcript, so older work
-- outlives the window instead of being dropped.

CREATE TABLE "agent_histories" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"summarized_through_seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_histories" ADD CONSTRAINT "agent_histories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
