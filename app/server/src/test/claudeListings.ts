/**
 * Claude account model listings for entitlement tests, copied from the
 * measured evidence of Task-1482 (two real accounts' `GET /v1/models` ids).
 * They are model ids only: no account, token or credential.
 * Only types are imported, so a test may load this before it sets `DATA_DIR`.
 */
import type { ClaudeAccountModelsDeps } from "../harnesses/claudeAccountModels.ts";

/** The company account: every id it lists, mythos included. */
export const COMPANY = [
  "claude-mythos-5-2",
  "claude-fable-5-2",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-mythos-5-1",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
] as const;

/** The private account: the company listing without either mythos id. */
export const PRIVATE = COMPANY.filter((id) => !id.startsWith("claude-mythos"));

/** A private account that lacks the newest fable. */
export const Y = PRIVATE.filter((id) => id !== "claude-fable-5-2");

/** A private account that lacks both fable 5.x ids. */
export const Z = PRIVATE.filter(
  (id) => id !== "claude-fable-5-2" && id !== "claude-fable-5-1",
);

/**
 * The reads that leave an account unable to run mythos: a failed read, one
 * that never answers (bounded wait), the gateway off (no read), and a known
 * listing without mythos.
 */
export const MYTHOS_LESS_READS: ReadonlyArray<
  readonly [string, Partial<ClaudeAccountModelsDeps>]
> = [
  [
    "failed",
    {
      read: async () => {
        throw new Error("listing failed");
      },
    },
  ],
  ["timeout", { read: () => new Promise(() => {}), ensureBoundMs: 5 }],
  ["gateway off", { read: async () => undefined }],
  ["private", { read: async () => [...PRIVATE] }],
];
