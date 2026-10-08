/**
 * An agent's history summary: what keeps work that scrolled out of its
 * transcript from being forgotten. Before a wake begins, compactHistory checks
 * the messages newer than the summary; once they pass `history_max_chars`, it
 * folds the oldest into the summary in one Dwar complete call, keeping the
 * newest `history_kept_chars` as transcript. The cut only moves forward and in
 * one jump, so the transcript stays byte-stable between folds.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentHistories } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { HathError } from "../errors.js";
import { loadPrompt, transcriptText } from "./context.js";
import type { RuntimeLog } from "./engine.js";
import type { TranscriptStore } from "./transcript.js";

/** How much transcript an agent keeps before its oldest messages fold into its summary. */
export type HistoryLimits = {
  /** A fold starts when the messages newer than the summary pass this many characters. */
  maxChars: number;
  /** A fold keeps the newest messages up to this many characters (always at least the newest). */
  keptChars: number;
};

/** What compactHistory reads and writes. */
export type HistoryDeps = {
  db: Db;
  dwar: DwarClient;
  transcript: TranscriptStore;
  serviceRoot: string;
  limits: HistoryLimits;
  log: RuntimeLog;
};

/**
 * compactHistory folds the agent's oldest unsummarized messages into its
 * summary when they pass the limit, and does nothing otherwise.
 * @throws When Dwar fails or returns no complete summary; the summary is left as it was.
 */
export async function compactHistory(deps: HistoryDeps, agentId: string): Promise<void> {
  const rows = await deps.db
    .select()
    .from(agentHistories)
    .where(eq(agentHistories.agentId, agentId));
  const history = rows[0];
  const summarizedThroughSeq = history?.summarizedThroughSeq ?? 0;
  const texts = deps.transcript
    .transcriptFor(agentId)
    .filter((row) => row.seq > summarizedThroughSeq)
    .map((row) => ({ seq: row.seq, text: transcriptText(row, agentId) }));
  const total = texts.reduce((sum, entry) => sum + entry.text.length, 0);
  if (total <= deps.limits.maxChars) {
    return;
  }

  let kept = 0;
  let cut = texts.length;
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const size = texts[i]!.text.length;
    if (kept > 0 && kept + size > deps.limits.keptChars) {
      break;
    }
    kept += size;
    cut = i;
  }
  const folded = texts.slice(0, cut);
  if (folded.length === 0) {
    return;
  }

  const response = await deps.dwar.complete(
    {
      system: loadPrompt(deps.serviceRoot, "history.md"),
      messages: [
        {
          role: "user",
          content: [
            `Agent: ${agentId}`,
            `<record>\n${history?.summary ?? ""}\n</record>`,
            `<messages>\n${folded.map((entry) => entry.text).join("\n\n")}\n</messages>`,
          ].join("\n\n"),
        },
      ],
      tools: [],
      tool_choice: "auto",
    },
    `hath/${agentId}`,
  );
  if (response.stop_reason !== "end_turn") {
    throw new HathError(
      502,
      "dwar",
      `history summary for ${agentId} stopped with ${response.stop_reason}`,
    );
  }
  const summary = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!summary) {
    throw new HathError(502, "dwar", `history summary for ${agentId} came back empty`);
  }

  const throughSeq = folded.at(-1)!.seq;
  await deps.db
    .insert(agentHistories)
    .values({ agentId, summary, summarizedThroughSeq: throughSeq })
    .onConflictDoUpdate({
      target: agentHistories.agentId,
      set: { summary, summarizedThroughSeq: throughSeq, updatedAt: new Date() },
    });
  deps.log.info(
    {
      agentId,
      foldedMessages: folded.length,
      foldedChars: total - kept,
      keptChars: kept,
      summaryChars: summary.length,
      summarizedThroughSeq: throughSeq,
    },
    "history folded into summary",
  );
}
