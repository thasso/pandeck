// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { useFirstRunNaming } from "./useFirstRunNaming.ts";

const assistant: AppSettings["permanentAssistant"] = {
  name: "Personal Assistant",
  workingDirectory: "/work",
  defaultWorkingDirectory: "/data/assistant",
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  thinkingLevel: "high",
  additionalInstructions: "Be brief.",
};

function Harness(props: Parameters<typeof useFirstRunNaming>[0]) {
  useFirstRunNaming(props);
  return null;
}

/** Renders the accounts going through `steps`, each a re-render. */
function run(
  steps: Array<boolean | undefined>,
  options: { name?: string; settingsLive?: boolean } = {},
) {
  const saveSettings = vi.fn();
  const { render } = mount();
  const current = { ...assistant, name: options.name ?? assistant.name };
  for (const accountsUsable of steps)
    render(
      <Harness
        accountsUsable={accountsUsable}
        settingsLive={options.settingsLive ?? true}
        assistant={current}
        saveSettings={saveSettings}
      />,
    );
  return { saveSettings, current, render };
}

describe("useFirstRunNaming", () => {
  it("leaves an established install's unsaved name alone", () => {
    const { saveSettings } = run([undefined, true, true]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("saves Larry once first run ends with no saved name, keeping the rest of the section", () => {
    const { saveSettings } = run([undefined, false, false, true, true]);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({
      permanentAssistant: { ...assistant, name: "Larry" },
    });
  });

  it("never overwrites a saved custom name", () => {
    const { saveSettings } = run([false, true], { name: "Ada" });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("waits for the server's settings before writing the section", () => {
    const { saveSettings, current, render } = run([false, true], {
      settingsLive: false,
    });
    expect(saveSettings).not.toHaveBeenCalled();
    render(
      <Harness
        accountsUsable
        settingsLive
        assistant={current}
        saveSettings={saveSettings}
      />,
    );
    expect(saveSettings).toHaveBeenCalledWith({
      permanentAssistant: { ...assistant, name: "Larry" },
    });
  });
});
