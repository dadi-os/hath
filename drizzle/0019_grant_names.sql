-- Grants are tool names only: each tool's own description says what it is for, so the
-- per-grant usage text goes.

ALTER TABLE "agent_tools" DROP COLUMN "usage";
