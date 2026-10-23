-- Hand-offs: what an agent's reasoning lane wants said to anyone but the agents it
-- brought in. Its conversation lane sends each one or declines it with a reason; a lane
-- failure closes the rest as failed, so none is ever lost without a record.

CREATE TABLE "handoffs" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"to_agent_id" text,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"message_id" uuid,
	"reason" text,
	"expects_reply" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "handoffs_kind_check" CHECK ("handoffs"."kind" IN ('result', 'blocker', 'question', 'progress', 'note', 'request')),
	CONSTRAINT "handoffs_state_check" CHECK ("handoffs"."state" IN ('pending', 'sent', 'declined', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_pending_recipient_idx" ON "handoffs" USING btree ("agent_id", coalesce("to_agent_id", '')) WHERE "handoffs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "handoffs_agent_state_idx" ON "handoffs" USING btree ("agent_id","state");
