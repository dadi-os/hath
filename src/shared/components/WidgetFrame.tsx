import type { AriaRole, KeyboardEvent, ReactNode } from "react";

export type WidgetFrameProps = {
  title: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  role?: AriaRole;
  tabIndex?: number;
};

/**
 * Widget in a complete dashed frame, with a small nameplate centered on the
 * top edge — a label affixed to the case, not a hole cut in the border.
 */
export function WidgetFrame({
  title,
  children,
  className,
  onClick,
  onKeyDown,
  role,
  tabIndex,
}: WidgetFrameProps) {
  return (
    <div
      role={role}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`widget-frame ${className ?? ""}`}
    >
      <div className="widget-frame__crest">
        <span className="widget-frame__ornament" aria-hidden />
        <span className="widget-frame__title">{title}</span>
        <span className="widget-frame__ornament" aria-hidden />
      </div>
      <div className="widget-frame__body">{children}</div>
    </div>
  );
}
