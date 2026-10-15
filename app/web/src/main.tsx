import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { DialogProvider } from "./components/common/dialogs.tsx";
import { ShortcutsProvider } from "./components/common/shortcuts.tsx";
import { initHistoryNav } from "./lib/historyNav.ts";
import { loadPersistentStore } from "./lib/persistentStore.ts";
import "./index.css";

// Before the first render, because the entry the app loaded on has to be
// counted before anything can navigate off it.
initHistoryNav();

// The boot caches, drafts and remembered positions are read synchronously
// during the first render; this is the one wait that makes that possible.
void loadPersistentStore().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider delay={400}>
        <ShortcutsProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </ShortcutsProvider>
      </TooltipProvider>
    </StrictMode>,
  );
});

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
