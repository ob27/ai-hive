import { StrictMode } from "react";
import { ToastProvider } from "rebar-ui";
import { createRoot } from "react-dom/client";
import "rebar-ui/style.css";
import "@rebar-ui/theme-clean/theme.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
