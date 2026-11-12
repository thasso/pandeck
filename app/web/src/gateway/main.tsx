import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GatewayApp } from "./GatewayApp.tsx";
import "../index.css";

// The gateway's own entry (`gateway.html`, Task-1402): built separately into
// `dist-gateway/` and served by the edge, never by Pandeck's server.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GatewayApp />
  </StrictMode>,
);
