/**
 * The retention sweep: the two cache folders under `[files].dir` are rebuilt on demand, so
 * a file in them older than the limit is deleted. `attachments/` is never listed or touched.
 * Nas's filesystem API has no stat or delete, so the sweep lists and removes through a
 * terminal there.
 */

import type { FileStore } from "./files.js";

/** How often the scheduler runs the sweep. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The cache folders under the files dir, and nothing else. */
const CACHE_FOLDERS = ["results", "pdf"] as const;

/** The most a listing or a removal command may print or take. */
const COMMAND_MAX_BYTES = 4_000_000;
const COMMAND_TIMEOUT_SECONDS = 120;

/** How many paths one removal command names. */
const REMOVE_BATCH = 200;

/** quote is `text` as one single-quoted shell word. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * sweepCaches deletes every file in the cache folders last changed before `now` less
 * `retentionDays`, and returns how many it deleted.
 */
export async function sweepCaches(store: FileStore, retentionDays: number, now: Date): Promise<number> {
  const cutoffSeconds = (now.getTime() - retentionDays * 24 * 60 * 60 * 1000) / 1000;
  const terminal = await store.nas.createTerminal(store.dir);
  try {
    const expired: string[] = [];
    for (const folder of CACHE_FOLDERS) {
      const path = `${store.dir}/${folder}`;
      const listing = await store.nas.exec(terminal.id, {
        command: `[ ! -d ${quote(path)} ] || find ${quote(path)} -maxdepth 1 -type f -printf '%T@ %p\\n'`,
        timeout_seconds: COMMAND_TIMEOUT_SECONDS,
        max_bytes: COMMAND_MAX_BYTES,
      });
      if (listing.exit_code !== 0 || listing.timed_out) {
        throw new Error(`listing ${path} failed: exit ${listing.exit_code}, ${listing.output.slice(0, 200)}`);
      }
      const lines = listing.output.split("\n");
      if (listing.truncated) {
        lines.pop();
      }
      for (const line of lines) {
        const space = line.indexOf(" ");
        if (space === -1) {
          continue;
        }
        const changed = Number(line.slice(0, space));
        const file = line.slice(space + 1);
        if (changed < cutoffSeconds && file.startsWith(`${path}/`) && !file.includes("/../")) {
          expired.push(file);
        }
      }
    }
    for (let start = 0; start < expired.length; start += REMOVE_BATCH) {
      const batch = expired.slice(start, start + REMOVE_BATCH);
      const removal = await store.nas.exec(terminal.id, {
        command: `rm -f -- ${batch.map(quote).join(" ")}`,
        timeout_seconds: COMMAND_TIMEOUT_SECONDS,
      });
      if (removal.exit_code !== 0 || removal.timed_out) {
        throw new Error(`removing cache files failed: exit ${removal.exit_code}, ${removal.output.slice(0, 200)}`);
      }
    }
    return expired.length;
  } finally {
    await store.nas.closeTerminal(terminal.id);
  }
}
