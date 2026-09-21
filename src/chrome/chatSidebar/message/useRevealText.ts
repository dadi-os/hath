import { useEffect, useRef, useState } from "react";

/**
 * Reveal `text` in a smooth word-paced cadence while `active`.
 *
 * Uses rAF (not chained timeouts), advances on word/newline boundaries when
 * nearby, and never resets when `text` grows — only when `seq` or `active`
 * changes. Backlog-aware so long messages catch up instead of dragging.
 */
export function useRevealText(
  seq: number,
  text: string,
  active: boolean,
): {
  visible: string;
  done: boolean;
} {
  const [visible, setVisible] = useState(() => (active ? "" : text));
  const [done, setDone] = useState(() => !active || text.length === 0);

  const textRef = useRef(text);
  const indexRef = useRef(active ? 0 : text.length);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  textRef.current = text;

  useEffect(() => {
    if (!active) {
      indexRef.current = textRef.current.length;
      setVisible(textRef.current);
      setDone(true);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      indexRef.current = textRef.current.length;
      setVisible(textRef.current);
      setDone(true);
      return;
    }

    indexRef.current = 0;
    lastTsRef.current = 0;
    setVisible("");
    setDone(false);

    const tick = (ts: number) => {
      const full = textRef.current;
      let index = indexRef.current;

      if (full.length === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (index >= full.length) {
        setVisible(full);
        setDone(true);
        return;
      }

      if (lastTsRef.current === 0) {
        lastTsRef.current = ts;
      }

      const backlog = full.length - index;
      const intervalMs =
        backlog > 400 ? 4 : backlog > 160 ? 8 : backlog > 60 ? 12 : 16;
      if (ts - lastTsRef.current < intervalMs) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastTsRef.current = ts;

      const step = nextRevealStep(full, index, backlog);
      index = Math.min(full.length, index + step);
      const slice = full.slice(0, index);
      indexRef.current = index;
      setVisible(slice);
      if (index >= full.length) {
        setDone(true);
      }

      if (index < full.length) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [seq, active]);

  useEffect(() => {
    if (!active) {
      setVisible(text);
      setDone(true);
      return;
    }
    if (done) {
      setVisible(text);
    }
  }, [text, active, done]);

  return { visible, done };
}

/**
 * Prefer a nearby word or line break; otherwise take a small grapheme bite.
 * Large backlogs take bigger strides so the reveal never feels stuck.
 */
function nextRevealStep(full: string, index: number, backlog: number): number {
  if (backlog > 320) {
    return Math.min(backlog, 18);
  }
  if (backlog > 140) {
    return Math.min(backlog, 10);
  }

  const space = full.indexOf(" ", index + 1);
  const nl = full.indexOf("\n", index + 1);
  const limit = 16;

  let best = -1;
  if (space !== -1 && space - index <= limit) {
    best = space + 1;
  }
  if (nl !== -1 && nl - index <= limit) {
    const at = nl + 1;
    if (best === -1 || at < best) {
      best = at;
    }
  }
  if (best !== -1) {
    return best - index;
  }

  return Math.min(backlog, backlog > 40 ? 4 : 2);
}
