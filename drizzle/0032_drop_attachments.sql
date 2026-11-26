-- Files are plain files on the box and a message links the ones it mentions: `[name](box://<path>)`,
-- percent-encoded as the clients encode it. Every message that has bound attachments gets one link
-- per distinct file appended to its content, in position order, after a blank line when it already
-- has text, so history reads as it did. Unbound rows and rows with no path (none were left) are
-- dropped without a link. The attachments table and the changed messages' old content are kept in
-- backup tables until the links are checked; the table itself is then dropped.

CREATE TABLE "attachments_backup_20261126" AS
SELECT * FROM "attachments";
--> statement-breakpoint
CREATE TABLE "messages_content_backup_20261126" AS
SELECT "id", "content" FROM "messages"
WHERE "id" IN (SELECT "message_id" FROM "attachments" WHERE "message_id" IS NOT NULL AND "path" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION "box_href_path"(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	bytes bytea := convert_to(p, 'UTF8');
	encoded text := '';
	b int;
BEGIN
	FOR i IN 0 .. length(bytes) - 1 LOOP
		b := get_byte(bytes, i);
		IF b = 47 OR (b BETWEEN 48 AND 57) OR (b BETWEEN 65 AND 90) OR (b BETWEEN 97 AND 122) OR b IN (45, 95, 46, 33, 126, 42, 39) THEN
			encoded := encoded || chr(b);
		ELSE
			encoded := encoded || '%' || upper(lpad(to_hex(b), 2, '0'));
		END IF;
	END LOOP;
	RETURN encoded;
END
$$;
--> statement-breakpoint
UPDATE "messages" AS m
SET "content" = m."content" || CASE WHEN m."content" = '' THEN '' ELSE E'\n\n' END || l."links"
FROM (
	SELECT "message_id", string_agg(
		'[' || replace(replace(replace("filename", '\', '\\'), '[', '\['), ']', '\]') || '](box://' || "box_href_path"("path") || ')',
		E'\n' ORDER BY "position", "id"
	) AS "links"
	FROM (
		SELECT DISTINCT ON ("message_id", "path") "message_id", "path", "filename", "position", "id"
		FROM "attachments"
		WHERE "message_id" IS NOT NULL AND "path" IS NOT NULL
		ORDER BY "message_id", "path", "position", "id"
	) AS "first_of_path"
	GROUP BY "message_id"
) AS l
WHERE m."id" = l."message_id";
--> statement-breakpoint
DROP FUNCTION "box_href_path"(text);
--> statement-breakpoint
DROP TABLE "attachments";
