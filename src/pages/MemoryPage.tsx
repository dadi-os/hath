import { useState } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "../chrome/PageHeader";
import { MemoryGraph, MemorySearch } from "../features/memory/MemoryGraph";
import { EASE, SLOW_S } from "../shared/motion";

/**
 * Full Memory page: Yaad knowledge graph with recall search.
 */
export function MemoryPage() {
  const location = useLocation();
  const entranceKey = `memory:${location.key}`;
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  return (
    <motion.div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SLOW_S, ease: EASE }}
    >
      <PageHeader
        title="MEMORY"
        hint="Scroll to zoom · drag to pan · click a node to expand"
        trailing={
          <MemorySearch
            value={draft}
            onChange={setDraft}
            onSubmit={() => setQuery(draft.trim())}
          />
        }
      />
      <div className="min-h-0 flex-1 px-1 pb-1">
        <MemoryGraph
          mode="full"
          entranceKey={entranceKey}
          searchQuery={query}
        />
      </div>
    </motion.div>
  );
}
