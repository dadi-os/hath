-- Attachments become durable rows next to the message that carries them,
-- instead of being folded into its text and dropped.

CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid,
	"created_by_agent_id" text,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"text_content" text,
	"data" bytea,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_payload_check" CHECK (("text_content" IS NULL) <> ("data" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "attachments_message_id_position_idx" ON "attachments" USING btree ("message_id","position");
