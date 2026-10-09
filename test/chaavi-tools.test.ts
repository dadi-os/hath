import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BrowserDriver } from "../src/browser/driver.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import { HathError } from "../src/errors.js";
import {
  insertWorker,
  mockChaavi,
  mockDwar,
  mockGhar,
  mockNas,
  mockYaad,
  openTestDb,
  resetRuntime,
  silentLog,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await migrate(config);
  await resetRuntime(handle.sql, handle.db, config);
});

after(async () => {
  await handle.close();
});

const CHAAVI_TOOLS = [
  "chaavi_list_items",
  "chaavi_create_login",
  "chaavi_fill_login",
  "chaavi_fill_passkey",
  "chaavi_fill_secret",
] as const;

test("Chaavi tools are registered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of CHAAVI_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 52);
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("list_items shapes items without a password field", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_list_items"],
  });
  const itemId = "item-login-1";
  const chaavi = mockChaavi({
    listItems: () => ({
      items: [
        {
          id: itemId,
          name: "Bank",
          kind: "login",
          username: "ada",
          uris: ["https://bank.example"],
          hasPasskey: false,
        },
      ],
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "li1",
    name: "chaavi_list_items",
    input: { q: "Bank", uri: "https://bank.example", kind: "login" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.listItemsCalls, [
    { q: "Bank", uri: "https://bank.example", kind: "login" },
  ]);
  const body = JSON.parse(result.content) as {
    items: Array<Record<string, unknown>>;
  };
  assert.equal(body.items[0]?.id, itemId);
  assert.equal(body.items[0]?.name, "Bank");
  assert.equal(body.items[0]?.kind, "login");
  assert.equal(body.items[0]?.username, "ada");
  assert.deepEqual(body.items[0]?.uris, ["https://bank.example"]);
  assert.equal(body.items[0]?.hasPasskey, false);
  assert.equal("password" in (body.items[0] ?? {}), false);
});

test("fill_login types username then password and never returns the password", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_fill_login"],
  });
  const itemId = "item-login-1";
  const password = "s3cret-pass";
  const chaavi = mockChaavi({
    getLogin: () => ({ username: "ada", password }),
  });
  const typeCalls: Array<{
    browserId: number;
    tabId: string | undefined;
    ref: string;
    text: string;
    submit?: boolean;
  }> = [];
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const ctx = {
    ...runtime.toolContext(workerId, "reasoning"),
    browsers: {
      type: async (
        browserId: number,
        tabId: string | undefined,
        ref: string,
        text: string,
        submit?: boolean,
      ) => {
        typeCalls.push({ browserId, tabId, ref, text, submit });
        return { tab_id: tabId ?? "t1" };
      },
    } as unknown as BrowserDriver,
  };
  const result = await executeTool(ctx, {
    type: "tool_use",
    id: "fl1",
    name: "chaavi_fill_login",
    input: {
      item_id: itemId,
      browser_id: 10,
      tab_id: "tab-1",
      username_ref: "e1",
      password_ref: "e2",
      submit: true,
    },
  });
  assert.equal(result.isError, false);
  assert.equal(typeCalls.length, 2);
  assert.equal(typeCalls[0]?.ref, "e1");
  assert.equal(typeCalls[0]?.text, "ada");
  assert.equal(typeCalls[0]?.submit, undefined);
  assert.equal(typeCalls[1]?.ref, "e2");
  assert.equal(typeCalls[1]?.text, password);
  assert.equal(typeCalls[1]?.submit, true);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.filled, true);
  assert.equal(body.item_id, itemId);
  assert.equal(body.username, "ada");
  assert.equal(body.browser_id, 10);
  assert.equal("password" in body, false);
  assert.equal(result.content.includes(password), false);
});

