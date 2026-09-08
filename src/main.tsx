import React from "react";
import ReactDOM from "react-dom/client";
import { initApi } from "./shared/api";
import { prepareTarget } from "./target";
import "./styles/index.css";

async function boot(): Promise<void> {
  await Promise.all([initApi(), prepareTarget()]);
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
