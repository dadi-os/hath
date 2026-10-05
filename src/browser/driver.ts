/**
 * In-process Playwright CDP connections to Nas-owned Chromium instances.
 * Ephemeral like TranscriptStore — lost on process restart.
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  chromium,
  type Browser,
  type CDPSession,
  type Download,
  type ElementHandle,
  type Locator,
  type Page,
} from "playwright-core";
import type { Config } from "../config.js";
import { HathError } from "../errors.js";
import type { NasClient } from "../nas/client.js";
import type { RuntimeLog } from "../runtime/engine.js";

/** Where Hath reaches a Nas browser, as Nas reports it on spawn and list. */
export type BrowserEndpoint = {
  cdpUrl: string;
  /** Host directory Chromium saves downloads into, under their own file names. */
  downloadsDir: string;
};

type Connection = {
  browser: Browser;
  endpoint: BrowserEndpoint;
};

/** PKCS#8 passkey loaded into a Chromium virtual authenticator. Never log these fields. */
export type PasskeyInject = {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
  resident: boolean;
};

export type TabInfo = {
  tab_id: string;
  url: string;
  title: string;
  focused: boolean;
};

/** A file as the page's file input reports it after an upload. */
export type UploadedFile = {
  name: string;
  size: number;
};

export type SnapshotResult = {
  tree: string;
  truncated: boolean;
  url: string;
};

/** Manage CDP connections and page actions for Nas browsers. */
export class BrowserDriver {
  private readonly connections = new Map<number, Connection>();
  private readonly endpoints = new Map<number, BrowserEndpoint>();
  private readonly pageSessions = new WeakMap<Page, CDPSession>();
  private readonly authenticators = new WeakMap<Page, string>();

  constructor(
    private readonly nas: NasClient,
    private readonly config: Config,
    private readonly log: RuntimeLog,
  ) {}

  /** Cache the endpoint from spawn without connecting yet. */
  remember(browserId: number, endpoint: BrowserEndpoint): void {
    this.endpoints.set(browserId, endpoint);
  }

  drop(browserId: number): void {
    this.endpoints.delete(browserId);
    this.detach(browserId);
  }

  /** Close the Playwright connection but keep the remembered CDP URL for reconnect. */
  private detach(browserId: number): void {
    const conn = this.connections.get(browserId);
    this.connections.delete(browserId);
    if (!conn) {
      return;
    }
    void conn.browser.close().catch((err) => this.logCleanup(err, "browser connection close", `browser ${browserId}`));
  }

  dropAll(): void {
    for (const id of new Set([...this.connections.keys(), ...this.endpoints.keys()])) {
      this.drop(id);
    }
  }