test("create_login stores a vault item and never returns the password", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_create_login"],
  });
  const itemId = "item-new-1";
  const chaavi = mockChaavi({
    createLogin: (input) => ({
      id: itemId,
      name: input.name,
      kind: "login",
      username: input.username,
      uris: input.uri !== undefined ? [input.uri] : [],
      hasPasskey: false,
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "cl1",
    name: "chaavi_create_login",
    input: {
      name: "Acme Careers",
      username: "ada@example.com",
      uri: "https://jobs.acme.example",
      length: 24,
      special: true,
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.createLoginCalls, [
    {
      name: "Acme Careers",
      username: "ada@example.com",
      uri: "https://jobs.acme.example",
      length: 24,
      special: true,
    },
  ]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.id, itemId);
  assert.equal(body.name, "Acme Careers");
  assert.equal(body.kind, "login");
  assert.equal(body.username, "ada@example.com");
  assert.deepEqual(body.uris, ["https://jobs.acme.example"]);
  assert.equal(body.hasPasskey, false);
  assert.equal("password" in body, false);
});

test("fill_passkey loads the credential into the browser and never returns the key", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_fill_passkey"],
  });
  const itemId = "item-passkey-1";
  const privateKey = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg";
  const chaavi = mockChaavi({
    getPasskey: () => ({
      credentialId: "QUJDRA==",
      rpId: "google.com",
      privateKey,
      userHandle: "dXNlcg==",
      signCount: 0,
      resident: true,
    }),
  });
  const addCalls: Array<{
    browserId: number;
    tabId: string | undefined;
    cred: { rpId: string; privateKey: string };
  }> = [];
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const ctx = {
    ...runtime.toolContext(workerId, "reasoning"),
    browsers: {
      addPasskey: async (
        browserId: number,
        tabId: string | undefined,
        cred: { rpId: string; privateKey: string },
      ) => {
        addCalls.push({ browserId, tabId, cred });
        return { tab_id: tabId ?? "t1", url: "https://accounts.google.com/v3/signin/challenge/pk" };
      },
    } as unknown as BrowserDriver,
  };
  const result = await executeTool(ctx, {
    type: "tool_use",
    id: "pk1",
    name: "chaavi_fill_passkey",
    input: {
      item_id: itemId,
      browser_id: 10,
      tab_id: "tab-1",
    },
  });
  assert.equal(result.isError, false);
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0]?.browserId, 10);
  assert.equal(addCalls[0]?.tabId, "tab-1");
  assert.equal(addCalls[0]?.cred.rpId, "google.com");
  assert.equal(addCalls[0]?.cred.privateKey, privateKey);
  assert.deepEqual(chaavi.getPasskeyCalls, [itemId]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.filled, true);
  assert.equal(body.item_id, itemId);
  assert.equal(body.rp_id, "google.com");
  assert.equal(body.browser_id, 10);
  assert.equal(body.tab_id, "tab-1");
  assert.equal(body.url, "https://accounts.google.com/v3/signin/challenge/pk");
  assert.equal("privateKey" in body, false);
  assert.equal("credentialId" in body, false);
  assert.equal(result.content.includes(privateKey), false);
});

test("fill_secret redacts the value from exec output and omits it from the payload", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_fill_secret"],
  });
  const itemId = "item-secret-1";
  const secret = "tok_live_abc";
  const chaavi = mockChaavi({
    getSecret: () => ({ value: secret }),
  });
  const nas = mockNas({
    exec: () => ({
      exit_code: 0,
      output: `used ${secret} ok`,
      truncated: false,
      timed_out: false,
    }),
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas,
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "ws1",
    name: "chaavi_fill_secret",
    input: {
      item_id: itemId,
      terminal_id: "t1",
      command: "echo done",
      env_name: "NOTARY_KEY",
    },
  });
  assert.equal(result.isError, false);
  assert.equal(nas.writeFileCalls.length, 1);
  assert.match(nas.writeFileCalls[0]!.path, /^\/tmp\/dadi-chaavi-/);
  assert.equal(nas.writeFileCalls[0]!.content, secret);
  assert.equal(nas.execCalls.length, 1);
  assert.match(nas.execCalls[0]!.body.command, /export NOTARY_KEY=\$\(cat /);
  assert.match(nas.execCalls[0]!.body.command, /rm -f /);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.exit_code, 0);
  assert.equal(body.output, "used *** ok");
  assert.equal(body.item_id, itemId);
  assert.equal(body.env_name, "NOTARY_KEY");
  assert.equal("value" in body, false);
  assert.equal(result.content.includes(secret), false);
});

test("Chaavi unreachable fails with chaavi code, not an empty success", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_list_items"],
  });
  const chaavi = mockChaavi({
    listItems: () => {
      throw new HathError(502, "chaavi", "Chaavi is unreachable");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "li2",
    name: "chaavi_list_items",
    input: {},
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^chaavi:/);
  assert.match(result.content, /unreachable/i);
  const body = (() => {
    try {
      return JSON.parse(result.content);
    } catch {
      return null;
    }
  })();
  assert.equal(body, null);
});

test("vault_unconfigured maps through", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: ["chaavi_list_items"],
  });
  const chaavi = mockChaavi({
    listItems: () => {
      throw new HathError(503, "vault_unconfigured", "vault is not configured");
    },
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi,
    nas: mockNas(),
    config,
    log: silentLog,
  });
  const result = await executeTool(runtime.toolContext(workerId, "reasoning"), {
    type: "tool_use",
    id: "li3",
    name: "chaavi_list_items",
    input: {},
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^vault_unconfigured:/);
});
