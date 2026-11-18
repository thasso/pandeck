/**
 * Machine pools (Task-1424 plan v03 with A1-A3), as units with a fake clock:
 * session keys, reset classification, bench merges, `select`'s pin, move and
 * refusal branches, `observe`'s failover, persistence and restore, the sweep
 * and the per-client cap, and isolation by client, user and provider. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import { LeaseTable } from "./leases.ts";
import {
  MACHINE_SHORT_LIMIT_MS,
  MAX_PINS_PER_CLIENT,
  MachinePool,
  PIN_IDLE_MS,
  RATE_LIMIT_BENCH_MS,
  classifyReset,
  isModelRun,
  parsePinRecord,
  pinKeyOf,
  type MachinePinRecord,
  type MachineSelectOutcome,
  type MachineSelection,
  type PinRef,
} from "./machinePool.ts";
import type { LoginProfile } from "./profiles.ts";
import { openGatewayState } from "./state.ts";

const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const sha = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

function login(id: string, provider: LoginProfile["provider"]): LoginProfile {
  return {
    id,
    provider,
    name: `Fixture ${id}`,
    enabled: true,
    tokenFile: `/tmp/fixture/${id}.json`,
  };
}

/** A pool over fake registry, profile table and vault, with a fake clock. */
function fixture(
  options: {
    accounts?: Record<string, LoginProfile[]>;
    persist?: (records: MachinePinRecord[]) => void;
  } = {},
) {
  const clock = { now: T0 };
  const accounts = options.accounts ?? {
    u1: [
      login("claude-a", "claude"),
      login("claude-b", "claude"),
      login("codex-c", "openai-codex"),
      login("codex-d", "openai-codex"),
    ],
  };
  const profiles = new Map<string, LoginProfile>();
  const owners = new Map<string, string[]>();
  for (const [user, list] of Object.entries(accounts)) {
    owners.set(
      user,
      list.map((profile) => profile.id),
    );
    for (const profile of list) profiles.set(profile.id, { ...profile });
  }
  const needsLogin = new Set<string>();
  const saves: MachinePinRecord[][] = [];
  const logs: string[] = [];
  const leases = new LeaseTable({ now: () => clock.now });
  const make = (): MachinePool =>
    new MachinePool({
      leases,
      accountsOf: (user) => owners.get(user) ?? [],
      profile: (id) => profiles.get(id),
      needsLogin: () => [...needsLogin],
      now: () => clock.now,
      persist:
        options.persist ??
        ((records) => {
          saves.push(structuredClone(records));
        }),
      log: (line) => logs.push(line),
    });
  return {
    clock,
    profiles,
    owners,
    needsLogin,
    saves,
    logs,
    leases,
    pool: make(),
    /** A new pool restored from the last save, as after a restart. */
    restart(): MachinePool {
      const pool = make();
      pool.restore(saves.at(-1) ?? []);
      return pool;
    },
  };
}

function claudeRef(key: string | null, clientId = "client-1"): PinRef {
  return {
    clientId,
    provider: "claude",
    keyHash: key === null ? null : sha(key),
  };
}

function codexRef(key: string | null, clientId = "client-1"): PinRef {
  return {
    clientId,
    provider: "openai-codex",
    keyHash: key === null ? null : sha(key),
  };
}

function served(outcome: MachineSelectOutcome): MachineSelection {
  assert.ok(outcome.ok, `refused: ${JSON.stringify(outcome)}`);
  return outcome.selection;
}

function profileOf(outcome: MachineSelectOutcome): string {
  return served(outcome).binding.profileId;
}

/** Answers a selection's request with `status` and raw headers. */
function answer(
  pool: MachinePool,
  selection: MachineSelection,
  status: number,
  headers: string[] = [],
): void {
  pool.observe(
    {
      provider: selection.pin.provider,
      profileId: selection.binding.profileId,
      selection,
    },
    status,
    headers,
  );
}

const LONG = ["retry-after", "120"];
const SHORT = ["retry-after", "30"];
/** Anthropic's statement that a request hit a subscription limit. */
const REJECTED = ["anthropic-ratelimit-unified-status", "rejected"];
/** Anthropic's stated reset, in epoch seconds. */
const unifiedReset = (at: number): string[] => [
  "anthropic-ratelimit-unified-reset",
  String(at / 1000),
];

describe("session keys", () => {
  test("Claude Code's header keys /anthropic; the hash, never the key, is returned", () => {
    const key = pinKeyOf("claude", ["X-Claude-Code-Session-Id", "abc"]);
    assert.equal(key, sha("abc"));
    assert.equal(pinKeyOf("claude", ["session-id", "abc"]), null);
    assert.equal(pinKeyOf("claude", []), null);
  });

  test("/chatgpt reads session-id, then x-opencode-session-id", () => {
    assert.equal(pinKeyOf("openai-codex", ["session-id", "s"]), sha("s"));
    assert.equal(
      pinKeyOf("openai-codex", ["x-opencode-session-id", "y"]),
      sha("y"),
    );
    assert.equal(
      pinKeyOf("openai-codex", [
        "x-opencode-session-id",
        "y",
        "session-id",
        "s",
      ]),
      sha("s"),
    );
    assert.equal(
      pinKeyOf("openai-codex", ["x-claude-code-session-id", "c"]),
      null,
    );
  });

  test("a repeated, empty or over-256-character first header is no key", () => {
    assert.equal(
      pinKeyOf("claude", [
        "x-claude-code-session-id",
        "a",
        "x-claude-code-session-id",
        "a",
      ]),
      null,
    );
    assert.equal(pinKeyOf("claude", ["x-claude-code-session-id", ""]), null);
    assert.equal(pinKeyOf("claude", ["x-claude-code-session-id", "  "]), null);
    assert.equal(
      pinKeyOf("claude", ["x-claude-code-session-id", "k".repeat(257)]),
      null,
    );
    assert.equal(
      pinKeyOf("claude", ["x-claude-code-session-id", "k".repeat(256)]),
      sha("k".repeat(256)),
    );
    // The first present header decides, even when it is unusable.
    assert.equal(
      pinKeyOf("openai-codex", [
        "session-id",
        "",
        "x-opencode-session-id",
        "y",
      ]),
      null,
    );
  });
});

