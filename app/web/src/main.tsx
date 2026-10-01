import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { DialogProvider } from "./components/ui/dialog.tsx";
import { ShortcutsProvider } from "./components/ui/shortcuts.tsx";
import { initHistoryNav } from "./lib/historyNav.ts";
import "./index.css";

// Before the first render, because the entry the app loaded on has to be
// counted before anything can navigate off it.
initHistoryNav();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShortcutsProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ShortcutsProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((err: unknown) => {
        console.warn("Service worker registration failed:", err);
      });
  });
}
