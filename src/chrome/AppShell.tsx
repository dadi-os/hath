import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { ChatSidebar } from "./ChatSidebar";
import { DisconnectedState } from "./DisconnectedState";
import { Header } from "./Header";
import { connectTransport } from "../store/connection";
import { useConnection } from "../hooks/useConnection";
import { useEvents } from "../hooks/useEvents";
import { useTarget } from "../hooks/useTarget";
import { EASE, SLOW_S } from "../shared/motion";

/**
 * Persistent chrome. Header and chat sidebar mount once and animate in on
 * launch; only the main region (Outlet) swaps on route changes.
 */
export function AppShell() {
  const target = useTarget();
  const { state } = useConnection();
  const location = useLocation();
  const isMobile = target === "mobile";
  const [drawerOpen, setDrawerOpen] = useState(isMobile);
  const [sessionKey, setSessionKey] = useState(0);

  useEvents();

  useEffect(() => {
    void connectTransport();
  }, []);

  useEffect(() => {
    setDrawerOpen(isMobile);
  }, [isMobile]);

  const openChat = () => {
    // sessionKey bumps so ChatSidebar scrolls to bottom; history is not cleared.
    setSessionKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const closeChat = () => {
    setDrawerOpen(false);
  };

  return (
    <div className="flex h-full flex-col bg-bone">
      <motion.div
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: SLOW_S, ease: EASE }}
      >
        <Header />
      </motion.div>

      <div className="relative flex min-h-0 flex-1">
        {!isMobile && (
          <motion.div
            className="w-[min(320px,32%)] shrink-0 p-4 pr-2"
            initial={{ opacity: 0, x: -28 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: SLOW_S, ease: EASE, delay: 0.12 }}
          >
            <ChatSidebar sessionKey={sessionKey} className="h-full" />
          </motion.div>
        )}

        {isMobile && (
          <>
            <motion.button
              type="button"
              onClick={openChat}
              className="absolute left-3 top-3 z-20 text-[11px] font-medium tracking-[2.5px] text-sage-deep"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: SLOW_S, ease: EASE, delay: 0.2 }}
            >
              CHAT
            </motion.button>
            <AnimatePresence>
              {drawerOpen && (
                <>
                  <motion.button
                    type="button"
                    aria-label="Close chat"
                    className="absolute inset-0 z-30 bg-ink/10"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: SLOW_S, ease: EASE }}
                    onClick={closeChat}
                  />
                  <motion.div
                    className="absolute inset-y-0 left-0 z-40 w-[min(100%,340px)] p-3"
                    initial={{ x: "-100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "-100%" }}
                    transition={{ duration: SLOW_S, ease: EASE }}
                  >
                    <ChatSidebar sessionKey={sessionKey} className="h-full" />
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </>
        )}

        <motion.main
          className="min-h-0 min-w-0 flex-1 p-4 pl-2"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: SLOW_S, ease: EASE, delay: 0.2 }}
        >
          <div className="h-full min-h-0 overflow-auto">
            {state === "disconnected" ? (
              <DisconnectedState />
            ) : (
              <div key={location.pathname} className="h-full min-h-0">
                <Outlet />
              </div>
            )}
          </div>
        </motion.main>
      </div>
    </div>
  );
}
