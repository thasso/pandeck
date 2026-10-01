import { beforeEach, describe, expect, it, vi } from "vitest";
import { refineText } from "./refineText.ts";

vi.mock("./serverOrigin.ts", () => ({
  serverHttpOrigin: () => "https://assistant.test",
  authHeaders: () => ({ "x-assistant-token": "secret" }),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("refineText", () => {
  it("posts trimmed text and context to the shared refinement endpoint", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ refinedText: "A clearer comment." }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      refineText("  rough comment  ", {
        sessionId: "session-1",
        agentType: "developer",
        includeContext: true,
      }),
    ).resolves.toBe("A clearer comment.");
    expect(fetch).toHaveBeenCalledWith(
      "https://assistant.test/api/prompt/refine",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-token": "secret",
        },
        body: JSON.stringify({
          text: "rough comment",
          sessionId: "session-1",
          agentType: "developer",
          includeContext: true,
        }),
      },
    );
  });

  it("uses the server's error when refinement is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Refinement is unavailable." }, { status: 503 }),
      ),
    );

    await expect(refineText("draft")).rejects.toThrow(
      "Refinement is unavailable.",
    );
  });

  it("rejects an empty refinement response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ refinedText: "   " })),
    );

    await expect(refineText("draft")).rejects.toThrow(
      "Text refinement returned an empty response.",
    );
  });
});
