-- An attachment keeps the SHA-256 of its file, so one message carries a file once however it was named (a path and an id for the same file made two rows). Rows from before have no hash and are compared by filename, media type and size: a message's later rows of the same file are deleted, the earliest kept, and the deleted rows are kept in a backup table.

ALTER TABLE "attachments" ADD COLUMN "content_sha256" text;
--> statement-breakpoint
CREATE TABLE "attachments_duplicate_backup_20261109" AS
SELECT * FROM "attachments"
WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (
			PARTITION BY "message_id", "filename", "media_type", "size_bytes"
			ORDER BY "position", "created_at", "id"
		) AS "rank"
		FROM "attachments"
		WHERE "message_id" IS NOT NULL
	) AS "ranked"
	WHERE "rank" > 1
);
--> statement-breakpoint
DELETE FROM "attachments" WHERE "id" IN (SELECT "id" FROM "attachments_duplicate_backup_20261109");
