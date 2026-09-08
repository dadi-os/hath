import QRCode from "qrcode";
import markUrl from "../../../assets/dadi-mark.svg?url";

const SAGE_DEEP = "#5c6b52";
const BONE = "#fafaf7";

export type BrandedQrOptions = {
  /** Pixel size of the square QR (default 280). */
  size?: number;
  /** Center mark diameter as fraction of size (default 0.22). */
  markRatio?: number;
};

/**
 * Render a sage-on-bone QR with the dadi mark composited in the center.
 * Uses high error correction so the logo does not break scans.
 */
export async function renderBrandedQr(
  payload: string,
  opts: BrandedQrOptions = {},
): Promise<string> {
  const size = opts.size ?? 280;
  const markRatio = opts.markRatio ?? 0.22;

  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, payload, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: size,
    color: { dark: SAGE_DEEP, light: BONE },
  });

  const mark = await loadImage(markUrl);
  const markSize = Math.round(size * markRatio);
  const pad = Math.round(markSize * 0.22);
  const box = markSize + pad * 2;
  const x = (size - box) / 2;
  const y = (size - box) / 2;

  const ctx = qrCanvas.getContext("2d");
  if (!ctx) {
    return qrCanvas.toDataURL("image/png");
  }

  // Soft bone plate under the mark so modules stay readable
  ctx.fillStyle = BONE;
  const r = 10;
  roundRect(ctx, x, y, box, box, r);
  ctx.fill();

  // Thin sage rim
  ctx.strokeStyle = "rgba(185, 201, 171, 0.9)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, x + 0.75, y + 0.75, box - 1.5, box - 1.5, r - 1);
  ctx.stroke();

  ctx.drawImage(mark, x + pad, y + pad, markSize, markSize);
  return qrCanvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load QR mark: ${src}`));
    img.src = src;
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
