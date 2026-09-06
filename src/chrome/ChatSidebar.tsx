import { ROOT_DADI_ID } from "../api/types";

type ChatSidebarProps = {
  /** Bumps when chat is opened so the shell starts a fresh blank Dadi agent. */
  sessionKey: number;
  className?: string;
};

/**
 * Chat chrome shell only — message rendering and send flow land in a later prompt.
 * Opening chat (new sessionKey) always targets a fresh blank root Dadi agent.
 */
export function ChatSidebar({ sessionKey, className }: ChatSidebarProps) {
  // Fresh blank Dadi agent — no resume. sessionKey identity resets the shell.
  const agentId = ROOT_DADI_ID;

  return (
    <aside
      className={`widget-surface flex h-full min-h-0 flex-col overflow-hidden ${className ?? ""}`}
      data-agent-id={agentId}
      data-session-key={sessionKey}
    >
      <div className="border-b border-dashed border-sage-line px-4 py-3">
        <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
          CHAT
        </span>
      </div>

      <div
        key={sessionKey}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {/* Messages render here in a later prompt. Fresh session = empty. */}
      </div>

      <div className="border-t border-dashed border-sage-line p-3">
        <div className="rounded-[var(--radius)] border border-dashed border-sage-line bg-bone px-3 py-2.5 text-[13px] text-ink-ghost">
          Message Dadi…
        </div>
      </div>
    </aside>
  );
}
