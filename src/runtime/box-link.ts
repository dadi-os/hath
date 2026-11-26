/**
 * The link a message uses to point at a file or folder on the box: `[name](box://<absolute path>)`.
 * The encoding matches the clients' (Thaali `boxLink.ts`): each path segment is percent-encoded,
 * parentheses included, which would end a Markdown link early.
 */

/** The dadi home on the box, where uploads and scratch files live. */
export const BOX_HOME = "/var/home/dadi";

/** The Inbox folder for uploads made in the month `now` falls in (local time), as `<home>/Inbox/<yyyy-mm>`. */
export function inboxFolder(now: Date): string {
  return `${BOX_HOME}/Inbox/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** encodeSegment is one path segment as a link carries it. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** boxLink is the Markdown link to the file at absolute `path`: its name as the text (brackets escaped) and its `box://` target. */
export function boxLink(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[\\[\]]/g, "\\$&");
  return `[${name}](box://${path.split("/").map(encodeSegment).join("/")})`;
}
