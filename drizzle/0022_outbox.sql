-- The work lane's messages to its process lane no longer have a kind, and several may wait
-- for one recipient. Existing rows (and their kind and declined state) are left as they are.

ALTER TABLE "handoffs" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "handoffs_pending_recipient_idx";