  /**
   * Connect over CDP, or reuse a live connection. Playwright resets Chromium's download
   * behavior to its own temp dir on connect, so every new connection points downloads back
   * at the endpoint's downloads dir before it is cached.
   */
  async connect(browserId: number, endpoint: BrowserEndpoint): Promise<Browser> {
    this.endpoints.set(browserId, endpoint);
    const existing = this.connections.get(browserId);
    if (existing && existing.browser.isConnected()) {
      return existing.browser;
    }
    if (existing) {
      this.connections.delete(browserId);
      void existing.browser.close().catch((err) => this.logCleanup(err, "stale browser connection close", `browser ${browserId}`));
    }
    const browser = await chromium.connectOverCDP(endpoint.cdpUrl);
    try {
      const session = await browser.newBrowserCDPSession();
      try {
        await session.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: endpoint.downloadsDir,
          eventsEnabled: true,
        });
      } finally {
        await session.detach();
      }
    } catch (err) {
      void browser.close().catch((closeErr) => this.logCleanup(closeErr, "browser connection close", `browser ${browserId}`));
      throw err;
    }
    this.connections.set(browserId, { browser, endpoint });
    browser.on("disconnected", () => {
      if (this.connections.get(browserId)?.browser === browser) {
        this.connections.delete(browserId);
      }
    });
    return browser;
  }

  private async resolveEndpoint(browserId: number): Promise<BrowserEndpoint> {
    const remembered = this.endpoints.get(browserId);
    if (remembered) {
      return remembered;
    }
    const cached = this.connections.get(browserId);
    if (cached) {
      return cached.endpoint;
    }
    const list = await this.nas.listBrowsers();
    const found = list.find((b) => b.id === browserId);
    if (!found || !found.cdp_url) {
      throw new HathError(404, "not_found", `browser ${browserId} is not running`);
    }
    const endpoint = { cdpUrl: found.cdp_url, downloadsDir: found.downloads_dir };
    this.endpoints.set(browserId, endpoint);
    return endpoint;
  }

  private async withBrowser<T>(browserId: number, fn: (browser: Browser) => Promise<T>): Promise<T> {
    return fn(await this.attach(browserId));
  }

  /**
   * Connect to a browser through its remembered endpoint. A failed connect retries once,
   * logged, from a fresh Nas lookup, since a restarted browser comes back on a new CDP URL;
   * a browser Nas no longer runs fails with not_found. Errors from the action itself are
   * never retried here, so a click or navigation never runs twice.
   */
  private async attach(browserId: number): Promise<Browser> {
    try {
      return await this.connect(browserId, await this.resolveEndpoint(browserId));
    } catch (err) {
      if (err instanceof HathError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ browser_id: browserId, error: message }, "browser connect failed; retrying from Nas");
      this.drop(browserId);
      return this.connect(browserId, await this.resolveEndpoint(browserId));
    }
  }

  private applyTimeouts(page: Page): void {
    page.setDefaultTimeout(this.config.browser.action_timeout_ms);
    page.setDefaultNavigationTimeout(this.config.browser.navigation_timeout_ms);
  }

  /**
   * The page's CDP session, opened on first use and kept until the page or connection closes.
   * Chromium disables a tab's WebAuthn virtual authenticator when any CDP session on that tab
   * detaches, so page-level CDP work shares this session instead of opening and detaching its own.
   */
  private async pageSession(page: Page): Promise<CDPSession> {
    const kept = this.pageSessions.get(page);
    if (kept) {
      return kept;
    }
    const session = await page.context().newCDPSession(page);
    this.pageSessions.set(page, session);
    return session;
  }

  private async pageTargetId(page: Page): Promise<string> {
    const session = await this.pageSession(page);
    const info = (await session.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    return info.targetInfo.targetId;
  }

  private async targetInfos(browser: Browser): Promise<
    Array<{ targetId: string; type: string; url: string; title: string; attached: boolean }>
  > {
    const session = await browser.newBrowserCDPSession();
    try {
      const result = (await session.send("Target.getTargets")) as {
        targetInfos: Array<{
          targetId: string;
          type: string;
          url: string;
          title: string;
          attached?: boolean;
        }>;
      };
      return result.targetInfos.map((t) => ({
        targetId: t.targetId,
        type: t.type,
        url: t.url,
        title: t.title,
        attached: t.attached === true,
      }));
    } finally {
      await session.detach();
    }
  }

  private async pageMap(browser: Browser): Promise<Map<string, Page>> {
    const map = new Map<string, Page>();
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const id = await this.pageTargetId(page);
        map.set(id, page);
      }
    }
    return map;
  }

  async resolvePage(browserId: number, tabId?: string): Promise<{ page: Page; tabId: string }> {
    return this.withBrowser(browserId, async (browser) => {
      const pages = await this.pageMap(browser);
      if (tabId) {
        const page = pages.get(tabId);
        if (!page) {
          throw new HathError(404, "not_found", `tab ${tabId} not found`);
        }
        this.applyTimeouts(page);
        return { page, tabId };
      }
      const targets = (await this.targetInfos(browser)).filter((t) => t.type === "page");
      const attached = targets.filter((t) => t.attached);
      const preferred = attached[attached.length - 1] ?? targets[targets.length - 1];
      if (!preferred) {
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        this.applyTimeouts(page);
        const id = await this.pageTargetId(page);
        return { page, tabId: id };
      }
      const page = pages.get(preferred.targetId);
      if (!page) {
        throw new HathError(404, "not_found", `tab ${preferred.targetId} not found`);
      }
      this.applyTimeouts(page);
      return { page, tabId: preferred.targetId };
    });
  }

  async listTabs(browserId: number): Promise<TabInfo[]> {
    return this.withBrowser(browserId, async (browser) => {
      const targets = (await this.targetInfos(browser)).filter((t) => t.type === "page");
      const focusedId =
        [...targets].reverse().find((t) => t.attached)?.targetId ??
        targets[targets.length - 1]?.targetId;
      const out: TabInfo[] = [];
      for (const t of targets) {
        out.push({
          tab_id: t.targetId,
          url: t.url,
          title: t.title,
          focused: t.targetId === focusedId,
        });
      }
      return out;
    });
  }

  async newTab(browserId: number, url?: string): Promise<{ tab_id: string }> {
    return this.withBrowser(browserId, async (browser) => {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      this.applyTimeouts(page);
      if (url) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      const tabId = await this.pageTargetId(page);
      return { tab_id: tabId };
    });
  }

  async closeTab(browserId: number, tabId: string): Promise<void> {
    const { page } = await this.resolvePage(browserId, tabId);
    await page.close();
  }

  /**
   * Navigate a tab. A URL that turns into a file download makes Playwright reject the
   * navigation with "Download is starting", sometimes before the page's download event
   * arrives; that resolves with `download` (the suggested file name and the downloads dir
   * it is saving into) once the event is in. Any other navigation failure rejects.
   */
  async navigate(
    browserId: number,
    tabId: string | undefined,
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "load",
  ): Promise<{
    url: string;
    title: string;
    tab_id: string;
    download?: { suggested_filename: string; downloads_dir: string };
  }> {
    const resolved = await this.resolvePage(browserId, tabId);
    let download: Download | undefined;
    const onDownload = (started: Download) => {
      download = started;
    };
    resolved.page.on("download", onDownload);
    try {
      await resolved.page.goto(url, { waitUntil });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("Download is starting"))) {
        throw err;
      }
      download ??= await resolved.page.waitForEvent("download", {
        timeout: this.config.browser.action_timeout_ms,
      });
    } finally {
      resolved.page.off("download", onDownload);
    }
    const base = {
      url: resolved.page.url(),
      title: await resolved.page.title(),
      tab_id: resolved.tabId,
    };
    if (!download) {
      return base;
    }
    const endpoint = await this.resolveEndpoint(browserId);
    return {
      ...base,
      download: { suggested_filename: download.suggestedFilename(), downloads_dir: endpoint.downloadsDir },
    };
  }

  async accessibilityTree(
    browserId: number,
    tabId: string | undefined,
    maxBytes?: number,
  ): Promise<SnapshotResult & { tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const limit = maxBytes ?? this.config.browser.snapshot_max_bytes;
    const main = resolved.page.mainFrame();
    const sections: string[] = [];
    let next = 1;
    for (const frame of resolved.page.frames()) {
      if (frame.isDetached()) {
        continue;
      }
      if (frame !== main && !(await (await frame.frameElement()).isVisible())) {
        continue;
      }
      const snapshot = (await frame.evaluate(`(${SNAPSHOT_SCRIPT})(${next})`)) as {
        lines: string;
        next: number;
      };
      next = snapshot.next;
      if (frame === main) {
        sections.push(snapshot.lines);
      } else if (snapshot.lines) {
        sections.push(`frame ${JSON.stringify(frame.url())}\n${snapshot.lines.replace(/^/gm, "  ")}`);
      }
    }
    const tree =
      "Refs (eN) are valid only until the next accessibility_tree call.\n" + sections.join("\n");
    const truncated = Buffer.byteLength(tree, "utf8") > limit;
    const bounded = truncated ? truncateUtf8(tree, limit) : tree;
    return {
      tree: bounded,
      truncated,
      url: resolved.page.url(),
      tab_id: resolved.tabId,
    };
  }

  /**
   * Find the one element carrying `ref` in any frame of the page. Refs are numbered across
   * frames, and Playwright's CSS engine reaches into open shadow roots.
   */
  private async locatorForRef(page: Page, ref: string): Promise<Locator> {
    const selector = `[data-dadi-ref="${cssEscape(ref)}"]`;
    const matches: Locator[] = [];
    let count = 0;
    for (const frame of page.frames()) {
      if (frame.isDetached()) {
        continue;
      }
      const locator = frame.locator(selector);
      const inFrame = await locator.count();
      if (inFrame > 0) {
        matches.push(locator);
        count += inFrame;
      }
    }
    const [match] = matches;
    if (count !== 1 || !match) {
      throw new HathError(
        409,
        "stale_ref",
        `ref ${ref} resolved to ${count} element(s); take a fresh accessibility_tree`,
      );
    }
    return match;
  }

  async click(browserId: number, tabId: string | undefined, ref: string): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    if (await locator.isDisabled()) {
      throw new HathError(
        409,
        "disabled",
        `ref ${ref} is disabled; clicking it does nothing until the page enables it`,
      );
    }
    await locator.click();
    return { tab_id: resolved.tabId };
  }

  /**
   * Press a key or chord in Playwright key syntax (`Enter`, `Escape`, `Control+Enter`, `l`):
   * on the element at `ref` when given, otherwise on whatever has focus.
   */
  async pressKey(
    browserId: number,
    tabId: string | undefined,
    key: string,
    ref?: string,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    if (ref) {
      const locator = await this.locatorForRef(resolved.page, ref);
      await locator.press(key);
    } else {
      await resolved.page.keyboard.press(key);
    }
    return { tab_id: resolved.tabId };
  }

  async type(
    browserId: number,
    tabId: string | undefined,
    ref: string,
    text: string,
    submit?: boolean,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    await locator.fill(text);
    if (submit) {
      await locator.press("Enter");
    }
    return { tab_id: resolved.tabId };
  }

  async select(
    browserId: number,
    tabId: string | undefined,
    ref: string,
    value: string,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const locator = await this.locatorForRef(resolved.page, ref);
    await locator.selectOption([{ value }, { label: value }]);
    return { tab_id: resolved.tabId };
  }

  /**
   * Attach host files to a file input. Chromium runs on the Nas host and reads `paths` itself
   * over CDP, so they are absolute host paths, never paths inside Hath. A ref on a file input
   * receives the files directly; any other ref is clicked and the file chooser it opens receives
   * them. Resolves with the files as the input reports them after the change.
   */
  async uploadFile(
    browserId: number,
    tabId: string | undefined,
    ref: string,
    paths: readonly string[],
  ): Promise<{ tab_id: string; files: UploadedFile[] }> {
    for (const path of paths) {
      await this.requireHostFile(path);
    }
    const resolved = await this.resolvePage(browserId, tabId);
    const page = resolved.page;
    const locator = await this.locatorForRef(page, ref);
    const isFileInput = await locator.evaluate(
      (el) => el instanceof HTMLInputElement && el.type === "file",
    );
    let input: ElementHandle<HTMLInputElement>;
    if (isFileInput) {
      const handle = await locator.elementHandle();
      if (!handle) {
        throw new HathError(409, "stale_ref", `ref ${ref} is gone; take a fresh accessibility_tree`);
      }
      input = handle as ElementHandle<HTMLInputElement>;
    } else {
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), locator.click()]);
      input = chooser.element() as ElementHandle<HTMLInputElement>;
    }
    const multiple = await input.evaluate((el) => el.multiple);
    if (paths.length > 1 && !multiple) {
      throw new HathError(
        422,
        "invalid_request",
        `the file input behind ${ref} accepts one file; ${paths.length} were given`,
      );
    }

    const marker = randomUUID();
    await input.evaluate((el, value) => el.setAttribute("data-dadi-upload", value), marker);
    const session = await this.pageSession(page);
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-dadi-upload="${marker}"]`,
    });
    if (nodeId === 0) {
      throw new HathError(
        422,
        "invalid_request",
        `the file input behind ${ref} is inside a frame; navigate to the frame's URL and upload there`,
      );
    }
    await session.send("DOM.setFileInputFiles", { files: [...paths], nodeId });

    const files = await input.evaluate((el) => {
      el.removeAttribute("data-dadi-upload");
      return Array.from(el.files ?? []).map((file) => ({
        name: file.name,
        size: file.size,
      }));
    });
    const expected = paths.map((path) => posix.basename(path));
    const attached = files.map((file) => file.name);
    if (
      attached.length !== expected.length ||
      expected.some((name, i) => attached[i] !== name) ||
      files.some((file) => file.size === 0)
    ) {
      throw new HathError(
        502,
        "internal_error",
        `upload did not attach as given: expected ${JSON.stringify(expected)}, input holds ${JSON.stringify(files)}`,
      );
    }
    return { tab_id: resolved.tabId, files };
  }

  /** Fail with not_found unless `path` is an absolute path to an existing file on the Nas host. */
  private async requireHostFile(path: string): Promise<void> {
    const dir = posix.dirname(path);
    const pattern = posix.basename(path).replace(/[\\*?[\]{}]/g, "\\$&");
    const listed = await this.nas.glob({ pattern, cwd: dir, limit: 1 });
    if (listed.paths.length === 0) {
      throw new HathError(404, "not_found", `no file at ${path} on the host`);
    }
  }

  async waitFor(
    browserId: number,
    tabId: string | undefined,
    opts: {
      text?: string;
      ref?: string;
      network_idle?: boolean;
      timeout_ms?: number;
    },
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const timeout = opts.timeout_ms ?? 10_000;
    const page = resolved.page;
    if (opts.text) {
      await page.getByText(opts.text).first().waitFor({ state: "visible", timeout });
    }
    if (opts.ref) {
      const locator = await this.locatorForRef(page, opts.ref);
      await locator.waitFor({ state: "visible", timeout });
    }
    if (opts.network_idle) {
      await page.waitForLoadState("networkidle", { timeout });
    }
    return { tab_id: resolved.tabId };
  }

  async pageScreenshot(
    browserId: number,
    tabId: string | undefined,
    fullPage?: boolean,
  ): Promise<{ png: Buffer; tab_id: string; url: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const png = await resolved.page.screenshot({
      type: "png",
      fullPage: fullPage === true,
    });
    return { png, tab_id: resolved.tabId, url: resolved.page.url() };
  }

  async extractText(
    browserId: number,
    tabId: string | undefined,
    maxBytes?: number,
  ): Promise<{ text: string; truncated: boolean; url: string; tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    const limit = maxBytes ?? this.config.browser.snapshot_max_bytes;
    const raw = await resolved.page.innerText("body");
    const truncated = Buffer.byteLength(raw, "utf8") > limit;
    return {
      text: truncated ? truncateUtf8(raw, limit) : raw,
      truncated,
      url: resolved.page.url(),
      tab_id: resolved.tabId,
    };
  }

  /**
   * Load a passkey into this tab's Chromium virtual authenticator, replacing any passkey an
   * earlier call loaded. The authenticator lives on the page's kept CDP session, so it stays
   * active across later browser actions until the tab or the connection closes.
   * Only WebAuthn requests the page starts after this call can use the passkey.
   */
  async addPasskey(
    browserId: number,
    tabId: string | undefined,
    cred: PasskeyInject,
  ): Promise<{ tab_id: string }> {
    const resolved = await this.resolvePage(browserId, tabId);
    try {
      const session = await this.pageSession(resolved.page);
      const authenticatorId = await this.authenticator(resolved.page, session);
      await cdpSend(session, "WebAuthn.clearCredentials", { authenticatorId });
      await cdpSend(session, "WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: cred.credentialId,
          isResidentCredential: cred.resident,
          rpId: cred.rpId,
          privateKey: cred.privateKey,
          userHandle: cred.userHandle,
          signCount: cred.signCount,
        },
      });
      return { tab_id: resolved.tabId };
    } catch (err) {
      if (err instanceof HathError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "passkey inject failed";
      throw new HathError(502, "internal_error", message);
    }
  }

  /** The page's internal authenticator id, enabling WebAuthn and adding it on first use. */
  private async authenticator(page: Page, session: CDPSession): Promise<string> {
    const kept = this.authenticators.get(page);
    if (kept) {
      return kept;
    }
    await cdpSend(session, "WebAuthn.enable");
    const added = await cdpSend<{ authenticatorId: string }>(
      session,
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    this.authenticators.set(page, added.authenticatorId);
    return added.authenticatorId;
  }

  /** Log a teardown failure on a connection that is being discarded anyway. */
  private logCleanup(err: unknown, what: string, subject: string): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn({ subject, error: message }, `${what} failed`);
  }
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) {
    return s;
  }
  return buf.subarray(0, maxBytes).toString("utf8");
}

