// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenAiResetCredit } from "@assistant/shared/usage";

/**
 * The redeem dialog's answer to a stale "usable now": the page snapshot can say
 * a window is hit after it has in fact reset, so the first confirmation goes
 * unforced and the server's live guard refuses with 409. That refusal must
 * turn the dialog into the "redeem anyway" one — otherwise every retry is
 * guarded again and the user can only escape by reloading the page.
 */

const sent: { creditId: string; force: boolean }[] = [];
let refuse = true;

vi.mock("../lib/usage.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  redeemOpenAiResetCredit: async (
    creditId: string,
    _profileId?: string,
    options: { force?: boolean } = {},
  ) => {
    sent.push({ creditId, force: options.force === true });
    if (refuse && !options.force) {
      const err = new Error("No reset is applicable right now") as Error & {
        notApplicable?: boolean;
      };
      err.notApplicable = true;
      throw err;
    }
    return {
      ok: true,
      code: "reset",
      windowsReset: 1,
      creditId,
      redeemedAt: null,
    };
  },
}));

const { OpenAiCreditsCard } = await import("./UsagePage.tsx");

const credit: OpenAiResetCredit = {
  id: "RateLimitResetCredit_1",
  status: "available",
  grantedAt: null,
  expiresAt: "2026-10-04T04:21:00Z",
  redeemedAt: null,
  title: "Full reset",
  description: null,
  supportedByPlan: true,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  sent.length = 0;
  refuse = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const button = (label: string): HTMLButtonElement => {
  const match = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!match) throw new Error(`no button "${label}"`);
  return match;
};

it("turns a guarded 409 into the warned 'redeem anyway' confirmation", async () => {
  await act(async () =>
    root.render(
      <OpenAiCreditsCard
        credits={{
          hasCredits: false,
          unlimited: false,
          overageLimitReached: false,
          balance: null,
          approxLocalMessages: null,
          approxCloudMessages: null,
        }}
        // The snapshot still claims one is usable: the first attempt is unforced.
        resetCredits={{
          availableCount: 1,
          applicableCount: 1,
          credits: [credit],
        }}
        now={Date.parse("2026-09-20T18:00:00Z")}
        onReload={async () => {}}
        profileId="openai"
      />,
    ),
  );
  expect(host.textContent).toContain("1 usable now");
  await act(async () => button("Redeem a reset").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Redeem now",
  );
  await act(async () => button("Redeem now").click());
  expect(sent).toEqual([{ creditId: credit.id, force: false }]);

  // Refused: the dialog stays open, warns, and now offers the forced path.
  const dialogText =
    document.querySelector('[role="dialog"]')?.textContent ?? "";
  expect(dialogText).toContain("No reset is applicable right now");
  expect(dialogText).toContain("no limit is hit right now");
  expect(dialogText).not.toContain("usable now");
  await act(async () => button("Redeem anyway").click());
  expect(sent[1]).toEqual({ creditId: credit.id, force: true });
  expect(host.textContent).toContain("Reset applied — 1 window reset.");
});
