import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { IconBack, IconButton } from "../shared/components/IconButton";
import { Tooltip } from "../shared/components/Tooltip";

export type PageHeaderProps = {
  title: string;
  hint: string;
  /** Optional control on the right — same row height as other pages. */
  trailing?: ReactNode;
};

/**
 * Shared sub-header for full pages under AppShell. Same back control, type,
 * hint, and padding on every route — keep actions in `trailing`, not stacked
 * under the title.
 */
export function PageHeader({ title, hint, trailing }: PageHeaderProps) {
  const navigate = useNavigate();

  return (
    <div className="mb-3 flex shrink-0 items-center gap-3 px-1">
      <Tooltip content="Back home">
        <span className="inline-flex">
          <IconButton
            label="Back home"
            size="sm"
            onClick={() => navigate("/")}
          >
            <IconBack />
          </IconButton>
        </span>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
          {title}
        </span>
        <p className="mt-1 text-[11px] text-ink-ghost">{hint}</p>
      </div>
      {trailing ? (
        <div className="pointer-events-auto shrink-0">{trailing}</div>
      ) : null}
    </div>
  );
}
