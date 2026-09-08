import type { MessageAttachment } from "../../api/types";

/** Match Dwar/Dimaag image.describe max. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max files per outbound message. */
export const MAX_ATTACHMENTS = 8;

const EXT_MEDIA: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export type DraftAttachment = MessageAttachment & {
  /** Object URL for image preview chips; revoke on remove/send. */
  previewUrl?: string;
};

/** Read files into draft attachments (base64 + optional image preview URL). */
export async function filesToDraftAttachments(
  files: FileList | File[],
): Promise<DraftAttachment[]> {
  const list = Array.from(files);
  const out: DraftAttachment[] = [];
  for (const file of list) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`);
    }
    const media_type = resolveMediaType(file);
    const data = await readFileAsBase64(file);
    const draft: DraftAttachment = {
      media_type,
      data,
      filename: file.name || undefined,
    };
    if (media_type.startsWith("image/")) {
      draft.previewUrl = URL.createObjectURL(file);
    }
    out.push(draft);
  }
  return out;
}

/** Revoke object URLs created for image preview chips. */
export function revokeDraftPreviews(attachments: DraftAttachment[]): void {
  for (const att of attachments) {
    if (att.previewUrl) {
      URL.revokeObjectURL(att.previewUrl);
    }
  }
}

/** Strip preview URLs for the wire MessageAttachment payload. */
export function toMessageAttachments(
  drafts: DraftAttachment[],
): MessageAttachment[] {
  return drafts.map(({ media_type, data, filename }) => {
    const out: MessageAttachment = { media_type, data };
    if (filename) {
      out.filename = filename;
    }
    return out;
  });
}

function resolveMediaType(file: File): string {
  if (file.type) {
    return file.type;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext && EXT_MEDIA[ext]) {
    return EXT_MEDIA[ext];
  }
  return "application/octet-stream";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`failed to read ${file.name}`));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