/** Send an experimental CDP method; Playwright's protocol typings omit WebAuthn. */
function cdpSend<T>(
  session: CDPSession,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const send = session.send.bind(session) as unknown as (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  return send(method, params);
}

/**
 * Evaluated in each frame with the first ref number to hand out: clear old refs (shadow roots
 * included), walk the visible DOM through open shadow roots and slots, assign data-dadi-ref to
 * interactive nodes, and return the indented text tree with the next free ref number.
 */
const SNAPSHOT_SCRIPT = `(start) => {
  const ROLE_CONTROLS = ["checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "treeitem", "textbox", "searchbox", "combobox", "slider", "spinbutton"];

  function clearRefs(root) {
    root.querySelectorAll("[data-dadi-ref]").forEach((el) => el.removeAttribute("data-dadi-ref"));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) clearRefs(el.shadowRoot);
    });
  }

  clearRefs(document);
  let next = start;
  const lines = [];
  const MIN_TEXT = 2;

  function isHidden(el) {
    if (!(el instanceof Element)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return true;
    }
    if (style.display === "contents") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function assignRef(el) {
    const ref = "e" + next++;
    el.setAttribute("data-dadi-ref", ref);
    return ref;
  }

  function indent(depth) {
    return "  ".repeat(depth);
  }

  function states(el) {
    return (el.disabled === true || el.getAttribute("aria-disabled") === "true" ? " disabled" : "")
      + (el.getAttribute("aria-checked") === "true" ? " checked" : "")
      + (el.getAttribute("aria-selected") === "true" ? " selected" : "");
  }

  function describeInput(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const name = el.getAttribute("name") || el.getAttribute("aria-label") || el.id || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const value = el.value || "";
    const checked = el.checked ? " checked" : "";
    return "input type=" + JSON.stringify(type)
      + (name ? " name=" + JSON.stringify(name) : "")
      + (placeholder ? " placeholder=" + JSON.stringify(placeholder) : "")
      + (value ? " value=" + JSON.stringify(value) : "")
      + checked
      + states(el);
  }

  function walk(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length >= MIN_TEXT) {
        const parent = node.parentElement;
        if (parent && !isHidden(parent) && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
          lines.push(indent(depth) + "text " + JSON.stringify(text));
        }
      }
      return;
    }
    if (!(node instanceof Element)) return;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)) return;
    if (isHidden(node)) return;

    const tag = node.tagName.toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();
    let emitted = false;

    if (/^h[1-6]$/.test(tag) || tag === "main" || tag === "nav" || tag === "header"
        || tag === "footer" || tag === "aside" || tag === "section" || tag === "article"
        || role === "main" || role === "navigation" || role === "banner") {
      const label = (node.getAttribute("aria-label") || node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + tag + (label ? " " + JSON.stringify(label) : ""));
      emitted = true;
    }

    if (tag === "a" || role === "link") {
      const ref = assignRef(node);
      const href = node.getAttribute("href") || "";
      const text = (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + "link [" + ref + "]"
        + (text ? " " + JSON.stringify(text) : "")
        + (href ? " href=" + JSON.stringify(href) : ""));
      emitted = true;
    } else if (tag === "button" || role === "button") {
      const ref = assignRef(node);
      const text = (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + "button [" + ref + "]" + states(node) + (text ? " " + JSON.stringify(text) : ""));
      emitted = true;
    } else if (tag === "input") {
      const ref = assignRef(node);
      lines.push(indent(depth) + "[" + ref + "] " + describeInput(node));
      emitted = true;
    } else if (tag === "textarea") {
      const ref = assignRef(node);
      const name = node.getAttribute("name") || node.getAttribute("aria-label") || "";
      const value = node.value || "";
      lines.push(indent(depth) + "textarea [" + ref + "]" + states(node)
        + (name ? " name=" + JSON.stringify(name) : "")
        + (value ? " value=" + JSON.stringify(value.slice(0, 200)) : ""));
      emitted = true;
    } else if (tag === "select") {
      const ref = assignRef(node);
      const options = Array.from(node.options).map((o) => ({
        value: o.value,
        label: o.label || o.text,
        selected: o.selected,
      }));
      lines.push(indent(depth) + "select [" + ref + "]" + states(node) + " options=" + JSON.stringify(options));
      emitted = true;
    } else if (ROLE_CONTROLS.includes(role)
        || (node.isContentEditable && !(node.parentElement && node.parentElement.isContentEditable))) {
      const ref = assignRef(node);
      const kind = ROLE_CONTROLS.includes(role) ? role : "textbox";
      const text = (node.getAttribute("aria-label") || node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      lines.push(indent(depth) + kind + " [" + ref + "]"
        + (node.isContentEditable ? " editable" : "")
        + states(node)
        + (text ? " " + JSON.stringify(text) : ""));
      emitted = true;
    } else if (tag === "img") {
      const alt = node.getAttribute("alt") || "";
      lines.push(indent(depth) + "img alt=" + JSON.stringify(alt));
      emitted = true;
    }

    const childDepth = emitted ? depth + 1 : depth;
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "img") {
      return;
    }
    let children = node.childNodes;
    if (node.shadowRoot) {
      children = node.shadowRoot.childNodes;
    } else if (tag === "slot" && node.assignedNodes({ flatten: true }).length > 0) {
      children = node.assignedNodes({ flatten: true });
    }
    for (const child of children) {
      walk(child, childDepth);
    }
  }

  if (document.body) {
    walk(document.body, 0);
  }
  return { lines: lines.join("\\n"), next };
}`;
