-- The tool registry is a code file and there are no grants. The tables are kept, renamed, so
-- nothing is lost; drop them once the grants are no longer wanted for reference.

ALTER TABLE "agent_tools" RENAME TO "agent_tools_retired_20261029";--> statement-breakpoint
ALTER TABLE "tools" RENAME TO "tools_retired_20261029";
