import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BrowserDriver } from "../src/browser/driver.js";
import type { ChaaviClient } from "../src/chaavi/client.js";
import type { NasClient } from "../src/nas/client.js";
import { createRuntime } from "../src/runtime/engine.js";
import { executeTool } from "../src/runtime/tools.js";
import { migrate } from "../src/db/migrate.js";
import { allTools, findTool } from "../src/tools/registry.js";
import { syncTools } from "../src/tools/sync.js";
import { HathError } from "../src/errors.js";
import {
  chaaviItem,
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
  "chaavi_list_folders",
  "chaavi_create_login",
  "chaavi_fill_login",
  "chaavi_fill_passkey",
  "chaavi_fill_secret",
  "chaavi_save_secret",
  "chaavi_read_note",
  "chaavi_fill_card",
] as const;

/**
 * Run one Chaavi tool as a fresh worker holding it, with optional browser and Nas doubles,
 * and return the tool result.
 */
async function runTool(opts: {
  tool: (typeof CHAAVI_TOOLS)[number];
  input: Record<string, unknown>;
  chaavi: ChaaviClient;
  nas?: NasClient;
  browsers?: Partial<BrowserDriver>;
}) {
  await resetRuntime(handle.sql, handle.db, config);
  const workerId = await insertWorker(handle.db, {
    name: "thread",
    systemPrompt: "do the job",
    tools: [opts.tool],
  });
  const runtime = createRuntime({
    db: handle.db,
    dwar: mockDwar({}),
    yaad: mockYaad(),
    ghar: mockGhar(),
    chaavi: opts.chaavi,
    nas: opts.nas ?? mockNas(),
    config,
    log: silentLog,
  });
  const base = runtime.toolContext(workerId, "reasoning");
  const ctx = opts.browsers ? { ...base, browsers: opts.browsers as unknown as BrowserDriver } : base;
  return executeTool(ctx, { type: "tool_use", id: `t-${opts.tool}`, name: opts.tool, input: opts.input });
}

/** Browser double that records every fill and type, by ref. */
function recordingBrowser() {
  const calls: Array<{ method: string; ref: string; values: string[]; submit?: boolean }> = [];
  return {
    calls,
    browsers: {
      type: async (_browserId: number, tabId: string | undefined, ref: string, text: string, submit?: boolean) => {
        calls.push({ method: "type", ref, values: [text], ...(submit !== undefined ? { submit } : {}) });
        return { tab_id: tabId ?? "t1" };
      },
      fillField: async (_browserId: number, tabId: string | undefined, ref: string, forms: readonly string[]) => {
        calls.push({ method: "fill", ref, values: [...forms] });
        return { tab_id: tabId ?? "t1" };
      },
    } satisfies Partial<BrowserDriver>,
  };
}

const CARD = {
  cardholderName: "Ada Lovelace",
  brand: "Visa",
  number: "4111111111111111",
  expMonth: "8",
  expYear: "2029",
  code: "123",
};

const IDENTITY = chaaviItem({
  id: "item-identity-1",
  name: "Personal",
  type: "identity",
  identity: {
    firstName: "Ada",
    lastName: "Lovelace",
    address1: "1 Example St",
    address2: null,
    city: "East Lansing",
    state: "MI",
    postalCode: "48823",
    country: "US",
  },
});

test("Chaavi tools are registered", async () => {
  await resetRuntime(handle.sql, handle.db, config);
  for (const name of CHAAVI_TOOLS) {
    assert.equal(findTool(name)?.name, name);
  }
  assert.equal(allTools().length, 61);
  await assert.doesNotReject(() => syncTools(handle.db));
});

test("chaavi_fill_card says a purchase needs Ankur's yes first", () => {
  const tool = findTool("chaavi_fill_card");
  assert.ok(tool);
  assert.match(tool.description, /payment or purchase is a write/);
  assert.match(tool.description, /Ankur must have said yes to this specific purchase/);
});

