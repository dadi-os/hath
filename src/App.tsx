import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./chrome/AppShell";
import { AgentsPage } from "./pages/AgentsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { SystemPage } from "./pages/SystemPage";
import { TimelinePage } from "./pages/TimelinePage";
import { WidgetGridPage } from "./pages/WidgetGridPage";
import { useTarget } from "./hooks/useTarget";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  const target = useTarget();
  const isMobile = target === "mobile";

  if (isMobile) {
    return (
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={null} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<WidgetGridPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="timeline" element={<TimelinePage />} />
        <Route path="calendar" element={<Navigate to="/timeline" replace />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="logs" element={<Navigate to="/system" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
