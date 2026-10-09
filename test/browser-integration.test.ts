/**
 * Live Nas + Chromium browser driver. Skipped unless NAS_URL is set
 * (e.g. NAS_URL=http://127.0.0.1:8092 npm test -- test/browser-integration.test.ts).
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import axios from "axios";
import { BrowserDriver, type PasskeyInject } from "../src/browser/driver.js";
import { createNasClient } from "../src/nas/client.js";
import { silentLog, testConfig } from "./helpers.js";

const nasUrl = process.env.NAS_URL;

test("integration: snapshot refs across frames and shadow roots, actions, keys, tabs, truncate, stale_ref", async (t) => {
  if (!nasUrl) {
    t.skip("NAS_URL not set");
    return;
  }

  const config = testConfig();
  const http = axios.create({
    baseURL: nasUrl,
    timeout: Math.max(config.nas.timeout_ms, 120_000),
    headers: { "content-type": "application/json" },
  });

  const created = await http.post("/browsers", {});
  assert.equal(created.status, 200);
  const browserId = created.data.id as number;
  const cdpUrl = String(created.data.cdp_url).replace(
    /^ws:\/\/[^/]+/,
    nasUrl.replace(/^http/, "ws"),
  );

  const base = createNasClient(config);
  const nas = {
    ...base,
    createBrowser: async () => {
      const res = await http.post("/browsers", {});
      return res.data;
    },
    listBrowsers: async () => {
      const res = await http.get("/browsers");
      return res.data.map((b: { id: number; cdp_url: string; display: string; healthy: boolean }) => ({
        ...b,
        cdp_url: String(b.cdp_url).replace(/^ws:\/\/[^/]+/, nasUrl.replace(/^http/, "ws")),
      }));
    },
    closeBrowser: async (id: number) => {
      await http.delete(`/browsers/${id}`);
    },
    browserScreenshot: async (id: number) => {
      const res = await http.get(`/browsers/${id}/screenshot`, { responseType: "arraybuffer" });
      return Buffer.from(res.data);
    },
  };

  const driver = new BrowserDriver(nas, config, silentLog);
  driver.remember(browserId, { cdpUrl, downloadsDir: String(created.data.downloads_dir) });

  try {
    const pageHtml = encodeURIComponent(`<!doctype html><html><body>
      <button id="btn">Go</button>
      <input id="inp" type="text" name="q" value="" />
      <input id="pw" type="password" name="pw" value="hidden-pw-1" />
      <input id="shown" type="text" name="shown" autocomplete="current-password" value="hidden-pw-2" />
      <select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <div id="out"></div>
      <script>
        document.getElementById("btn").onclick = () => {
          document.getElementById("out").textContent = "clicked:" + document.getElementById("inp").value
            + ":" + document.getElementById("sel").value;
        };
      </script>
    </body></html>`);
    const nav = await driver.navigate(browserId, undefined, `data:text/html,${pageHtml}`);
    const tabId = nav.tab_id;

    const snap = await driver.accessibilityTree(browserId, tabId);
    assert.match(snap.tree, /button \[e\d+\]/);
    assert.match(snap.tree, /\[e\d+\].*input/);
    assert.match(snap.tree, /select \[e\d+\]/);
    assert.match(snap.tree, /input type="password" name="pw" filled/);
    assert.match(snap.tree, /input type="text" name="shown" filled/);
    assert.equal(snap.tree.includes("hidden-pw"), false, snap.tree);

    const buttonRef = snap.tree.match(/button \[(e\d+)\]/)?.[1];
    const inputRef = snap.tree.match(/\[(e\d+)\] input/)?.[1];
    const selectRef = snap.tree.match(/select \[(e\d+)\]/)?.[1];
    assert.ok(buttonRef && inputRef && selectRef, snap.tree);

    await driver.type(browserId, tabId, inputRef, "hello");
    await driver.select(browserId, tabId, selectRef, "b");
    await driver.click(browserId, tabId, buttonRef, false);

    const { page } = await driver.resolvePage(browserId, tabId);
    const out = await page.locator("#out").innerText();
    assert.equal(out, "clicked:hello:b");

    const laterHtml = encodeURIComponent(`<!doctype html><html><body>
      <button id="later">Later</button><p id="drawn"></p>
      <script>
        document.getElementById("later").onclick = () => setTimeout(() => {
          document.getElementById("drawn").textContent = "drawn after the click";
        }, 300);
      </script>
    </body></html>`);
    await driver.navigate(browserId, tabId, `data:text/html,${laterHtml}`);
    const laterRef = (await driver.accessibilityTree(browserId, tabId)).tree.match(
      /button \[(e\d+)\]/,
    )?.[1];
    assert.ok(laterRef);
    await driver.click(browserId, tabId, laterRef, true);
    assert.match((await driver.extractText(browserId, tabId)).text, /drawn after the click/);

    const tab2 = await driver.newTab(browserId, "about:blank");
    const tabs = await driver.listTabs(browserId);
    assert.ok(tabs.length >= 2);
    assert.ok(tabs.some((tab) => tab.tab_id === tab2.tab_id));

    const tiny = await driver.accessibilityTree(browserId, tabId, 40);
    assert.equal(tiny.truncated, true);
    assert.ok(Buffer.byteLength(tiny.tree, "utf8") <= 40);

    const nestedHtml = encodeURIComponent(`<!doctype html><html><body>
      <button disabled>Authorize</button>
      <div contenteditable="true" aria-label="Body">hi</div>
      <x-host></x-host>
      <iframe srcdoc="<input type=radio name=q value=a>" width=200 height=80></iframe>
      <div id="keys"></div>
      <script>
        customElements.define("x-host", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow</button>";
            this.shadowRoot.querySelector("button").onclick = () => { document.body.dataset.shadow = "1"; };
          }
        });
        document.addEventListener("keydown", (e) => { document.getElementById("keys").textContent += e.key; });
      </script>
    </body></html>`);
    await driver.navigate(browserId, tabId, `data:text/html,${nestedHtml}`);
    const nested = await driver.accessibilityTree(browserId, tabId);
    const disabledRef = nested.tree.match(/button \[(e\d+)\] disabled/)?.[1];
    const editableRef = nested.tree.match(/textbox \[(e\d+)\] editable/)?.[1];
    const shadowRef = nested.tree.match(/button \[(e\d+)\] "Shadow"/)?.[1];
    const radioRef = nested.tree.match(/frame "about:srcdoc"\n\s+\[(e\d+)\] input type="radio"/)?.[1];
    assert.ok(disabledRef && editableRef && shadowRef && radioRef, nested.tree);

    await assert.rejects(
      () => driver.click(browserId, tabId, disabledRef, false),
      (err: unknown) => (err as { type: string }).type === "disabled",
    );
    await driver.click(browserId, tabId, shadowRef, false);
    assert.equal(await page.evaluate(() => document.body.dataset.shadow), "1");
    await driver.click(browserId, tabId, radioRef, false);
    const radioChecked = await page
      .frames()[1]
      ?.evaluate(() => (document.querySelector("input") as HTMLInputElement).checked);
    assert.equal(radioChecked, true);
    await driver.type(browserId, tabId, editableRef, "typed");
    await driver.pressKey(browserId, tabId, "Escape");
    assert.equal(await page.locator("#keys").innerText(), "Escape");

    await page.evaluate(() => {
      document.body.innerHTML = "<p>rewritten</p>";
    });
    await assert.rejects(
      () => driver.click(browserId, tabId, buttonRef, false),
      (err: unknown) => {
        assert.ok(err && typeof err === "object" && "type" in err);
        assert.equal((err as { type: string }).type, "stale_ref");
        return true;
      },
    );
  } finally {
    driver.drop(browserId);
    await http.delete(`/browsers/${browserId}`, {
      validateStatus: (status) => status < 300 || status === 404,
    });
  }
});

test("integration: upload_file attaches a host file directly and through a file chooser", async (t) => {
  if (!nasUrl) {
    t.skip("NAS_URL not set");
    return;
  }

  const config = testConfig();
  const http = axios.create({
    baseURL: nasUrl,
    timeout: Math.max(config.nas.timeout_ms, 120_000),
    headers: { "content-type": "application/json" },
  });
  const wsBase = nasUrl.replace(/^http/, "ws");
  const created = await http.post("/browsers", {});
  const browserId = created.data.id as number;
  const cdpUrl = String(created.data.cdp_url).replace(/^ws:\/\/[^/]+/, wsBase);

  const hostDir = "/tmp/hath-upload-test";
  const hostPath = `${hostDir}/Resume [v1].txt`;
  const content = "upload integration test\n";
  await http.post("/fs/write", { path: hostPath, content });

  const nas = {
    ...createNasClient(config),
    glob: async (body: { pattern: string; cwd?: string; limit?: number }) => {
      const res = await http.post("/fs/glob", body);
      return res.data;
    },
  };
  const driver = new BrowserDriver(nas, config, silentLog);
  driver.remember(browserId, { cdpUrl, downloadsDir: String(created.data.downloads_dir) });

  try {
    const pageHtml = encodeURIComponent(`<!doctype html><html><body>
      <input id="direct" type="file" />
      <button id="pick" onclick="document.getElementById('hidden').click()">Upload resume</button>
      <input id="hidden" type="file" style="display:none" />
    </body></html>`);
    const nav = await driver.navigate(browserId, undefined, `data:text/html,${pageHtml}`);
    const tabId = nav.tab_id;
    const snap = await driver.accessibilityTree(browserId, tabId);
    const directRef = snap.tree.match(/\[(e\d+)\] input type="file"/)?.[1];
    const pickRef = snap.tree.match(/button \[(e\d+)\] "Upload resume"/)?.[1];
    assert.ok(directRef && pickRef, snap.tree);
    assert.doesNotMatch(snap.tree, /name="hidden"/);

    const direct = await driver.uploadFile(browserId, tabId, directRef, [hostPath]);
    assert.deepEqual(direct.files, [{ name: "Resume [v1].txt", size: Buffer.byteLength(content) }]);

    const chosen = await driver.uploadFile(browserId, tabId, pickRef, [hostPath]);
    assert.deepEqual(chosen.files, [{ name: "Resume [v1].txt", size: Buffer.byteLength(content) }]);

    const { page } = await driver.resolvePage(browserId, tabId);
    const names = await page.evaluate(() =>
      ["direct", "hidden"].map(
        (id) => (document.getElementById(id) as HTMLInputElement).files?.[0]?.name ?? null,
      ),
    );
    assert.deepEqual(names, ["Resume [v1].txt", "Resume [v1].txt"]);

    await assert.rejects(
      () => driver.uploadFile(browserId, tabId, directRef, [`${hostDir}/missing.pdf`]),
      (err: unknown) => {
        assert.equal((err as { type: string }).type, "not_found");
        return true;
      },
    );
  } finally {
    driver.drop(browserId);
    await http.delete(`/browsers/${browserId}`);
  }
});

test("integration: a filled passkey answers WebAuthn after later browser actions and a refill replaces it", async (t) => {
  if (!nasUrl) {
    t.skip("NAS_URL not set");
    return;
  }

  const config = testConfig();
  const http = axios.create({
    baseURL: nasUrl,
    timeout: Math.max(config.nas.timeout_ms, 120_000),
    headers: { "content-type": "application/json" },
  });
  const created = await http.post("/browsers", {});
  const browserId = created.data.id as number;
  const cdpUrl = String(created.data.cdp_url).replace(/^ws:\/\/[^/]+/, nasUrl.replace(/^http/, "ws"));
  const driver = new BrowserDriver(createNasClient(config), config, silentLog);
  driver.remember(browserId, { cdpUrl, downloadsDir: String(created.data.downloads_dir) });

  const rpId = "passkey.dadi.test";
  const passkey = (): { id: string; cred: PasskeyInject } => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialId = randomBytes(16);
    return {
      id: credentialId.toString("base64url"),
      cred: {
        credentialId: credentialId.toString("base64"),
        rpId,
        privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        userHandle: randomBytes(16).toString("base64"),
        signCount: 0,
        resident: true,
      },
    };
  };

  try {
    const opened = await driver.resolvePage(browserId);
    await opened.page.context().route(`https://${rpId}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><button>Sign in</button>" }),
    );
    const { tab_id: tabId } = await driver.navigate(browserId, opened.tabId, `https://${rpId}/`);
    const signIn = async (): Promise<string> => {
      const { page } = await driver.resolvePage(browserId, tabId);
      return page.evaluate(async (rp) => {
        const credential = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: rp,
            userVerification: "required",
            timeout: 10_000,
          },
        });
        return (credential as PublicKeyCredential).id;
      }, rpId);
    };

    const first = passkey();
    await driver.addPasskey(browserId, tabId, first.cred);
    await driver.accessibilityTree(browserId, tabId);
    const other = await driver.newTab(browserId, "about:blank");
    await driver.listTabs(browserId);
    await driver.closeTab(browserId, other.tab_id);
    assert.equal(await signIn(), first.id);

    const second = passkey();
    await driver.addPasskey(browserId, tabId, second.cred);
    await driver.accessibilityTree(browserId, tabId);
    assert.equal(await signIn(), second.id);
  } finally {
    driver.drop(browserId);
    await http.delete(`/browsers/${browserId}`);
  }
});