describe("evidence routes", () => {
  test("only model runs are evidence", () => {
    assert.equal(isModelRun("claude", "POST", "/v1/messages"), true);
    assert.equal(
      isModelRun("claude", "POST", "/v1/messages/count_tokens"),
      false,
    );
    assert.equal(isModelRun("claude", "GET", "/api/oauth/usage"), false);
    assert.equal(isModelRun("claude", "GET", "/v1/messages"), false);
    assert.equal(
      isModelRun("openai-codex", "POST", "/backend-api/codex/responses"),
      true,
    );
    assert.equal(
      isModelRun("openai-codex", "GET", "/backend-api/wham/usage"),
      false,
    );
    assert.equal(
      isModelRun(
        "openai-codex",
        "POST",
        "/backend-api/wham/rate-limit-reset-credits/consume",
      ),
      false,
    );
    assert.equal(isModelRun("openai-codex", "POST", "/v1/messages"), false);
  });
});

describe("reset classification (A3)", () => {
  const now = T0;
  const httpDate = (at: number): string => new Date(at).toUTCString();
  const cases: [
    string,
    LoginProfile["provider"],
    string[],
    boolean,
    number | undefined,
  ][] = [
    ["retry-after: 0", "claude", ["retry-after", "0"], false, undefined],
    [
      "an HTTP-date a second past",
      "claude",
      ["retry-after", httpDate(now - SECOND)],
      false,
      undefined,
    ],
    ["retry-after: 60", "claude", ["retry-after", "60"], false, now + MINUTE],
    [
      "retry-after: 61",
      "claude",
      ["retry-after", "61"],
      true,
      now + 61 * SECOND,
    ],
    [
      "an HTTP-date an hour ahead",
      "claude",
      ["retry-after", httpDate(now + 60 * MINUTE)],
      true,
      now + 60 * MINUTE,
    ],
    [
      "a stated limit with no reset",
      "claude",
      REJECTED,
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "a stated limit with retry-after: abc",
      "claude",
      [...REJECTED, "retry-after", "abc"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "a stated limit with retry-after: -5",
      "claude",
      [...REJECTED, "retry-after", "-5"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "a stated limit with retry-after: 1.5",
      "claude",
      [...REJECTED, "retry-after", "1.5"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "a stated limit with a repeated retry-after",
      "claude",
      [...REJECTED, "retry-after", "10", "Retry-After", "10"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "no reset on /chatgpt",
      "openai-codex",
      [],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "retry-after: abc on /chatgpt",
      "openai-codex",
      ["retry-after", "abc"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "a Codex reset-after of 20 s on /chatgpt",
      "openai-codex",
      ["x-codex-primary-reset-after-seconds", "20"],
      false,
      now + 20 * SECOND,
    ],
    [
      "the same header on /anthropic, with a stated limit",
      "claude",
      [...REJECTED, "x-codex-primary-reset-after-seconds", "20"],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "Anthropic's reset on /chatgpt",
      "openai-codex",
      [...REJECTED, ...unifiedReset(now + 20 * SECOND)],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
    [
      "the latest Codex reset counts",
      "openai-codex",
      [
        "x-codex-primary-reset-after-seconds",
        "20",
        "x-codex-secondary-reset-at",
        String((now + 3600 * SECOND) / 1000),
      ],
      true,
      now + 3600 * SECOND,
    ],
    [
      "a valid retry-after wins over Codex",
      "openai-codex",
      [
        "retry-after",
        "30",
        "x-codex-secondary-reset-at",
        String((now + 3600 * SECOND) / 1000),
      ],
      false,
      now + 30 * SECOND,
    ],
    [
      "an invalid retry-after falls to Codex",
      "openai-codex",
      [
        "retry-after",
        "soon",
        "x-codex-primary-reset-at",
        String(now / 1000 + 600),
      ],
      true,
      now + 600 * SECOND,
    ],
    [
      "a repeated or negative Codex value is skipped",
      "openai-codex",
      [
        "x-codex-primary-reset-after-seconds",
        "5",
        "x-codex-primary-reset-after-seconds",
        "5",
        "x-codex-secondary-reset-after-seconds",
        "-5",
      ],
      true,
      now + RATE_LIMIT_BENCH_MS,
    ],
  ];
  for (const [name, provider, headers, long, benchUntil] of cases)
    test(name, () => {
      assert.deepEqual(classifyReset(provider, headers, now), {
        long,
        benchUntil,
      });
    });

  test("the threshold is 60 s", () => {
    assert.equal(MACHINE_SHORT_LIMIT_MS, 60_000);
  });
});

describe("Anthropic limit evidence (Task-1428)", () => {
  const now = T0;
  const STATUS = "anthropic-ratelimit-unified-status";
  const RESET = "anthropic-ratelimit-unified-reset";
  const weekly = now + 3 * DAY;

  // A 429 on /anthropic states a limit only through the unified status
  // `rejected` or a valid retry-after; anything else is not evidence.
  const notEvidence: [string, string[]][] = [
    ["a bare 429", []],
    ["status allowed", [STATUS, "allowed"]],
    ["status allowed_warning", [STATUS, "allowed_warning"]],
    ["an empty status", [STATUS, ""]],
    ["a repeated status", [STATUS, "rejected", STATUS, "rejected"]],
    ["a reset without a stated limit", [RESET, String(weekly / 1000)]],
    [
      "an allowed status with a reset",
      [STATUS, "allowed", RESET, String(weekly / 1000)],
    ],
    ["retry-after: abc", ["retry-after", "abc"]],
    ["retry-after: -5", ["retry-after", "-5"]],
    ["a repeated retry-after", ["retry-after", "10", "Retry-After", "10"]],
    ["an invalid HTTP-date", ["retry-after", "Tue, 17 Nov 2026 12:00:30 PST"]],
  ];
  for (const [name, headers] of notEvidence)
    test(`${name} is not limit evidence`, () => {
      assert.equal(classifyReset("claude", headers, now), null);
    });

  const stated: [
    string,
    string[],
    { long: boolean; benchUntil: number | undefined },
  ][] = [
    [
      "a weekly reset is long, benched until it",
      [...REJECTED, ...unifiedReset(weekly)],
      { long: true, benchUntil: weekly },
    ],
    [
      "a reset 30 s away is short",
      [...REJECTED, ...unifiedReset(now + 30 * SECOND)],
      { long: false, benchUntil: now + 30 * SECOND },
    ],
    [
      "a reset 60 s away is short (inclusive)",
      [...REJECTED, ...unifiedReset(now + MINUTE)],
      { long: false, benchUntil: now + MINUTE },
    ],
    [
      "a reset 61 s away is long",
      [...REJECTED, ...unifiedReset(now + 61 * SECOND)],
      { long: true, benchUntil: now + 61 * SECOND },
    ],
    [
      "a past reset is short with no bench",
      [...REJECTED, ...unifiedReset(now - SECOND)],
      { long: false, benchUntil: undefined },
    ],
    [
      "a fractional reset is read like Codex's",
      [...REJECTED, RESET, String(now / 1000 + 600.5)],
      { long: true, benchUntil: now + 600_500 },
    ],
    [
      "header names and the status value are case-insensitive, values trimmed",
      [
        "Anthropic-RateLimit-Unified-Status",
        " Rejected ",
        "Anthropic-RateLimit-Unified-Reset",
        ` ${weekly / 1000} `,
      ],
      { long: true, benchUntil: weekly },
    ],
    [
      "a valid retry-after alone states a limit",
      ["retry-after", "120"],
      { long: true, benchUntil: now + 120 * SECOND },
    ],
    [
      "a valid retry-after wins over the unified reset, as over Codex's",
      [...REJECTED, "retry-after", "30", ...unifiedReset(weekly)],
      { long: false, benchUntil: now + 30 * SECOND },
    ],
    [
      "an invalid retry-after falls to the unified reset",
      [...REJECTED, "retry-after", "soon", ...unifiedReset(weekly)],
      { long: true, benchUntil: weekly },
    ],
  ];
  for (const [name, headers, expected] of stated)
    test(`a stated limit: ${name}`, () => {
      assert.deepEqual(classifyReset("claude", headers, now), expected);
    });

  for (const value of [
    "soon",
    "-5",
    "1e9",
    "Infinity",
    "",
    "Tue, 17 Nov 2026 12:00:30 GMT",
  ])
    test(`a stated limit with the unified reset ${JSON.stringify(value)} falls back to the 5 minute bench`, () => {
      assert.deepEqual(
        classifyReset("claude", [...REJECTED, RESET, value], now),
        {
          long: true,
          benchUntil: now + RATE_LIMIT_BENCH_MS,
        },
      );
    });

  test("a repeated unified reset falls back to the 5 minute bench", () => {
    assert.deepEqual(
      classifyReset(
        "claude",
        [...REJECTED, ...unifiedReset(weekly), ...unifiedReset(weekly)],
        now,
      ),
      { long: true, benchUntil: now + RATE_LIMIT_BENCH_MS },
    );
  });

  // A signed-in Claude Code weekly-limit answer as captured (Task-1430
  // evidence, 2026-11-18): retry-after agrees with the unified reset.
  const capturedReset = 1_795_060_800;
  const capturedRetryAfter = 59_120;
  const captured = [
    STATUS,
    "rejected",
    RESET,
    String(capturedReset),
    "retry-after",
    String(capturedRetryAfter),
    "anthropic-ratelimit-unified-representative-claim",
    "seven_day",
    "anthropic-ratelimit-unified-7d-status",
    "rejected",
    "anthropic-ratelimit-unified-5h-status",
    "allowed",
    "x-should-retry",
    "true",
  ];
  const capturedAt = (capturedReset - capturedRetryAfter) * SECOND;

  test("the captured weekly limit is long, benched until its stated reset", () => {
    const expected = { long: true, benchUntil: capturedReset * SECOND };
    assert.deepEqual(classifyReset("claude", captured, capturedAt), expected);
    // The unified reset alone names the same instant.
    const withoutRetryAfter = captured.filter(
      (_, i) => captured[i - (i % 2)] !== "retry-after",
    );
    assert.equal(withoutRetryAfter.length, captured.length - 2);
    assert.deepEqual(
      classifyReset("claude", withoutRetryAfter, capturedAt),
      expected,
    );
  });

  test("the captured weekly limit moves the pin and benches past 5 minutes", () => {
    const f = fixture();
    f.clock.now = capturedAt;
    const ref = claudeRef("X");
    answer(f.pool, served(f.pool.select("u1", ref)), 429, captured);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
    f.clock.now = capturedReset * SECOND - SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N1"))), "claude-b");
    f.clock.now = capturedReset * SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N2"))), "claude-a");
  });

  test("/chatgpt is unchanged: a 429 with no reset is still long", () => {
    assert.deepEqual(classifyReset("openai-codex", [], now), {
      long: true,
      benchUntil: now + RATE_LIMIT_BENCH_MS,
    });
  });

  test("a bare 429 on a pinned session: no bench, no tried mark, no pin move, no save", () => {
    const f = fixture();
    const ref = claudeRef("X");
    const x = served(f.pool.select("u1", ref));
    assert.equal(x.binding.profileId, "claude-a");
    const saved = f.saves.length;
    const before = f.pool.records();
    answer(f.pool, x, 429, []);
    answer(f.pool, x, 429, [STATUS, "allowed"]);
    assert.equal(f.saves.length, saved);
    assert.deepEqual(f.pool.records(), before);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried, []);
    // No bench: a new session still ranks claude-a first.
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-a");
  });

  test("a bare 429 from a stale selection adds nothing to the tried set", () => {
    const f = fixture();
    const ref = claudeRef("X");
    const first = served(f.pool.select("u1", ref));
    answer(f.pool, first, 429, REJECTED);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-b");
    const onB = served(f.pool.select("u1", ref));
    answer(f.pool, onB, 429, []);
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-b");
  });

  test("a bare 429 on the lease path benches nothing and moves no pin", () => {
    const f = fixture();
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, []);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried, []);
  });

  test("a bare 429 neither clears nor shortens an active bench", () => {
    const f = fixture();
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, LONG);
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, []);
    f.clock.now += 119 * SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N1"))), "claude-b");
    f.clock.now += SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N2"))), "claude-a");
  });

  test("a weekly limit benches until its stated reset, not 5 minutes", () => {
    const f = fixture();
    const ref = claudeRef("X");
    answer(f.pool, served(f.pool.select("u1", ref)), 429, [
      ...REJECTED,
      ...unifiedReset(weekly),
    ]);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
    f.clock.now += RATE_LIMIT_BENCH_MS + SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N1"))), "claude-b");
    f.clock.now = weekly - SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N2"))), "claude-b");
    f.clock.now = weekly;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N3"))), "claude-a");
  });

  test("a weekly limit on the lease path moves a pin on its next select", () => {
    const f = fixture();
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, [
      ...REJECTED,
      ...unifiedReset(weekly),
    ]);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
  });

  test("a stated reset 30 s away keeps the pin and the tried set", () => {
    const f = fixture();
    const ref = claudeRef("X");
    const saved = f.saves.length;
    answer(f.pool, served(f.pool.select("u1", ref)), 429, [
      ...REJECTED,
      ...unifiedReset(now + 30 * SECOND),
    ]);
    assert.equal(f.saves.length, saved + 1, "only the new pin's save");
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried, []);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-b");
  });

  test("/chatgpt is unchanged: a 429 with no reset moves the pin", () => {
    const f = fixture();
    const ref = codexRef("X");
    answer(f.pool, served(f.pool.select("u1", ref)), 429, []);
    assert.equal(profileOf(f.pool.select("u1", ref)), "codex-d");
    assert.deepEqual(f.pool.records()[0]!.tried, ["codex-c"]);
  });
});

