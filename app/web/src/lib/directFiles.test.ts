// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDirectFileText, mintFileGrantUrl } from "./directFiles.ts";

/**
 * The reading half of the served-files client. Both cases here are ones the
 * viewer showed wrongly: an empty document read as a failure, and a UTF-8
 * document read as truncated because its bytes outnumbered its characters.
 */

function respond(
  body: BodyInit | null,
  init: ResponseInit & { headers?: Record<string, string> },
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, init)),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("reading a served file as text", () => {
  it("reads an empty file as an empty document, not an error", async () => {
    // Every range over zero bytes is unsatisfiable, and this always sends one.
    respond(null, { status: 416, headers: { "content-range": "bytes */0" } });
    expect(await fetchDirectFileText("/x/empty.md")).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("does not call a whole UTF-8 file truncated", async () => {
    // 5 characters, 6 bytes: comparing the byte total to `text.length` reported
    // every accented document as cut short.
    const body = "café\n";
    respond(body, {
      status: 206,
      headers: {
        "content-range": `bytes 0-5/${new TextEncoder().encode(body).byteLength}`,
      },
    });
    const answer = await fetchDirectFileText("/x/accented.md");
    expect(answer.text).toBe("café\n");
    expect(answer.truncated).toBe(false);
  });

  it("reports a real truncation and drops the split character", async () => {
    // The window ends mid-character: showing U+FFFD would be showing a byte.
    const bytes = new TextEncoder().encode("café");
    respond(bytes.slice(0, 4), {
      status: 206,
      headers: { "content-range": "bytes 0-3/100" },
    });
    const answer = await fetchDirectFileText("/x/big.md");
    expect(answer.truncated).toBe(true);
    expect(answer.text).toBe("caf");
  });

  it("surfaces a failure to open the file", async () => {
    respond("No such file: /x/gone.md", { status: 404 });
    await expect(fetchDirectFileText("/x/gone.md")).rejects.toThrow(
      /No such file/,
    );
  });

  it("carries the grant deadline back, and defaults it when absent", async () => {
    respond(
      JSON.stringify({
        url: "/api/file-grants/g/page.html",
        delivery: "inline",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const target = {
      kind: "sessionArtifact" as const,
      sessionId: "session-1",
      path: "report/page.html",
    };
    const grant = await mintFileGrantUrl(target);
    expect(grant.url).toContain("/api/file-grants/g/page.html");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/file-grants$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          target,
          scope: "directory",
          delivery: "inline",
        }),
      }),
    );
    expect(grant.delivery).toBe("inline");
    // A server that answered without one still has to renew soon rather than
    // be treated as valid forever.
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("refuses an old response that did not bind the requested delivery", async () => {
    respond(JSON.stringify({ url: "/api/file-grants/old/report.txt" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(
      mintFileGrantUrl(
        { kind: "hostFile", path: "/x/report.txt" },
        undefined,
        "file",
        "attachment",
      ),
    ).rejects.toThrow(/delivery mode/);
  });
});
