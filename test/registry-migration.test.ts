import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { migrate } from "../src/db/migrate.js";
import { openTestDb, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
});

after(async () => {
  await handle.close();
});

test("the tools and agent_tools tables are kept, renamed, not dropped", async () => {
  const rows = await handle.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE ${"%tools%"}
    ORDER BY table_name`;
  assert.deepEqual(
    rows.map((row) => row.table_name),
    ["agent_tools_retired_20261029", "tools_retired_20261029"],
  );
});
