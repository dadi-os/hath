-- read_result looks up a lane's earlier tool result by its tool_use_id, so receipts and
-- [Did] entries can name a result instead of the lane running the tool again.

CREATE INDEX "agent_logs_tool_use_id_idx" ON "agent_logs" USING btree ((payload->>'tool_use_id')) WHERE "event" = 'tool_result';
