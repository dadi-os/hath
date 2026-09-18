import { useEffect, useState } from "react";

/**
 * Reveal `text` character-by-character while `active` (an incoming agent row).
 * Already-open threads, history, reduced motion, and empty text show immediately.
 */
export function useRevealText(
  seq: number,
  text: string,
  active: boolean,
): {
  visible: string;
  done: boolean;
} {
  const [visible, setVisible] = useState(active ? "" : text);
  const [done, setDone] = useState(!active || text.length === 0);

  useEffect(() => {
    if (!active || text.length === 0) {
      setVisible(text);
      setDone(true);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setVisible(text);
      setDone(true);
      return;
    }

    setVisible("");
    setDone(false);
    let index = 0;
    let frame = 0;

    const tick = () => {
      const remaining = text.length - index;
      const step = remaining > 400 ? 4 : remaining > 120 ? 2 : 1;
      index = Math.min(text.length, index + step);
      setVisible(text.slice(0, index));
      if (index >= text.length) {
        setDone(true);
        return;
      }
      frame = window.setTimeout(tick, 16);
    };

    frame = window.setTimeout(tick, 24);
    return () => {
      window.clearTimeout(frame);
    };
  }, [seq, text, active]);

  return { visible, done };
}
