import { useEffect, useRef } from "react";
import type { AppSettings } from "@assistant/shared";
import { firstRunNameToSave } from "../lib/firstRun.ts";

/**
 * First run names the assistant (`docs/onboarding.md`): once THIS page saw
 * first run end with a usable account, an unsaved name is saved as Larry
 * through the normal settings write. A saved name is never overwritten, and an
 * install that was never on first run here is never touched.
 *
 * `accountsUsable` is undefined until the accounts have answered. The save
 * waits for `settingsLive` (the server's settings have arrived), because the
 * section is written whole and must not carry client defaults.
 */
export function useFirstRunNaming({
  accountsUsable,
  settingsLive,
  assistant,
  saveSettings,
}: {
  accountsUsable: boolean | undefined;
  settingsLive: boolean;
  assistant: AppSettings["permanentAssistant"];
  saveSettings: (patch: Partial<AppSettings>) => void;
}): void {
  const firstRunSeen = useRef(false);
  useEffect(() => {
    if (accountsUsable === false) {
      firstRunSeen.current = true;
      return;
    }
    if (accountsUsable !== true || !firstRunSeen.current || !settingsLive)
      return;
    firstRunSeen.current = false;
    const name = firstRunNameToSave(assistant.name);
    if (name) saveSettings({ permanentAssistant: { ...assistant, name } });
  }, [accountsUsable, settingsLive, assistant, saveSettings]);
}
