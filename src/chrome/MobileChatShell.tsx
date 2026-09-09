import { useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { ChatSidebar } from "./chatSidebar";
import { DisconnectedState } from "./DisconnectedState";
import { MeshPowerOverlay } from "./MeshPowerOverlay";
import { useConnection } from "../hooks/useConnection";
import { useNeedsProvisioning } from "../hooks/useNeedsProvisioning";
import {
  IconButton,
  IconMenu,
  IconNewChat,
  IconPower,
} from "../shared/components/IconButton";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";
import { getChatState, openList, subscribeChat } from "../store/chat";
import { disconnectTransport } from "../store/connection";
import { usingTsnet } from "../shared/api";

/**
 * Mobile-only shell — ChatGPT-style chat app.
 * Sidebar = previous chats; main = active thread / new chat. No widgets or system pages.
 * Transport bootstrap is owned by AppShell.
 */
export function MobileChatShell() {
  const { state } = useConnection();
  const chat = useSyncExternalStore(subscribeChat, getChatState, getChatState);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const needsProvisioning = useNeedsProvisioning();

  const openAgentId =
    chat.open.kind === "agent" ? chat.open.agentId : null;
  const title =
    openAgentId != null
      ? (chat.conversations.find((c) => c.agent_id === openAgentId)
          ?.agent_name ?? "Chat")
      : chat.open.kind === "provisional"
        ? "New chat"
        : "દાદી";

  const statusLabel =
    state === "connected"
      ? "ONLINE"
      : state === "connecting"
        ? "…"
        : "OFFLINE";

  const startNew = () => {
    openList();
    setDrawerOpen(false);
    setSessionKey((k) => k + 1);
  };

  const showOnboarding = usingTsnet && needsProvisioning;
  const showPower =
    usingTsnet && !needsProvisioning && state !== "connected";

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-transparent">
      <motion.header
        className="glass-veil z-20 flex shrink-0 items-center gap-2 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: SLOW_S, ease: EASE }}
      >
        <IconButton
          label="Open chats"
          size="sm"
          onClick={() => setDrawerOpen(true)}
        >
          <IconMenu />
        </IconButton>

        <div className="min-w-0 flex-1">
          {chat.open.kind === "list" ? (
            <span className="font-gujarati text-[24px] leading-none text-sage-text">
              દાદી
            </span>
          ) : (
            <span className="block truncate text-[15px] font-medium text-ink">
              {title}
            </span>
          )}
        </div>

        <span className="shrink-0 text-[10px] font-medium tracking-[2px] text-ink-ghost">
          {statusLabel}
        </span>

        {state === "connected" ? (
          <IconButton
            label="Leave dadiMesh"
            size="sm"
            onClick={() => {
              void disconnectTransport();
            }}
          >
            <IconPower />
          </IconButton>
        ) : null}
        <IconButton label="New chat" size="sm" onClick={startNew}>
          <IconNewChat />
        </IconButton>
      </motion.header>

      <motion.div
        className="relative min-h-0 flex-1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: SLOW_S, ease: EASE, delay: 0.08 }}
      >
        {showOnboarding ? (
          <div className="h-full p-4">
            <DisconnectedState />
          </div>
        ) : (
          <ChatSidebar
            variant="mobile"
            sessionKey={sessionKey}
            className="h-full"
            drawerOpen={drawerOpen}
            onDrawerClose={() => setDrawerOpen(false)}
            onDrawerOpen={() => setDrawerOpen(true)}
          />
        )}
        {showPower ? <MeshPowerOverlay /> : null}
      </motion.div>
    </div>
  );
}