describe("HTTP-date forms (A3, F001)", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  // The three RFC 9110 forms of the same instant, 30 s after `now`.
  const thirtySeconds = [
    ["IMF-fixdate", "Tue, 17 Nov 2026 12:00:30 GMT"],
    ["RFC 850", "Tuesday, 17-Nov-26 12:00:30 GMT"],
    ["asctime", "Tue Nov 17 12:00:30 2026"],
  ] as const;
  for (const [name, value] of thirtySeconds)
    test(`F001: a 30 s ${name} reset is short, with a 30 s bench`, () => {
      assert.deepEqual(classifyReset("claude", ["retry-after", value], now), {
        long: false,
        benchUntil: now + 30 * SECOND,
      });
    });

  test("F001: asctime pads a one-digit day with a space", () => {
    const sixth = Date.parse("2026-11-06T12:00:00Z");
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Fri Nov  6 12:00:30 2026"],
        sixth,
      ),
      { long: false, benchUntil: sixth + 30 * SECOND },
    );
  });

  test("F001: an RFC 850 two-digit year is the most recent one not more than 50 years ahead", () => {
    // 94 is 1994 here, long past: the reset is elapsed, so short with no bench.
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Sunday, 06-Nov-94 08:49:37 GMT"],
        now,
      ),
      { long: false, benchUntil: undefined },
    );
  });

  // F003: an RFC 850 year is read in the current century unless the full
  // timestamp lies more than 50 years after now, on the UTC calendar.
  const rfc850Cases: [
    string,
    string,
    { long: boolean; benchUntil: number | undefined },
  ][] = [
    [
      "exactly 50 years ahead keeps 2076: a long reset",
      "Tuesday, 17-Nov-76 12:00:00 GMT",
      { long: true, benchUntil: Date.parse("2076-11-17T12:00:00Z") },
    ],
    [
      "one second under the cutoff keeps 2076",
      "Tuesday, 17-Nov-76 11:59:59 GMT",
      { long: true, benchUntil: Date.parse("2076-11-17T11:59:59Z") },
    ],
    [
      "one second past the cutoff is 1976: elapsed",
      "Tuesday, 17-Nov-76 12:00:01 GMT",
      { long: false, benchUntil: undefined },
    ],
    [
      "a day past the cutoff is 1976: elapsed",
      "Wednesday, 18-Nov-76 12:00:00 GMT",
      { long: false, benchUntil: undefined },
    ],
    [
      "an hour past the cutoff day is 1976: elapsed",
      "Tuesday, 17-Nov-76 13:00:00 GMT",
      { long: false, benchUntil: undefined },
    ],
    [
      "a later month of the cutoff year is 1976: elapsed",
      "Tuesday, 01-Dec-76 12:00:00 GMT",
      { long: false, benchUntil: undefined },
    ],
    [
      "an earlier month of the cutoff year keeps 2076",
      "Wednesday, 01-Jan-76 12:00:00 GMT",
      { long: true, benchUntil: Date.parse("2076-01-01T12:00:00Z") },
    ],
  ];
  for (const [name, value, expected] of rfc850Cases)
    test(`F003: RFC 850 ${name}`, () => {
      assert.deepEqual(
        classifyReset("claude", ["retry-after", value], now),
        expected,
      );
    });

  test("F003: a century boundary: 2049 reads 99 as 2099 up to its cutoff, then 1999", () => {
    const century = Date.parse("2049-11-17T12:00:00Z");
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Tuesday, 17-Nov-99 12:00:00 GMT"],
        century,
      ),
      { long: true, benchUntil: Date.parse("2099-11-17T12:00:00Z") },
    );
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Wednesday, 18-Nov-99 12:00:00 GMT"],
        century,
      ),
      { long: false, benchUntil: undefined },
    );
  });

  test("F003: a cutoff from a leap day rolls to 1 March, as the UTC calendar does", () => {
    const leap = Date.parse("2024-02-29T12:00:00Z");
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Thursday, 01-Mar-74 12:00:00 GMT"],
        leap,
      ),
      { long: true, benchUntil: Date.parse("2074-03-01T12:00:00Z") },
    );
    assert.deepEqual(
      classifyReset(
        "claude",
        ["retry-after", "Saturday, 02-Mar-74 12:00:00 GMT"],
        leap,
      ),
      { long: false, benchUntil: undefined },
    );
  });

  test("F003: an elapsed RFC 850 date past the cutoff leaves the pin and tried set unchanged", () => {
    const f = fixture();
    f.clock.now = now;
    const ref = claudeRef("session-key");
    const first = served(f.pool.select("u1", ref));
    const before = f.pool.records();
    answer(f.pool, first, 429, [
      "retry-after",
      "Wednesday, 18-Nov-76 12:00:00 GMT",
    ]);
    assert.deepEqual(f.pool.records(), before);
    assert.equal(profileOf(f.pool.select("u1", ref)), "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried, []);
  });

  test("F001: date forms that are not valid HTTP-dates stay unknown, so a stated limit is long", () => {
    const unknown = { long: true, benchUntil: now + RATE_LIMIT_BENCH_MS };
    for (const value of [
      "Tuesday, 17-Nov-26 12:00:30 PST",
      "Tuesday, 17-Nov-26 12:00:30.5 GMT",
      "Tue, 17 Nov 2026 12:00:30",
      "17 Nov 2026 12:00:30 GMT",
      "Tue Nov 31 12:00:30 2026",
      "Tue Nov 17 24:00:30 2026",
      "Tue Nov 17 12:00:30 2026 GMT",
      "Tue Nov 17 12:00:30 26",
      "1e3",
      "Infinity",
      "NaN",
      "2026-11-17T12:00:30Z",
    ])
      assert.deepEqual(
        classifyReset("claude", [...REJECTED, "retry-after", value], now),
        unknown,
        value,
      );
    const rfc850 = "Tuesday, 17-Nov-26 12:00:30 GMT";
    assert.deepEqual(
      classifyReset(
        "claude",
        [...REJECTED, "retry-after", rfc850, "Retry-After", rfc850],
        now,
      ),
      unknown,
      "a repeated obsolete date",
    );
  });

  for (const [name, value] of [
    ["RFC 850", "Tuesday, 17-Nov-26 12:00:30 GMT"],
    ["asctime", "Tue Nov 17 12:00:30 2026"],
  ] as const)
    test(`F001: a valid ${name} 30 s reset keeps the pin and leaves the tried set unchanged`, () => {
      const f = fixture();
      f.clock.now = now;
      const ref = claudeRef("session-key");
      const first = served(f.pool.select("u1", ref));
      assert.equal(first.binding.profileId, "claude-a");
      answer(f.pool, first, 429, ["retry-after", value]);
      assert.equal(profileOf(f.pool.select("u1", ref)), "claude-a");
      assert.equal(f.pool.records()[0]!.profileId, "claude-a");
      assert.deepEqual(f.pool.records()[0]!.tried, []);
    });
});

