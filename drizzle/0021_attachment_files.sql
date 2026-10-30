-- An attachment's file is on the box at "path". Older rows still hold their bytes in
-- "text_content" or "data" until boot moves them to files; a later migration then drops
-- both columns and makes "path" required.

ALTER TABLE "attachments" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_payload_check";
