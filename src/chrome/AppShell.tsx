import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { ChatSidebar } from "./chatSidebar";
import { DisconnectedState } from "./DisconnectedState";
import { Header } from "./Header";
import { MobileChatShell } from "./MobileChatShell";
import { connectTransport } from "../store/connection";
import { useConnection } from "../hooks/useConnection";
import { useEvents } from "../hooks/useEvents";
import { useTarget } from "../hooks/useTarget";
import { EASE, SLOW_S } from "../shared/lib/ux/motion";

/**
 * Persistent chrome. Desktop: bone-glass header + chat rail + widget outlet.
 * Mobile: ChatGPT-style chat-only shell (no widget routes).
 */
export function AppShell() {
  const target = useTarget();
  const { state } = useConnection();
  const location = useLocation();
  const isMobile = target === "mobile";
  const [sessionKey, setSessionKey] = useState(0);

  useEvents();

  useEffect(() => {
    void connectTransport();
  }, []);

  useEffect(() => {
    setSessionKey((k) => k + 1);
  }, [location.pathname]);

  if (isMobile) {
    return <MobileChatShell />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <motion.div
        className="glass-veil z-20 border-b-0 shadow-[var(--shadow)]"
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: SLOW_S, ease: EASE }}
      >
        <Header />
      </motion.div>

      <div className="relative flex min-h-0 flex-1">
        <motion.div
          className="w-[min(340px,34%)] shrink-0 p-4 pr-2"
          initial={{ opacity: 0, x: -28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: 0.12 }}
        >
          <ChatSidebar sessionKey={sessionKey} className="h-full" />
        </motion.div>

        <motion.main
          className="min-h-0 min-w-0 flex-1 overflow-hidden p-4 pl-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: 0.2 }}
        >
          <div className="h-full min-h-0 overflow-hidden">
            {state === "disconnected" ? (
              <DisconnectedState />
            ) : (
              <div
                key={location.pathname}
                className="h-full min-h-0 overflow-hidden"
              >
                <Outlet />
              </div>
            )}
          </div>
        </motion.main>
      </div>
    </div>
  );
}
