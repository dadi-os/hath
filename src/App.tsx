import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./chrome/AppShell";
import { AgentsPage } from "./pages/AgentsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { MemoryPage } from "./pages/MemoryPage";
import { SystemPage } from "./pages/SystemPage";
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
  const allowAgents = target !== "mobile";

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<WidgetGridPage />} />
        {allowAgents ? (
          <Route path="agents" element={<AgentsPage />} />
        ) : (
          <Route path="agents" element={<Navigate to="/" replace />} />
        )}
        <Route path="memory" element={<MemoryPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="system" element={<SystemPage />} />
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
