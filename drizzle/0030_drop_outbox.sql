-- One send path: the work lane's `queue_message` and its outbox are gone, so the `handoffs`
-- table (the outbox) has nothing left to hold. Its rows were an audit of sends that are all in
-- `messages`; they are kept in a backup table.

CREATE TABLE "handoffs_backup_20261114" AS
SELECT * FROM "handoffs";
--> statement-breakpoint
DROP TABLE "handoffs";
