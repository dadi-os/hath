-- An async call records the lane that made it, so its result, or its loss in a restart, wakes that lane.
ALTER TABLE "pending_async" ADD COLUMN "lane" text DEFAULT 'work' NOT NULL;
