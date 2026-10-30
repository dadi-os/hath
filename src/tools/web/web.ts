/**
 * Web search and fetch for every agent, without a browser: public pages only, no logins.
 * Both run in Dwar (see dwar inference/web.py) and come back shaped for the prompt: a
 * search is one line per result, a fetch is each page's answer to the agent's question (or
 * its opening, with no question), and every fetched page's whole text is saved to a file
 * (see runtime/files.ts) that read_file pages through or searches by pattern without fetching again.
 */

import { z } from "zod";
import { HathError } from "../../errors.js";
import { resultPath } from "../../runtime/files.js";
import { defineTool } from "../types.js";
import { fail, failWithoutAgentIdentity, type ToolExecResult } from "../shared.js";

/** How much of a page a fetch without a question shows: its opening, to judge whether to read on. */
const PREVIEW_CHARS = 300;

/** Longest per-page answer a fetch shows; the page's answer is a few quotes, never the page. */
const ANSWER_CHARS = 1_200;

const searchInput = z
  .object({
    query: z.string().min(1).max(500),
    max_results: z.number().int().min(1).max(20).optional(),
    allowed_domains: z.array(z.string().min(1)).max(20).optional(),
    blocked_domains: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

const fetchInput = z
  .object({
    urls: z.array(z.string().url()).min(1).max(10),
    question: z.string().min(1).max(2000).optional(),
  })
  .strict();

/** text is a successful result shown as plain text, not JSON, so lines stay lines in the prompt. */
function text(content: string, audit: Record<string, unknown>): ToolExecResult {
  return { content, isError: false, audit };
}

/** clip cuts `text` to `limit` characters on one line, marking the cut. */
function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/** dwarFailure turns a Dwar error into the tool's failed result, keeping its real message. */
function dwarFailure(err: unknown) {
  if (err instanceof HathError) {
    return fail(`${err.type}: ${err.message}`);
  }
  throw err;
}

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the public web (about 1 cent a search). Returns one line per result: title, url, how old the page is, and a few words on what it says about your query. Narrow with allowed_domains or blocked_domains. Read the pages that matter with web_fetch. Anything behind a sign-in, or that needs clicking, forms or several steps, is for steer_browser.",
  input: searchInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "What to search for, as you would type it into a search engine" },
      max_results: { type: "integer", minimum: 1, maximum: 20, description: "How many results to list (default 10)" },
      allowed_domains: { type: "array", items: { type: "string" }, description: "Only these sites, e.g. [\"msu.edu\"]" },
      blocked_domains: { type: "array", items: { type: "string" }, description: "Never these sites" },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    if (parsed.allowed_domains && parsed.blocked_domains) {
      return fail("pass allowed_domains or blocked_domains, not both");
    }
    try {
      const found = await ctx.dwar.webSearch(parsed, `hath/${ctx.callerId}`);
      if (found.results.length === 0) {
        return text(`No results for "${parsed.query}".`, { searches: found.searches });
      }
      const lines = found.results.map((result, index) => {
        const age = result.page_age ? ` (${result.page_age})` : "";
        const about = result.about ? `\n   ${clip(result.about, 220)}` : "";
        return `${index + 1}. ${clip(result.title, 120)} — ${result.url}${age}${about}`;
      });
      return text(`${found.results.length} results for "${parsed.query}"\n${lines.join("\n")}`, { searches: found.searches });
    } catch (err) {
      return dwarFailure(err);
    }
  },
});

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Read up to 10 public web pages at once, as text. With a question, each page is read on its own and you get only its answer, quoted from the page, or \"Not on this page\"; without one, each page's title, size and opening lines. Every page's whole text is saved to a file whose path the result gives: read_file pages through it or finds lines by pattern, without fetching again. Pages behind a sign-in, PDFs that will not load and pages that need a real browser fail with a reason; use steer_browser for those and for anything that needs clicking or forms.",
  input: fetchInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["urls"],
    properties: {
      urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Public http(s) pages to read" },
      question: { type: "string", description: "What you want from these pages; each page answers it on its own" },
    },
  },
  async handler(ctx, parsed) {
    if (ctx.callerId === null) {
      return failWithoutAgentIdentity();
    }
    try {
      const fetched = await ctx.dwar.webFetch(parsed, `hath/${ctx.callerId}`);
      const shown = fetched.pages.map((page, index) => {
        const head = `${index + 1}. ${page.title ? `${clip(page.title, 100)} — ` : ""}${page.final_url}`;
        if (page.error !== null) {
          return `${head}\n   failed: ${page.error}`;
        }
        const size = `${page.text.length} chars`;
        const body =
          parsed.question !== undefined
            ? clip(page.answer ?? "Not on this page.", ANSWER_CHARS)
            : clip(page.text, PREVIEW_CHARS);
        return `${head} · ${size}\n   ${body}`;
      });
      const full = fetched.pages
        .map((page, index) => `=== ${index + 1}. ${page.final_url}${page.title ? ` — ${page.title}` : ""}\n${page.error ?? page.text}`)
        .join("\n\n");
      const read = fetched.pages.filter((page) => page.error === null).length;
      const header = `${read} of ${fetched.pages.length} pages read${parsed.question !== undefined ? `, each answering: ${clip(parsed.question, 160)}` : ""}. their whole text is saved at ${ctx.callId === null ? "(no call)" : resultPath(ctx.files.dir, ctx.callId)}: read_file reads or searches it.`;
      return text(`${header}\n${shown.join("\n")}`, { full, pages: fetched.pages.length });
    } catch (err) {
      return dwarFailure(err);
    }
  },
});
