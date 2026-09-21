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
 * Glass widget panel with a quiet title row — light type over the veil, no
 * heavy chrome, so the frosted frame stays the visual lead.
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
      <header className="widget-frame__chrome">
        <span className="widget-frame__title">{title}</span>
      </header>
      <div className="widget-frame__body">{children}</div>
    </div>
  );
}
