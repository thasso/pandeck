import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppSettings, CredentialProfileSummary } from "@assistant/shared";
import { CredentialProfileCard, ModelsSection } from "./SettingsPage.tsx";

/**
 * Settings is an END-USER surface (`components/CLAUDE.md`), so its pending
 * states say what is happening in plain words and get their motion from
 * `ui/load.tsx` — no hand-rolled spinner, no protocol or token diagnostics
 * leaking into the flow (`app/web/docs/loading-states.md`, Task-361 Phase 3d).
 */

const profile = (
  status: CredentialProfileSummary["status"],
): CredentialProfileSummary => ({
  id: "claude-default",
  name: "Claude personal",
  provider: "claude",
  enabled: true,
  status,
  createdAt: 0,
  updatedAt: 0,
});

function card(status: CredentialProfileSummary["status"]): string {
  return renderToStaticMarkup(
    <CredentialProfileCard
      profile={profile(status)}
      providerLabel="Claude"
      connectionLabel={status === "connecting" ? "Continue login" : "Connect"}
      onToggle={() => {}}
      onConnect={() => {}}
    />,
  );
}

describe("credential profile connection state", () => {
  it("spins the shared glyph while a profile is connecting", () => {
    const html = card("connecting");
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain("Continue login");
  });

  it("shows a still refresh icon when nothing is in flight", () => {
    const html = card("ready");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("Connect");
  });
});

function modelsSection(refreshing: boolean): string {
  return renderToStaticMarkup(
    <ModelsSection
      models={[]}
      settings={{ models: { hidden: [], order: [] } } as unknown as AppSettings}
      onUpdate={() => {}}
      onRefresh={() => {}}
      refreshing={refreshing}
    />,
  );
}

describe("model refresh state", () => {
  /**
   * A refresh that found nothing new answers with a list identical to the one
   * already on screen, so the spinner is the ONLY thing distinguishing a
   * working button from a dead one.
   */
  it("spins and disables the button while a refresh is out", () => {
    const html = modelsSection(true);
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain('aria-busy="true"');
    // The attribute, not the `disabled:` utility classes the button always has.
    expect(html).toContain('disabled=""');
  });

  it("is idle and clickable when no refresh is in flight", () => {
    const html = modelsSection(false);
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Refresh");
  });
});
