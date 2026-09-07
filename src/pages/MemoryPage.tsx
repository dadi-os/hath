import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { MemoryGraph, MemorySearch } from "../features/memory/MemoryGraph";
import { IconBack, IconButton } from "../shared/IconButton";
import { EASE, SLOW_S } from "../shared/motion";
import { Tooltip } from "../shared/Tooltip";

/**
 * Full Memory page: Yaad knowledge graph with recall search.
 */
export function MemoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const entranceKey = `memory:${location.key}`;
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  return (
    <motion.div
      className="relative h-full min-h-0 w-full overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-start gap-3">
        <Tooltip content="Back home">
          <span className="pointer-events-auto inline-flex">
            <IconButton
              label="Back home"
              size="sm"
              onClick={() => navigate("/")}
            >
              <IconBack />
            </IconButton>
          </span>
        </Tooltip>
        <div>
          <span className="text-[11px] font-medium tracking-[2.5px] text-sage-deep">
            MEMORY
          </span>
          <p className="mt-1 text-[11px] text-ink-ghost">
            Scroll to zoom · drag to pan · click a node to expand
          </p>
          <div className="mt-2">
            <MemorySearch
              value={draft}
              onChange={setDraft}
              onSubmit={() => setQuery(draft.trim())}
            />
          </div>
        </div>
      </div>
      <MemoryGraph
        mode="full"
        entranceKey={entranceKey}
        searchQuery={query}
      />
    </motion.div>
  );
}