describe("select", () => {
  test("a new session pins the best eligible account; its requests stay there on one machine lease", () => {
    const f = fixture();
    const first = served(f.pool.select("u1", claudeRef("X")));
    assert.equal(first.binding.profileId, "claude-a");
    assert.equal(first.binding.tokenFile, "/tmp/fixture/claude-a.json");
    const record = f.leases.records().find((r) => r.leaseId === first.leaseId)!;
    assert.equal(record.kind, "machine");
    assert.deepEqual(record.owner, { clientId: "client-1" });
    const again = served(f.pool.select("u1", claudeRef("X")));
    assert.equal(again.binding.profileId, "claude-a");
    assert.equal(again.leaseId, first.leaseId);
    // Another session shares the client's machine lease on that profile.
    assert.equal(
      served(f.pool.select("u1", claudeRef("Y"))).leaseId,
      first.leaseId,
    );
    assert.equal(f.leases.records().length, 1);
  });

  test("keyless requests share the client's per-provider pin", () => {
    const f = fixture();
    const first = profileOf(f.pool.select("u1", claudeRef(null)));
    answer(f.pool, served(f.pool.select("u1", claudeRef(null))), 429, LONG);
    assert.notEqual(profileOf(f.pool.select("u1", claudeRef(null))), first);
  });

  test("AC5: a new session avoids a benched account while the bench lasts", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", claudeRef("X")));
    answer(f.pool, x, 429, SHORT);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-b");
    f.clock.now += 31 * SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Z"))), "claude-a");
  });

  test("AC8: with every usable account benched, a new session still gets the best one", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", claudeRef("X")));
    answer(f.pool, x, 429, LONG);
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-a");
  });

  test("AC8: no usable account of the provider is machine-pool-empty; the other provider is unaffected", () => {
    const f = fixture({
      accounts: {
        u1: [login("claude-a", "claude"), login("claude-b", "claude")],
      },
    });
    assert.deepEqual(f.pool.select("u1", codexRef("X")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    f.needsLogin.add("claude-a").add("claude-b");
    assert.deepEqual(f.pool.select("u1", claudeRef("Y")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
    f.needsLogin.clear();
    for (const profile of f.profiles.values()) profile.enabled = false;
    assert.deepEqual(f.pool.select("u1", claudeRef("Y")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
    assert.equal(f.leases.records().length, 1);
  });

  test("a profile on the edge that the user does not own is never usable", () => {
    const f = fixture({
      accounts: {
        u1: [login("claude-a", "claude")],
        u2: [login("claude-z", "claude")],
      },
    });
    f.owners.set("u1", ["claude-a"]);
    f.profiles.get("claude-a")!.enabled = false;
    assert.deepEqual(f.pool.select("u1", claudeRef("X")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
  });
});

describe("observe and stickiness (A2, A3)", () => {
  test("AC6c: a short 429 keeps the pin and the tried set, with no save", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", claudeRef("X")));
    const saved = f.saves.length;
    answer(f.pool, x, 429, SHORT);
    assert.equal(f.saves.length, saved);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried, []);
  });

  test("AC6c: retry-after: 0 keeps the pin and benches nothing", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", claudeRef("X")));
    answer(f.pool, x, 429, ["retry-after", "0"]);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    // No live bench: a new session still ranks claude-a first.
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-a");
  });

  test("AC6c: a Codex reset 20 s away on /chatgpt keeps the pin", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", codexRef("X")));
    answer(f.pool, x, 429, ["x-codex-primary-reset-after-seconds", "20"]);
    assert.equal(profileOf(f.pool.select("u1", codexRef("X"))), "codex-c");
  });

  for (const [name, headers] of [
    ["retry-after: 61", ["retry-after", "61"]],
    ["a stated limit with no reset", REJECTED],
    [
      "a stated limit with a weekly reset",
      [...REJECTED, ...unifiedReset(T0 + 3 * DAY)],
    ],
  ] as const)
    test(`AC6c: ${name} moves the pin at once and saves the tried set`, () => {
      const f = fixture();
      const x = served(f.pool.select("u1", claudeRef("X")));
      const saved = f.saves.length;
      answer(f.pool, x, 429, [...headers]);
      assert.equal(f.saves.length, saved + 1);
      assert.deepEqual(f.saves.at(-1), [
        {
          clientId: "client-1",
          provider: "claude",
          keyHash: sha("X"),
          profileId: "claude-b",
          tried: ["claude-a"],
          lastUsedAt: T0,
        },
      ]);
      assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    });

  test("AC6(b)-(d), (f), (g): nothing after a long-limit move sends the session back", () => {
    const f = fixture();
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    // (d), (g) while A is benched another session lands on B; then a 2xx on
    // A, from any session or lease, clears A's bench: X stays on B.
    const y = served(f.pool.select("u1", claudeRef("Y")));
    assert.equal(y.binding.profileId, "claude-b");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 200, []);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    // (b) a restart keeps the move.
    const pool = f.restart();
    assert.equal(profileOf(pool.select("u1", claudeRef("X"))), "claude-b");
    // (c), (f) A's bench is over and A ranks first: X stays on B.
    f.clock.now += 10 * MINUTE;
    for (let i = 0; i < 10; i++)
      assert.equal(profileOf(pool.select("u1", claudeRef("X"))), "claude-b");
    // A new session ranks A first again.
    assert.equal(profileOf(pool.select("u1", claudeRef("Z"))), "claude-a");
  });

  test("AC6(e): with every eligible account tried, a long 429 keeps the pin, which joins the tried set, across a restart", () => {
    const f = fixture();
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    const onB = served(f.pool.select("u1", claudeRef("X")));
    answer(f.pool, onB, 200);
    answer(f.pool, onB, 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried.sort(), [
      "claude-a",
      "claude-b",
    ]);
    // A's bench ends; X still never returns to A while B is usable.
    f.clock.now += 10 * MINUTE;
    const pool = f.restart();
    assert.equal(profileOf(pool.select("u1", claudeRef("X"))), "claude-b");
  });

  test("a long 429 from a stale selection only adds that account to the tried set", () => {
    const f = fixture({
      accounts: {
        u1: [
          login("claude-a", "claude"),
          login("claude-b", "claude"),
          login("claude-c", "claude"),
        ],
      },
    });
    const first = served(f.pool.select("u1", claudeRef("X")));
    answer(f.pool, first, 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    // A second request that was already on A answers late.
    answer(f.pool, first, 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
  });

  test("A3: a short 429 during another session's long bench doesn't move in observe, but the next select does", () => {
    const f = fixture({
      accounts: {
        u1: [
          login("claude-a", "claude"),
          login("claude-b", "claude"),
          login("claude-c", "claude"),
        ],
      },
    });
    const x = served(f.pool.select("u1", claudeRef("X")));
    const y = served(f.pool.select("u1", claudeRef("Y")));
    assert.equal(y.binding.profileId, "claude-a");
    answer(f.pool, x, 429, LONG);
    const saved = f.saves.length;
    answer(f.pool, y, 429, SHORT);
    assert.equal(f.saves.length, saved);
    assert.equal(
      f.pool.records().find((r) => r.keyHash === sha("Y"))!.profileId,
      "claude-a",
    );
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-b");
  });

  test("A2: a long bench from the lease path moves a pin; a short one never does", () => {
    const f = fixture();
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, SHORT);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    assert.deepEqual(f.pool.records()[0]!.tried, ["claude-a"]);
  });

  test("bench merge: the later end wins and long is sticky, in both orders; an elapsed reset changes nothing", () => {
    for (const order of [
      [LONG, SHORT],
      [SHORT, LONG],
    ]) {
      const f = fixture();
      assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
      for (const headers of order)
        f.pool.observe(
          { provider: "claude", profileId: "claude-a" },
          429,
          headers,
        );
      f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, [
        "retry-after",
        "0",
      ]);
      // Long: the pin moves; the bench lasts to the later end, 120 s.
      assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
      f.clock.now += 119 * SECOND;
      assert.equal(profileOf(f.pool.select("u1", claudeRef("N1"))), "claude-b");
      f.clock.now += SECOND;
      assert.equal(profileOf(f.pool.select("u1", claudeRef("N2"))), "claude-a");
    }
  });

  test("a later 429 never shortens an active bench", () => {
    const f = fixture();
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, [
      "retry-after",
      "50",
    ]);
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, [
      "retry-after",
      "10",
    ]);
    f.clock.now += 49 * SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N"))), "claude-b");
  });

  test("a 2xx clears a bench; other statuses change nothing", () => {
    const f = fixture();
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, LONG);
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 500, []);
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 401, []);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N1"))), "claude-b");
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 201, []);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("N2"))), "claude-a");
  });
});

