-- Agents schedule their own routines: a scheduled message may go to its own sender.
ALTER TABLE "scheduled_messages" DROP CONSTRAINT "scheduled_messages_from_to_check";
