-- Agent transcripts are a rolling window over the thread again; the history
-- summary that stood in for messages older than the window is gone.

DROP TABLE "agent_histories";