describe("forced moves (A1)", () => {
  for (const [name, change] of [
    [
      "removed",
      (f: ReturnType<typeof fixture>) => f.profiles.delete("claude-a"),
    ],
    [
      "disabled",
      (f: ReturnType<typeof fixture>) =>
        (f.profiles.get("claude-a")!.enabled = false),
    ],
    [
      "needs a login",
      (f: ReturnType<typeof fixture>) => f.needsLogin.add("claude-a"),
    ],
    [
      "no longer the user's",
      (f: ReturnType<typeof fixture>) => f.owners.set("u1", ["claude-b"]),
    ],
  ] as const)
    test(`AC7: a pin whose account is ${name} moves, and the old account joins the tried set`, () => {
      const f = fixture();
      assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
      change(f);
      assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
      assert.deepEqual(f.saves.at(-1)![0]!.tried, ["claude-a"]);
    });

  test("AC6b: after a long 429 and a move, B unusable returns X to A once A's bench ended; A stays tried", () => {
    const f = fixture();
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 200);
    f.clock.now += 3 * MINUTE;
    f.profiles.get("claude-b")!.enabled = false;
    const back = served(f.pool.select("u1", claudeRef("X")));
    assert.equal(back.binding.profileId, "claude-a");
    assert.deepEqual(f.pool.records()[0]!.tried.sort(), [
      "claude-a",
      "claude-b",
    ]);
    // B is back, but tried: a long 429 on A keeps X on A.
    f.profiles.get("claude-b")!.enabled = true;
    answer(f.pool, back, 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    // A new session in the same state gets B, which is eligible.
    assert.equal(profileOf(f.pool.select("u1", claudeRef("Y"))), "claude-b");
  });

  test("AC6b: with the only other account tried and benched, X gets machine-session-limited until the bench ends, also across a restart", () => {
    const f = fixture();
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    f.clock.now += 100 * SECOND + 400;
    f.profiles.get("claude-b")!.enabled = false;
    const leases = f.leases.records().length;
    assert.deepEqual(f.pool.select("u1", claudeRef("X")), {
      ok: false,
      refusal: "machine-session-limited",
      retryAfterSeconds: 20,
    });
    // The pin stays and no lease was granted.
    assert.equal(f.pool.records()[0]!.profileId, "claude-b");
    assert.equal(f.leases.records().length, leases);
    // A's bench ends: X returns to A.
    f.clock.now += 20 * SECOND;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    // After a restart, B usable again: the pin is on A and stays.
    f.profiles.get("claude-b")!.enabled = true;
    assert.equal(
      profileOf(f.restart().select("u1", claudeRef("X"))),
      "claude-a",
    );
  });

  test("AC6b: a restart forgets A's bench, so the return happens at once", () => {
    const f = fixture();
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    const pool = f.restart();
    f.profiles.get("claude-b")!.enabled = false;
    assert.equal(profileOf(pool.select("u1", claudeRef("X"))), "claude-a");
  });

  test("the five-step order: eligible untried, eligible tried, usable untried, limited, empty", () => {
    const accounts = {
      u1: ["a", "b", "c", "d"].map((id) => login(`claude-${id}`, "claude")),
    };
    // X tried a (long 429), now on b.
    const f = fixture({ accounts });
    answer(f.pool, served(f.pool.select("u1", claudeRef("X"))), 429, LONG);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    f.clock.now += 10 * MINUTE;
    // 1. b unusable: c (untried, eligible) beats a (tried, eligible).
    f.profiles.get("claude-b")!.enabled = false;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-c");
    // 2. c unusable, d benched: a (tried, eligible) beats d (untried, benched).
    f.pool.observe({ provider: "claude", profileId: "claude-d" }, 429, LONG);
    f.profiles.get("claude-c")!.enabled = false;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-a");
    // 3. a unusable, everything else tried or gone but d: d though benched.
    f.profiles.get("claude-a")!.enabled = false;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-d");
    // 4. d unusable, a back but benched (tried): limited.
    f.profiles.get("claude-a")!.enabled = true;
    f.pool.observe({ provider: "claude", profileId: "claude-a" }, 429, LONG);
    f.profiles.get("claude-d")!.enabled = false;
    const limited = f.pool.select("u1", claudeRef("X"));
    assert.equal(limited.ok, false);
    assert.equal(!limited.ok && limited.refusal, "machine-session-limited");
    assert.equal(f.pool.records()[0]!.profileId, "claude-d");
    // 5. nothing usable: empty, the pin unchanged.
    f.profiles.get("claude-a")!.enabled = false;
    assert.deepEqual(f.pool.select("u1", claudeRef("X")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
    assert.equal(f.pool.records()[0]!.profileId, "claude-d");
    // The pinned account usable again: served there.
    f.profiles.get("claude-d")!.enabled = true;
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-d");
  });
});

describe("final validation", () => {
  test("a selection stops holding when its lease ends, its pin moves or its account becomes unusable", () => {
    const f = fixture();
    const x = served(f.pool.select("u1", claudeRef("X")));
    assert.equal(f.pool.isCurrent(x), true);
    f.needsLogin.add("claude-a");
    assert.equal(f.pool.isCurrent(x), false);
    f.needsLogin.clear();
    assert.equal(f.pool.isCurrent(x), true);
    f.leases.revoke(x.leaseId, "profile-removed");
    assert.equal(f.pool.isCurrent(x), false);

    const g = fixture();
    const y = served(g.pool.select("u1", claudeRef("Y")));
    answer(g.pool, y, 429, LONG);
    assert.equal(g.pool.isCurrent(y), false);
    assert.equal(
      g.pool.isCurrent(served(g.pool.select("u1", claudeRef("Y")))),
      true,
    );
  });
});

describe("isolation (AC17)", () => {
  test("users, clients and providers each get their own pins", () => {
    const f = fixture({
      accounts: {
        u1: [
          login("claude-a", "claude"),
          login("claude-b", "claude"),
          login("codex-c", "openai-codex"),
        ],
        u2: [login("claude-y", "claude"), login("claude-z", "claude")],
        u3: [login("claude-q", "claude")],
      },
    });
    assert.equal(
      profileOf(f.pool.select("u1", claudeRef("K", "c1"))),
      "claude-a",
    );
    assert.equal(
      profileOf(f.pool.select("u2", claudeRef("K", "c2"))),
      "claude-y",
    );
    assert.deepEqual(f.pool.select("u3", codexRef("K", "c3")), {
      ok: false,
      refusal: "machine-pool-empty",
    });
    // Two clients of one user: a 429 on one doesn't move the other.
    const one = served(f.pool.select("u1", claudeRef("K", "c1")));
    const two = served(f.pool.select("u1", claudeRef("K", "c1b")));
    assert.notEqual(one.leaseId, two.leaseId);
    answer(f.pool, one, 429, LONG);
    assert.equal(
      profileOf(f.pool.select("u1", claudeRef("K", "c1"))),
      "claude-b",
    );
    // c1b's pin stays on claude-a (now benched long, so its next select moves
    // by the recorded bench, not by c1's 429).
    assert.equal(
      f.pool.records().find((r) => r.clientId === "c1b")!.profileId,
      "claude-a",
    );
    // One client, one key, two providers: two pins.
    assert.equal(
      profileOf(f.pool.select("u1", codexRef("K", "c1"))),
      "codex-c",
    );
    assert.equal(f.pool.records().filter((r) => r.clientId === "c1").length, 2);
    assert.equal(
      profileOf(f.pool.select("u1", claudeRef("K", "c1"))),
      "claude-b",
    );
  });

  test("dropClient removes only that client's pins", () => {
    const f = fixture();
    f.pool.select("u1", claudeRef("X", "c1"));
    f.pool.select("u1", claudeRef("X", "c2"));
    f.pool.dropClient("c1");
    assert.deepEqual(
      f.pool.records().map((r) => r.clientId),
      ["c2"],
    );
    assert.deepEqual(
      f.saves.at(-1)!.map((r) => r.clientId),
      ["c2"],
    );
  });
});

describe("persistence", () => {
  test("pins hold hashes, ids and times only; a use alone saves at most every 10 minutes", () => {
    const f = fixture();
    f.pool.select("u1", claudeRef("raw-session-key"));
    assert.equal(f.saves.length, 1);
    assert.ok(!JSON.stringify(f.saves).includes("raw-session-key"));
    f.clock.now += 5 * MINUTE;
    f.pool.select("u1", claudeRef("raw-session-key"));
    assert.equal(f.saves.length, 1);
    f.clock.now += 5 * MINUTE;
    f.pool.select("u1", claudeRef("raw-session-key"));
    assert.equal(f.saves.length, 2);
    assert.equal(f.saves.at(-1)![0]!.lastUsedAt, T0 + 10 * MINUTE);
  });

  test("a failed save keeps the move in memory and is retried by the next use", () => {
    let fail = false;
    const saves: MachinePinRecord[][] = [];
    const f = fixture({
      persist: (records) => {
        if (fail) throw new Error("disk full");
        saves.push(structuredClone(records));
      },
    });
    const x = served(f.pool.select("u1", claudeRef("X")));
    fail = true;
    assert.doesNotThrow(() => answer(f.pool, x, 429, LONG));
    assert.deepEqual(f.logs, ["machine pins: save failed; kept in memory"]);
    assert.equal(profileOf(f.pool.select("u1", claudeRef("X"))), "claude-b");
    fail = false;
    f.pool.select("u1", claudeRef("X"));
    assert.equal(saves.at(-1)![0]!.profileId, "claude-b");
    assert.deepEqual(saves.at(-1)![0]!.tried, ["claude-a"]);
  });

  test("parsePinRecord takes only well-formed records", () => {
    const good: MachinePinRecord = {
      clientId: "client-1",
      provider: "openai-codex",
      keyHash: sha("X"),
      profileId: "codex-c",
      tried: ["codex-d"],
      lastUsedAt: T0,
    };
    assert.deepEqual(parsePinRecord(good), good);
    assert.deepEqual(parsePinRecord({ ...good, keyHash: null }), {
      ...good,
      keyHash: null,
    });
    for (const bad of [
      { ...good, keyHash: "X" },
      { ...good, provider: "openai-compatible" },
      { ...good, clientId: "" },
      { ...good, profileId: 7 },
      { ...good, tried: "codex-d" },
      { ...good, tried: [7] },
      { ...good, lastUsedAt: -1 },
      { ...good, lastUsedAt: 1.5 },
      [good],
      null,
    ])
      assert.equal(parsePinRecord(bad), undefined, JSON.stringify(bad));
  });

  test("machinePins.json and leases.json round-trip through the state directory", async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const stateDir = join(
      await mkdtemp(join(DATA_DIR, "gateway-machine-")),
      "gateway",
    );
    const lines: string[] = [];
    const first = openGatewayState(stateDir, (line) => lines.push(line));
    const clock = { now: T0 };
    const profiles = new Map(
      ["claude-a", "claude-b"].map((id) => [id, login(id, "claude")]),
    );
    const leases = new LeaseTable({
      now: () => clock.now,
      persist: first.persistLeases,
    });
    const options = {
      accountsOf: () => [...profiles.keys()],
      profile: (id: string) => profiles.get(id),
      needsLogin: () => [],
      now: () => clock.now,
    };
    const pool = new MachinePool({
      ...options,
      leases,
      persist: first.persistMachinePins,
    });
    answer(pool, served(pool.select("u1", claudeRef("secret-key"))), 429, LONG);
    const moved = served(pool.select("u1", claudeRef("secret-key")));
    const raw = await readFile(join(stateDir, "machinePins.json"), "utf8");
    assert.ok(!raw.includes("secret-key"));
    assert.ok(raw.includes(sha("secret-key")));

    const second = openGatewayState(stateDir, (line) => lines.push(line));
    assert.deepEqual(lines, []);
    const restoredLeases = new LeaseTable({ now: () => clock.now });
    restoredLeases.restore(second.leases);
    assert.deepEqual(
      restoredLeases
        .records()
        .filter((r) => r.kind === "machine")
        .map((r) => [r.profileId, r.owner]),
      [
        ["claude-a", { clientId: "client-1" }],
        ["claude-b", { clientId: "client-1" }],
      ],
    );
    const restored = new MachinePool({ ...options, leases: restoredLeases });
    restored.restore(second.machinePins);
    assert.deepEqual(restored.records(), pool.records());
    const again = served(restored.select("u1", claudeRef("secret-key")));
    assert.equal(again.binding.profileId, "claude-b");
    assert.equal(again.leaseId, moved.leaseId);
  });

  test("F002: a pin the pool generated with 1,025 tried accounts restores through the state files and keeps its account", async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const stateDir = join(
      await mkdtemp(join(DATA_DIR, "gateway-tried-")),
      "gateway",
    );
    const lines: string[] = [];
    const first = openGatewayState(stateDir, (line) => lines.push(line));
    const f = fixture({ persist: first.persistMachinePins });
    const ref = claudeRef("session-key");
    // Account churn: one usable account at a time, each forced move leaves
    // the previous one tried. The pin itself stays well under the per-client cap.
    const account = (i: number): string => `account-${i}`;
    const only = (id: string): void => {
      f.owners.set("u1", [id]);
      f.profiles.set(id, login(id, "claude"));
    };
    only(account(0));
    served(f.pool.select("u1", ref));
    for (let i = 1; i <= 1025; i++) {
      f.clock.now += 1;
      only(account(i));
      assert.equal(profileOf(f.pool.select("u1", ref)), account(i));
    }
    const saved = f.pool.records();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.tried.length, 1025);

    const second = openGatewayState(stateDir, (line) => lines.push(line));
    assert.deepEqual(lines, []);
    assert.deepEqual(second.machinePins, saved);
    // The old account returns alongside the working one: the pin must not move.
    f.owners.set("u1", [account(0), account(1025)]);
    const restarted = new MachinePool({
      leases: new LeaseTable({ now: () => f.clock.now }),
      accountsOf: (user) => f.owners.get(user) ?? [],
      profile: (id) => f.profiles.get(id),
      needsLogin: () => [],
      now: () => f.clock.now,
    });
    restarted.restore(second.machinePins);
    assert.deepEqual(restarted.records(), saved);
    assert.equal(profileOf(restarted.select("u1", ref)), account(1025));
    assert.equal(restarted.records()[0]!.tried.length, 1025);
  });
});

