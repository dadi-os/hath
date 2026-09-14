import { useEffect, useState } from "react";

/** Seqs that already finished a typewriter reveal this session. */
const revealedSeqs = new Set<number>();

/**
 * Reveal `text` character-by-character once per message seq.
 * Skips when the seq already revealed, reduced-motion is on, or text is empty.
 */
export function useRevealText(seq: number, text: string): {
  visible: string;
  done: boolean;
} {
  const already = revealedSeqs.has(seq);
  const [visible, setVisible] = useState(already ? text : "");
  const [done, setDone] = useState(already || text.length === 0);

  useEffect(() => {
    if (revealedSeqs.has(seq)) {
      setVisible(text);
      setDone(true);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || text.length === 0) {
      revealedSeqs.add(seq);
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
      const step =
        remaining > 400 ? 4 : remaining > 120 ? 2 : 1;
      index = Math.min(text.length, index + step);
      setVisible(text.slice(0, index));
      if (index >= text.length) {
        revealedSeqs.add(seq);
        setDone(true);
        return;
      }
      frame = window.setTimeout(tick, 16);
    };

    frame = window.setTimeout(tick, 24);
    return () => {
      window.clearTimeout(frame);
    };
  }, [seq, text]);

  return { visible, done };
}
