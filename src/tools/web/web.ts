/**
 * Web search and fetch for every agent, without a browser: public pages only, no logins.
 * Both run in Dwar (see dwar inference/web.py) and come back shaped for the prompt: a
 * search is one line per result, a fetch is each page's answer to the agent's question (or
 * its opening, with no question), and every fetched page's whole text is stored with the
 * call, where read_result pages through it or searches it by pattern without fetching again.
 */

import { z } from "zod";
import { HathError } from "../../errors.js";
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
    "Search the public web (one search, about 1 cent). Returns one line per result: title, url, how old the page is, and a few words on what it says about your query. Use it for anything public: facts, dates, docs, forums, news, people's public pages. Then read the pages that matter with web_fetch. Narrow with allowed_domains (e.g. [\"msu.edu\"]) or blocked_domains. For anything behind a login or that needs clicking, ask browser-manager for a worker instead.",
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
    "Read up to 10 public web pages at once, in parallel, as text (no logins, no clicking; PDFs and pages that need a browser fail with a reason). With a question, each page is read on its own and you get only its answer, quoted from the page, or \"Not on this page\". Without one, you get each page's title, size and opening lines. Either way every page's whole text is kept: read_result with this call's id pages through it (offset, limit) or finds lines in it (pattern) without fetching again.",
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
      const header = `${read} of ${fetched.pages.length} pages read${parsed.question !== undefined ? `, each answering: ${clip(parsed.question, 160)}` : ""}. read_result on this call reads or searches their whole text.`;
      return text(`${header}\n${shown.join("\n")}`, { full, pages: fetched.pages.length });
    } catch (err) {
      return dwarFailure(err);
    }
  },
});
