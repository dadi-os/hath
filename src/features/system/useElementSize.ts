import { useEffect, useState, type RefObject } from "react";

export type ElementSize = {
  width: number;
  height: number;
};

/**
 * Observe an element's content box. Returns `{ width: 0, height: 0 }` until
 * the first measurement.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const update = (width: number, height: number) => {
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    update(el.clientWidth, el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      update(width, height);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return size;
}
