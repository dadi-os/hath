import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { useTarget } from "../hooks/useTarget";
import type { Target } from "../target";

type QrScannerProps = {
  /** Called once with the decoded QR payload. */
  onDecode: (text: string) => void;
  /** Optional switch to paste-code onboarding. */
  onCancel?: () => void;
  /** Fill the parent instead of a fixed max-width card. */
  fill?: boolean;
};

/**
 * Video constraint for the onboarding QR camera.
 * Mobile prefers the rear camera. Desktop must not demand `environment` —
 * Macs have no back camera, and that constraint blocks the webcam and Continuity Camera.
 */
export function qrVideoConstraint(target: Target): MediaTrackConstraints | true {
  if (target === "mobile") {
    return { facingMode: { ideal: "environment" } };
  }
  return true;
}

/** User-facing copy for a getUserMedia failure. */
export function cameraFailureMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied. Allow camera access, or paste the setup code instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera matched. Connect a webcam or Continuity Camera, or paste the setup code instead.";
  }
  if (name === "NotReadableError") {
    return "Camera is in use by another app. Close it, or paste the setup code instead.";
  }
  const detail = err instanceof Error && err.message ? err.message : String(err);
  return `Couldn't open the camera (${detail}). Paste the setup code instead.`;
}

/**
 * Live camera QR reader integrated into the onboarding surface.
 * Stops the MediaStream on unmount / cancel / success.
 */
export function QrScanner({ onDecode, onCancel, fill }: QrScannerProps) {
  const target = useTarget();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDecodeRef = useRef(onDecode);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const decodedRef = useRef(false);

  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    decodedRef.current = false;

    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        stream = null;
      }
    };

    const tick = () => {
      if (cancelled || decodedRef.current) {
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (
        video &&
        canvas &&
        video.readyState === video.HAVE_ENOUGH_DATA &&
        video.videoWidth > 0
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) {
            decodedRef.current = true;
            stop();
            onDecodeRef.current(code.data);
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          "Camera isn’t available on this device. Paste the setup code instead.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: qrVideoConstraint(target),
        });
        if (cancelled) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (!video) {
          stop();
          return;
        }
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        setReady(true);
        raf = requestAnimationFrame(tick);
      } catch (err) {
        if (!cancelled) {
          setError(cameraFailureMessage(err));
        }
        stop();
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [attempt, target]);

  /** Retry getUserMedia after a camera failure. */
  const retry = () => {
    setError(null);
    setReady(false);
    setAttempt((n) => n + 1);
  };

  return (
    <div
      className={`flex flex-col items-center gap-4 ${
        fill ? "h-full w-full" : "w-full max-w-sm"
      }`}
    >
      <div
        className={`relative overflow-hidden rounded-[var(--radius-window)] border border-sage-line bg-ink/10 shadow-[var(--shadow-deep)] ${
          fill ? "min-h-0 w-full flex-1" : "aspect-square w-full"
        }`}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative size-[68%] max-w-[280px]">
            <span className="absolute left-0 top-0 h-8 w-8 rounded-tl-[10px] border-l-2 border-t-2 border-sage" />
            <span className="absolute right-0 top-0 h-8 w-8 rounded-tr-[10px] border-r-2 border-t-2 border-sage" />
            <span className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-[10px] border-b-2 border-l-2 border-sage" />
            <span className="absolute bottom-0 right-0 h-8 w-8 rounded-br-[10px] border-b-2 border-r-2 border-sage" />
          </div>
        </div>

        {!ready && !error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bone/40 backdrop-blur-sm">
            <p className="text-[12px] font-medium tracking-[2px] text-sage-deep">
              OPENING CAMERA…
            </p>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-[13px] text-ink-muted">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="text-[12px] font-medium tracking-[2px] text-sage-deep"
          >
            TRY CAMERA
          </button>
        </div>
      ) : (
        <p className="text-center text-[13px] text-ink-muted">
          Hold the setup QR in the frame — it joins automatically.
        </p>
      )}

      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] font-medium tracking-[2px] text-sage-deep"
        >
          USE CODE INSTEAD
        </button>
      ) : null}
    </div>
  );
}
