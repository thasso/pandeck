import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  buildReadResponse,
  buildSearchResponse,
  SESSION_READ_MAX_CHARS,
  SESSION_SEARCH_MAX_CHARS,
  type ReadRecordOut,
  type SearchResultOut,
} from "./sessionInspection.ts";

// A worst-case character mix: quotes, backslashes, newlines, and non-BMP
// unicode all expand under JSON string escaping.
const NASTY = '"\\\n\té\u{1f600}';
function bigNasty(n: number): string {
  return NASTY.repeat(Math.ceil(n / NASTY.length)).slice(0, n);
}

function readRecord(
  entryId: string,
  text: string,
  anchor = false,
): ReadRecordOut {
  return {
    entryId,
    role: "assistant",
    blockKind: "text",
    timestamp: "2026-07-13T20:00:00.000Z",
    text,
    textTruncated: false,
    ...(anchor ? { anchor: true } : {}),
  };
}

const metadata = {
  sessionId: "s1",
  title: "t".repeat(200),
  harness: "pi",
  persona: "assistant",
  messageCount: 99,
};

describe("session read budget", () => {
  it("stays at or below the read cap for many escape-heavy records", () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      readRecord(`e${i}`, bigNasty(4000)),
    );
    const { text, details } = buildReadResponse({
      metadata,
      records,
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    assert.ok(text.length <= SESSION_READ_MAX_CHARS, `len=${text.length}`);
    assert.equal((details as any).responseTruncated, true);
  });

  it("retains a centered anchor even when clipping heavily", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      readRecord(`e${i}`, bigNasty(4000), i === 7),
    );
    const { text, details } = buildReadResponse({
      metadata,
      records,
      anchorEntryId: "e7",
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    assert.ok(text.length <= SESSION_READ_MAX_CHARS, `len=${text.length}`);
    assert.equal((details as any).anchorRetained, true);
    assert.ok((details as any).records.some((r: any) => r.entryId === "e7"));
  });

  it("keeps chronological order after dropping edge records", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      readRecord(`e${i}`, bigNasty(4000), i === 10),
    );
    const { details } = buildReadResponse({
      metadata,
      records,
      anchorEntryId: "e10",
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    const ids = (details as any).records.map((r: any) =>
      Number(r.entryId.slice(1)),
    );
    const sorted = [...ids].sort((a, b) => a - b);
    assert.deepEqual(ids, sorted);
  });

  it("clips a single oversized record rather than dropping it", () => {
    const records = [readRecord("only", bigNasty(50_000), true)];
    const { text, details } = buildReadResponse({
      metadata,
      records,
      anchorEntryId: "only",
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    assert.ok(text.length <= SESSION_READ_MAX_CHARS, `len=${text.length}`);
    assert.equal((details as any).records.length, 1);
    assert.equal((details as any).records[0].textTruncated, true);
  });

  it("is byte-identical across repeated identical calls", () => {
    const mk = () =>
      Array.from({ length: 25 }, (_, i) => readRecord(`e${i}`, bigNasty(4000)));
    const a = buildReadResponse({
      metadata,
      records: mk(),
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    const b = buildReadResponse({
      metadata,
      records: mk(),
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    assert.equal(a.text, b.text);
  });

  it("keeps ordinary fixtures materially below the cap", () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      readRecord(`e${i}`, `short message ${i}`),
    );
    const { text } = buildReadResponse({
      metadata,
      records,
      hasMoreBefore: false,
      hasMoreAfter: false,
      warnings: [],
    });
    assert.ok(text.length < SESSION_READ_MAX_CHARS / 2, `len=${text.length}`);
  });
});

function searchResult(entryId: string, excerpt: string): SearchResultOut {
  return {
    entryId,
    role: "assistant",
    blockKind: "text",
    timestamp: "2026-07-13T20:00:00.000Z",
    excerpt,
  };
}

describe("session search budget", () => {
  it("stays at or below the search cap for many excerpts", () => {
    const results = Array.from({ length: 50 }, (_, i) =>
      searchResult(`e${i}`, bigNasty(360)),
    );
    const { text, details } = buildSearchResponse({
      metadata,
      results,
      totalMatches: 200,
      warnings: [],
      guidance: "g",
    });
    assert.ok(text.length <= SESSION_SEARCH_MAX_CHARS, `len=${text.length}`);
    assert.equal((details as any).truncated, true);
  });

  it("clips a single oversized excerpt", () => {
    const results = [searchResult("only", bigNasty(40_000))];
    const { text } = buildSearchResponse({
      metadata,
      results,
      totalMatches: 1,
      warnings: [],
      guidance: "g",
    });
    assert.ok(text.length <= SESSION_SEARCH_MAX_CHARS, `len=${text.length}`);
  });

  it("is byte-identical across repeated identical calls", () => {
    const mk = () =>
      Array.from({ length: 50 }, (_, i) =>
        searchResult(`e${i}`, bigNasty(360)),
      );
    const a = buildSearchResponse({
      metadata,
      results: mk(),
      totalMatches: 200,
      warnings: [],
      guidance: "g",
    });
    const b = buildSearchResponse({
      metadata,
      results: mk(),
      totalMatches: 200,
      warnings: [],
      guidance: "g",
    });
    assert.equal(a.text, b.text);
  });
});
