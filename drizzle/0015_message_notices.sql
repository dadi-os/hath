-- Notices: hath's own word that an agent's work stopped (a failed lane, a job left
-- unfinished, a restart) is a notice, not a chat message from the agent with a
-- "[runtime]" prefix. Agents read it as hath's note and Thaali shows it as a system line.

ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('message', 'notice'));