test("list_items shows how to use each item and never a value", async () => {
  const chaavi = mockChaavi({
    listItems: () => ({
      items: [
        chaaviItem({
          id: "item-login-1",
          name: "Bank",
          login: { username: "ada", uris: [{ uri: "https://bank.example" }], passkeys: [{ rpId: "bank.example" }] },
        }),
        chaaviItem({ id: "item-card-1", name: "Sapphire", type: "card", card: { brand: "Visa" } }),
        chaaviItem({
          id: "item-note-1",
          name: "Stripe API key",
          type: "note",
          fields: [
            { name: "Account", type: "text", value: "acct_1" },
            { name: "Secret", type: "hidden", hasValue: true },
          ],
        }),
        chaaviItem({ id: "item-note-2", name: "Wifi", type: "note", hasNotes: true }),
        chaaviItem({ id: "item-passport-1", name: "US passport", type: "passport" }),
      ],
    }),
  });
  const result = await runTool({
    tool: "chaavi_list_items",
    chaavi,
    input: { q: "Bank", uri: "https://bank.example", type: "login" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.listItemsCalls, [{ q: "Bank", uri: "https://bank.example", type: "login" }]);
  assert.deepEqual(JSON.parse(result.content), {
    items: [
      { id: "item-login-1", name: "Bank", type: "login", folder: null, username: "ada", uris: ["https://bank.example"], hasPasskey: true },
      { id: "item-card-1", name: "Sapphire", type: "card", folder: null, brand: "Visa" },
      { id: "item-note-1", name: "Stripe API key", type: "note", folder: null, secret: true },
      { id: "item-note-2", name: "Wifi", type: "note", folder: null, secret: false },
      { id: "item-passport-1", name: "US passport", type: "passport", folder: null },
    ],
  });
});

test("list_items passes a folder to Chaavi and names each item's folder; list_folders lists the names", async () => {
  const folders = [
    { id: "f-dev", name: "development" },
    { id: "f-fliks", name: "development/fliks-gg" },
    { id: "f-acct", name: "google/work" },
  ];
  const chaavi = mockChaavi({
    listFolders: () => ({ folders: [folders[2]!, folders[1]!, folders[0]!] }),
    listItems: () => ({
      items: [
        chaaviItem({ id: "item-1", name: "AWS", folderId: "f-fliks" }),
        chaaviItem({ id: "item-2", name: "Vercel", folderId: "f-dev" }),
      ],
    }),
  });
  const listed = await runTool({ tool: "chaavi_list_items", chaavi, input: { folder: "development" } });
  assert.equal(listed.isError, false);
  assert.deepEqual(chaavi.listItemsCalls, [{ folder: "development" }]);
  assert.deepEqual(
    JSON.parse(listed.content).items.map((item: { name: string; folder: string }) => [item.name, item.folder]),
    [
      ["AWS", "development/fliks-gg"],
      ["Vercel", "development"],
    ],
  );
  const names = await runTool({ tool: "chaavi_list_folders", chaavi, input: {} });
  assert.deepEqual(JSON.parse(names.content), { folders: ["development", "development/fliks-gg", "google/work"] });
});

test("list_items passes Chaavi's unknown-folder error to the agent", async () => {
  const chaavi = mockChaavi({
    listItems: () => {
      throw new HathError(404, "chaavi", 'no folder named "Nope"');
    },
  });
  const result = await runTool({ tool: "chaavi_list_items", chaavi, input: { folder: "Nope" } });
  assert.equal(result.isError, true);
  assert.match(result.content, /no folder named "Nope"/);
});

test("fill_login types username then password and never returns the password", async () => {
  const password = "s3cret-pass";
  const browser = recordingBrowser();
  const result = await runTool({
    tool: "chaavi_fill_login",
    chaavi: mockChaavi({ getLogin: () => ({ username: "ada", password }) }),
    browsers: browser.browsers,
    input: { item_id: "item-login-1", browser_id: 10, tab_id: "tab-1", username_ref: "e1", password_ref: "e2", submit: true },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [
    { method: "type", ref: "e1", values: ["ada"] },
    { method: "type", ref: "e2", values: [password], submit: true },
  ]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.filled, true);
  assert.equal(body.username, "ada");
  assert.equal(result.content.includes(password), false);
});

test("fill_login reports a failed password fill without the password or the driver's call log", async () => {
  const password = "s3cret-pass";
  const result = await runTool({
    tool: "chaavi_fill_login",
    chaavi: mockChaavi({ getLogin: () => ({ username: "ada", password }) }),
    browsers: {
      type: async (_browserId: number, _tabId: string | undefined, _ref: string, text: string) => {
        throw new Error(`locator.fill: Error: ${text} is not an <input>\nCall log:\n  - fill("${text}")`);
      },
    },
    input: { item_id: "item-login-1", browser_id: 10, password_ref: "e2" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content.includes(password), false);
  assert.equal(result.content.includes("Call log"), false);
  assert.match(result.content, /password field e2 was not filled: locator.fill: Error: \[password\] is not/);
});

test("fill_login fills a username-only sign-in page and presses Enter on it", async () => {
  const browser = recordingBrowser();
  const result = await runTool({
    tool: "chaavi_fill_login",
    chaavi: mockChaavi({ getLogin: () => ({ username: "ada", password: "s3cret-pass" }) }),
    browsers: browser.browsers,
    input: { item_id: "item-login-1", browser_id: 10, username_ref: "e1", submit: true },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [{ method: "type", ref: "e1", values: ["ada"], submit: true }]);
});

test("fill_login with a login that has no username fills only the password and says so", async () => {
  const browser = recordingBrowser();
  const result = await runTool({
    tool: "chaavi_fill_login",
    chaavi: mockChaavi({ getLogin: () => ({ username: null, password: "s3cret-pass" }) }),
    browsers: browser.browsers,
    input: { item_id: "item-login-1", browser_id: 10, username_ref: "e1", password_ref: "e2" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [{ method: "type", ref: "e2", values: ["s3cret-pass"] }]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.username, null);
  assert.equal(body.username_skipped, "the login has no username");

  const usernameOnly = await runTool({
    tool: "chaavi_fill_login",
    chaavi: mockChaavi({ getLogin: () => ({ username: null, password: "s3cret-pass" }) }),
    browsers: recordingBrowser().browsers,
    input: { item_id: "item-login-1", browser_id: 10, username_ref: "e1" },
  });
  assert.equal(usernameOnly.isError, true);
  assert.match(usernameOnly.content, /has no username to fill/);
});

test("create_login saves a generated or given password and never returns it", async () => {
  const chaavi = mockChaavi({
    createLogin: (input) =>
      chaaviItem({
        id: "item-new-1",
        name: input.name,
        login: { username: input.username, uris: input.uri !== undefined ? [{ uri: input.uri }] : [], passkeys: [] },
      }),
  });
  const generated = await runTool({
    tool: "chaavi_create_login",
    chaavi,
    input: { name: "Acme Careers", username: "ada@example.com", uri: "https://jobs.acme.example", length: 24, special: true },
  });
  assert.equal(generated.isError, false);
  assert.deepEqual(JSON.parse(generated.content), {
    id: "item-new-1",
    name: "Acme Careers",
    type: "login",
    username: "ada@example.com",
    uris: ["https://jobs.acme.example"],
    hasPasskey: false,
  });
  const given = await runTool({
    tool: "chaavi_create_login",
    chaavi,
    input: { name: "Portal", username: "ada", password: "issued-by-site-9" },
  });
  assert.equal(given.isError, false);
  assert.equal(given.content.includes("issued-by-site-9"), false);
  assert.deepEqual(chaavi.createLoginCalls, [
    { name: "Acme Careers", username: "ada@example.com", uri: "https://jobs.acme.example", length: 24, special: true },
    { name: "Portal", username: "ada", password: "issued-by-site-9" },
  ]);
  const both = await runTool({
    tool: "chaavi_create_login",
    chaavi,
    input: { name: "Portal", username: "ada", password: "issued-by-site-9", length: 20 },
  });
  assert.equal(both.isError, true);
});

test("fill_passkey loads the credential into the browser and never returns the key", async () => {
  const privateKey = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg";
  const addCalls: Array<{ browserId: number; tabId: string | undefined; rpId: string }> = [];
  const result = await runTool({
    tool: "chaavi_fill_passkey",
    chaavi: mockChaavi({
      getPasskey: () => ({ credentialId: "QUJDRA==", rpId: "google.com", privateKey, userHandle: "dXNlcg==", signCount: 0, resident: true }),
    }),
    browsers: {
      addPasskey: async (browserId: number, tabId: string | undefined, cred: { rpId: string }) => {
        addCalls.push({ browserId, tabId, rpId: cred.rpId });
        return { tab_id: tabId ?? "t1", url: "https://accounts.google.com/v3/signin/challenge/pk" };
      },
    } as unknown as Partial<BrowserDriver>,
    input: { item_id: "item-passkey-1", browser_id: 10, tab_id: "tab-1" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(addCalls, [{ browserId: 10, tabId: "tab-1", rpId: "google.com" }]);
  assert.equal(result.content.includes(privateKey), false);
});

test("fill_secret resolves the note's Secret by name into a terminal env and scrubs output", async () => {
  const secret = "tok_live_abc";
  const chaavi = mockChaavi({ revealSecret: () => ({ value: secret }) });
  const nas = mockNas({
    exec: () => ({ exit_code: 0, output: `used ${secret} ok`, truncated: false, timed_out: false }),
  });
  const result = await runTool({
    tool: "chaavi_fill_secret",
    chaavi,
    nas,
    input: { name: "Stripe API key", terminal_id: "t1", command: "echo done", env_name: "STRIPE_KEY" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.revealSecretCalls, ["Stripe API key"]);
  assert.match(nas.writeFileCalls[0]!.path, /^\/tmp\/dadi-chaavi-/);
  assert.equal(nas.writeFileCalls[0]!.content, secret);
  assert.match(nas.execCalls[0]!.body.command, /export STRIPE_KEY=\$\(cat /);
  assert.match(nas.execCalls[0]!.body.command, /rm -f /);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.output, "used *** ok");
  assert.equal(body.name, "Stripe API key");
  assert.equal(body.env_name, "STRIPE_KEY");
  assert.equal(result.content.includes(secret), false);
});

test("fill_secret types the note's Secret into a browser field without returning it", async () => {
  const secret = "abcd efgh ijkl mnop";
  const browser = recordingBrowser();
  const result = await runTool({
    tool: "chaavi_fill_secret",
    chaavi: mockChaavi({ revealSecret: () => ({ value: secret }) }),
    browsers: browser.browsers,
    input: { name: "Gmail app password", browser_id: 3, ref: "e9", submit: true },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [{ method: "type", ref: "e9", values: [secret], submit: true }]);
  assert.deepEqual(JSON.parse(result.content), { filled: true, name: "Gmail app password", browser_id: 3, ref: "e9" });
});

test("fill_secret needs exactly one target and passes Chaavi's not_found through", async () => {
  const chaavi = mockChaavi();
  const none = await runTool({ tool: "chaavi_fill_secret", chaavi, input: { name: "x" } });
  assert.equal(none.isError, true);
  const both = await runTool({
    tool: "chaavi_fill_secret",
    chaavi,
    input: { name: "x", browser_id: 1, ref: "e1", terminal_id: "t1", command: "c", env_name: "E" },
  });
  assert.equal(both.isError, true);
  assert.equal(chaavi.revealSecretCalls.length, 0);
  const missing = await runTool({
    tool: "chaavi_fill_secret",
    chaavi,
    input: { name: "Nope", terminal_id: "t1", command: "echo", env_name: "E" },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /^not_found: secure note Nope not found/);
});

test("save_secret stores the value by name and never echoes it", async () => {
  const chaavi = mockChaavi({
    saveSecret: (name) => ({
      item: chaaviItem({ id: "item-note-9", name, type: "note", fields: [{ name: "Secret", type: "hidden", hasValue: true }] }),
      created: true,
    }),
  });
  const result = await runTool({
    tool: "chaavi_save_secret",
    chaavi,
    input: { name: "Gmail app password", value: "abcd efgh ijkl mnop", notes: "for the mail worker" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.saveSecretCalls, [
    { name: "Gmail app password", input: { value: "abcd efgh ijkl mnop", notes: "for the mail worker" } },
  ]);
  assert.deepEqual(JSON.parse(result.content), { saved: true, id: "item-note-9", name: "Gmail app password", created: true });
});

test("read_note returns the text and non-hidden fields, and only names hidden ones", async () => {
  const chaavi = mockChaavi({
    getItem: () =>
      chaaviItem({
        id: "item-note-1",
        name: "Stripe API key",
        type: "note",
        hasNotes: true,
        fields: [
          { name: "Account", type: "text", value: "acct_1" },
          { name: "Live", type: "boolean", value: true },
          { name: "Secret", type: "hidden", hasValue: true },
        ],
      }),
    reveal: () => ({ value: "Live key for billing." }),
  });
  const result = await runTool({ tool: "chaavi_read_note", chaavi, input: { item_id: "item-note-1" } });
  assert.equal(result.isError, false);
  assert.deepEqual(chaavi.revealCalls, [{ itemId: "item-note-1", request: { field: "notes" } }]);
  assert.deepEqual(JSON.parse(result.content), {
    id: "item-note-1",
    name: "Stripe API key",
    notes: "Live key for billing.",
    fields: [
      { name: "Account", type: "text", value: "acct_1" },
      { name: "Live", type: "boolean", value: true },
    ],
    hidden_fields: ["Secret"],
  });
  const login = await runTool({
    tool: "chaavi_read_note",
    chaavi: mockChaavi({ getItem: () => chaaviItem({ id: "item-login-1", name: "Bank" }) }),
    input: { item_id: "item-login-1" },
  });
  assert.equal(login.isError, true);
  assert.match(login.content, /is a login, not a secure note/);
});

test("fill_card fills card and billing fields, matching dropdowns, and returns no value", async () => {
  const browser = recordingBrowser();
  const chaavi = mockChaavi({ getCard: () => CARD, getItem: () => IDENTITY });
  const result = await runTool({
    tool: "chaavi_fill_card",
    chaavi,
    browsers: browser.browsers,
    input: {
      item_id: "item-card-1",
      browser_id: 4,
      name_ref: "e1",
      number_ref: "e2",
      exp_month_ref: "e3",
      exp_year_ref: "e4",
      code_ref: "e5",
      identity_id: "item-identity-1",
      address1_ref: "e6",
      postal_code_ref: "e7",
      country_ref: "e8",
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [
    { method: "fill", ref: "e1", values: ["Ada Lovelace"] },
    { method: "fill", ref: "e2", values: ["4111111111111111"] },
    { method: "fill", ref: "e3", values: ["08", "8", "August", "Aug"] },
    { method: "fill", ref: "e4", values: ["2029", "29"] },
    { method: "fill", ref: "e5", values: ["123"] },
    { method: "fill", ref: "e6", values: ["1 Example St"] },
    { method: "fill", ref: "e7", values: ["48823"] },
    { method: "fill", ref: "e8", values: ["US"] },
  ]);
  assert.deepEqual(JSON.parse(result.content), {
    filled: ["name", "number", "expiry month", "expiry year", "security code", "address1", "postalCode", "country"],
    item_id: "item-card-1",
    identity_id: "item-identity-1",
    browser_id: 4,
  });
  for (const value of ["4111111111111111", "Ada Lovelace", "1 Example St", "48823"]) {
    assert.equal(result.content.includes(value), false);
  }
});

test("fill_card writes a single expiry field in the form's format", async () => {
  const browser = recordingBrowser();
  const result = await runTool({
    tool: "chaavi_fill_card",
    chaavi: mockChaavi({ getCard: () => CARD }),
    browsers: browser.browsers,
    input: { item_id: "item-card-1", browser_id: 4, expiry_ref: "e3", expiry_format: "MM / YY" },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(browser.calls, [{ method: "fill", ref: "e3", values: ["08 / 29"] }]);
});

test("fill_card fills nothing when a requested value is missing, and scrubs a failed fill", async () => {
  const browser = recordingBrowser();
  const noCode = await runTool({
    tool: "chaavi_fill_card",
    chaavi: mockChaavi({ getCard: () => ({ ...CARD, code: null }) }),
    browsers: browser.browsers,
    input: { item_id: "item-card-1", browser_id: 4, number_ref: "e2", code_ref: "e5" },
  });
  assert.equal(noCode.isError, true);
  assert.match(noCode.content, /^invalid_request: card security code is not in Chaavi/);
  assert.deepEqual(browser.calls, []);

  const noIdentity = await runTool({
    tool: "chaavi_fill_card",
    chaavi: mockChaavi({ getCard: () => CARD }),
    browsers: browser.browsers,
    input: { item_id: "item-card-1", browser_id: 4, city_ref: "e9" },
  });
  assert.equal(noIdentity.isError, true);

  const notIdentity = await runTool({
    tool: "chaavi_fill_card",
    chaavi: mockChaavi({ getCard: () => CARD, getItem: () => chaaviItem({ id: "item-login-1", name: "Bank" }) }),
    browsers: browser.browsers,
    input: { item_id: "item-card-1", browser_id: 4, identity_id: "item-login-1", city_ref: "e9" },
  });
  assert.equal(notIdentity.isError, true);
  assert.match(notIdentity.content, /is a login, not an identity/);

  const failing = await runTool({
    tool: "chaavi_fill_card",
    chaavi: mockChaavi({ getCard: () => CARD }),
    browsers: {
      fillField: async (_browserId: number, _tabId: string | undefined, _ref: string, forms: readonly string[]) => {
        throw new Error(`locator.fill: ${forms[0]} rejected\nCall log:\n  - fill("${forms[0]}")`);
      },
    },
    input: { item_id: "item-card-1", browser_id: 4, number_ref: "e2" },
  });
  assert.equal(failing.isError, true);
  assert.equal(failing.content.includes("4111111111111111"), false);
  assert.match(failing.content, /number field e2 was not filled: locator.fill: \[number\] rejected$/);
});

test("Chaavi unreachable fails with chaavi code, not an empty success", async () => {
  const result = await runTool({
    tool: "chaavi_list_items",
    chaavi: mockChaavi({
      listItems: () => {
        throw new HathError(502, "chaavi", "Chaavi is unreachable");
      },
    }),
    input: {},
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /^chaavi: Chaavi is unreachable/);
});

test("vault_unconfigured and conflict map through", async () => {
  const unconfigured = await runTool({
    tool: "chaavi_list_items",
    chaavi: mockChaavi({
      listItems: () => {
        throw new HathError(503, "vault_unconfigured", "vault is not configured");
      },
    }),
    input: {},
  });
  assert.match(unconfigured.content, /^vault_unconfigured:/);
  const conflict = await runTool({
    tool: "chaavi_save_secret",
    chaavi: mockChaavi({
      saveSecret: () => {
        throw new HathError(409, "conflict", '2 secure notes are named "Stripe API key"');
      },
    }),
    input: { name: "Stripe API key", value: "x" },
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content, /^conflict: 2 secure notes/);
});