describe("bounds (AC14)", () => {
  test("a pin unused for 7 days is dropped with its machine lease once no pin uses it", () => {
    const f = fixture();
    const old = served(f.pool.select("u1", claudeRef("old")));
    f.clock.now += DAY;
    const recent = served(f.pool.select("u1", codexRef("recent")));
    f.clock.now += PIN_IDLE_MS - DAY;
    f.pool.sweep();
    assert.deepEqual(
      f.pool.records().map((r) => r.keyHash),
      [sha("recent")],
    );
    assert.equal(f.leases.isLive(old.leaseId), false);
    assert.equal(f.leases.isLive(recent.leaseId), true);
    assert.deepEqual(
      f.saves.at(-1)!.map((r) => r.keyHash),
      [sha("recent")],
    );
  });

  test("a lease another pin of the client still uses is kept", () => {
    const f = fixture();
    const old = served(f.pool.select("u1", claudeRef("old")));
    f.clock.now += DAY;
    f.pool.select("u1", claudeRef("new"));
    f.clock.now += PIN_IDLE_MS - DAY;
    f.pool.sweep();
    assert.equal(f.pool.records().length, 1);
    assert.equal(f.leases.isLive(old.leaseId), true);
  });

  test("a selection sweeps at most hourly", () => {
    const f = fixture();
    const old = served(f.pool.select("u1", claudeRef("old")));
    f.clock.now += PIN_IDLE_MS;
    f.pool.select("u1", codexRef("other"));
    assert.equal(f.pool.records().length, 1);
    assert.equal(f.leases.isLive(old.leaseId), false);
  });

  test("a client keeps at most 1,024 pins, dropping the least recently used", () => {
    const f = fixture({
      accounts: {
        u1: [login("claude-a", "claude"), login("codex-c", "openai-codex")],
      },
      persist: () => {},
    });
    const first = served(f.pool.select("u1", codexRef("k0")));
    for (let i = 1; i < MAX_PINS_PER_CLIENT; i++) {
      f.clock.now += 1;
      f.pool.select("u1", claudeRef(`k${i}`));
    }
    f.pool.select("u1", claudeRef("other", "client-2"));
    assert.equal(f.pool.records().length, MAX_PINS_PER_CLIENT + 1);
    f.clock.now += 1;
    f.pool.select("u1", claudeRef("one-more"));
    const own = f.pool.records().filter((r) => r.clientId === "client-1");
    assert.equal(own.length, MAX_PINS_PER_CLIENT);
    assert.ok(!own.some((r) => r.keyHash === sha("k0")));
    assert.ok(own.some((r) => r.keyHash === sha("one-more")));
    // The evicted pin was the only one on codex-c: its lease ends.
    assert.equal(f.leases.isLive(first.leaseId), false);
  });
});
