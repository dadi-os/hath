import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { nas } from "../../shared/api";
import { FRAME_MS } from "../../shared/lib/ux/poll";

export type BrowserFrameProps = {
  /** Nas browser id whose virtual display to poll. */
  browserId: number;
  className?: string;
  /** `peek` is the tree hover thumbnail; `rail` is the chat overlay. */
  variant: "peek" | "rail";
};

/**
 * View-only virtual-display frames from Nas `GET /browsers/:id/screenshot`.
 * Shows a placeholder until the first frame arrives; react-query keeps the last good blob across refetch errors.
 */
export function BrowserFrame({ browserId, className, variant }: BrowserFrameProps) {
  const query = useQuery({
    queryKey: ["nas", "browsers", browserId, "screenshot"],
    queryFn: () => nas.getBrowserScreenshot(browserId),
    refetchInterval: FRAME_MS,
  });
  const url = useMemo(() => {
    if (!query.data) {
      return null;
    }
    return URL.createObjectURL(query.data);
  }, [query.data]);

  useEffect(() => {
    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [url]);

  const size =
    variant === "peek" ? "h-[96px] w-[170px]" : "h-[132px] w-full";

  return (
    <div
      className={`overflow-hidden rounded-[var(--radius)] border border-dashed border-sage-line bg-bone/80 ${size} ${className ?? ""}`}
    >
      {url ? (
        <img
          src={url}
          alt={`Browser ${browserId}`}
          className="h-full w-full object-cover object-top"
          draggable={false}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-2 text-[11px] tracking-wide text-ink-ghost">
          Browser {browserId}
        </div>
      )}
    </div>
  );
}
