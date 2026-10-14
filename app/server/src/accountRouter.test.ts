import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { USAGE_STALE_MS, type UsageIndicator } from "@assistant/shared/usage";
import {
  rankAccountCandidates,
  pickAccount,
  type AccountCandidate,
  type AccountPickRequest,
} from "./accountRouter.ts";
import { listCredentialProfiles } from "./credentialProfiles.ts";
import { modelsForAccount } from "./harnesses/models.ts";
import { cachedUsageIndicator } from "./usageCache.ts";

vi.mock("./credentialProfiles.ts", () => ({
  listCredentialProfiles: vi.fn(),
  DEFAULT_CLAUDE_PROFILE_ID: "claude-default",
  DEFAULT_OPENAI_PROFILE_ID: "default",
}));
vi.mock("./harnesses/models.ts", () => ({ modelsForAccount: vi.fn() }));
vi.mock("./usageCache.ts", () => ({ cachedUsageIndicator: vi.fn() }));
vi.mock("./settings.ts", () => ({
  getSettings: () => ({
    accountRouting: { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 },
  }),
}));

const now = Date.parse("2030-01-01T00:00:00Z");
const thresholds = { fiveHourUsedThreshold: 90, weeklyUsedThreshold: 95 };
const request: AccountPickRequest = {
  model: { provider: "openai-codex", modelId: "codex" },
  thinkingLevel: "high",
};
function account(
  id: string,
  short: number | null = 20,
  long: number | null = 30,
  resetHours = 24,
): AccountCandidate {
  return {
    profile: {
      id,
      provider: "openai-codex",
      enabled: true,
      enterprise: false,
      health: { state: "ok", since: now },
    },
    offersModel: true,
    usage: {
      profileId: id,
      provider: "openai-codex",
      fetchedAt: now,
      refreshing: false,
      limitsAvailable: true,
      short: {
        usedPct: short,
        resetsAt: new Date(now + 5 * 3600_000).toISOString(),
      },
      long: {
        usedPct: long,
        resetsAt: new Date(now + resetHours * 3600_000).toISOString(),
      },
    },
  };
}
test("applicable benches are hard-filtered despite better usage", () => {
  const benched = {
    ...account("limited", 0, 0),
    limited: { until: now + 60_000 },
  };
  const available = account("available", 99, 99);
  for (const candidates of [
    [benched, available],
    [available, benched],
  ])
    assert.equal(rank(candidates).profileId, "available");
});
test("degradation puts login last, then benches, and carries the limit time", () => {
  const until = now + 60_000;
  const benched = {
    ...account("limited", 0, 0),
    limited: { until, model: "codex" },
  };
  const unsupported = {
    ...account("unsupported", 100, 100),
    offersModel: false,
  };
  const login = account("login", 0, 0);
  login.profile.health = { state: "needs-login", since: now };
  assert.equal(rank([benched, unsupported, login]).profileId, "unsupported");
  assert.deepEqual(rank([login, benched]), {
    profileId: "limited",
    degraded: "no-eligible-account",
    limited: { until, model: "codex" },
  });
});

const rank = (
  candidates: AccountCandidate[],
  patch: Partial<AccountPickRequest> = {},
) =>
  rankAccountCandidates(
    candidates,
    { ...request, ...patch },
    thresholds,
    now,
    "default",
  );

test("fresh room ranks by earliest weekly reset, not lowest weekly usage", () => {
  assert.equal(
    rank([account("low-weekly", 10, 1, 48), account("early", 80, 94, 1)])
      .profileId,
    "early",
  );
});
test("weekly reset ties prefer lower known 5-hour usage, then stable id", () => {
  assert.equal(rank([account("a", 80), account("b", 10)]).profileId, "b");
  assert.equal(rank([account("z"), account("a")]).profileId, "a");
  assert.equal(rank([account("a"), account("z")]).profileId, "a");
});
test("fresh room precedes missing and stale usage, which precede exhaustion", () => {
  const missing = account("a-missing");
  missing.usage = null;
  const stale = account("b-stale");
  stale.usage!.fetchedAt = now - USAGE_STALE_MS["openai-codex"];
  const spent = account("c-spent", 90, 30, 1);
  const fresh = account("z-fresh", 89, 94, 48);
  assert.equal(
    rank([missing, stale, spent, fresh]).profileId,
    fresh.profile.id,
  );
  assert.equal(rank([missing, stale, spent]).profileId, missing.profile.id);
  assert.equal(rank([stale, spent]).profileId, stale.profile.id);
  assert.equal(rank([spent]).profileId, spent.profile.id);
});
test("provider-specific stale boundary includes Claude's longer freshness", () => {
  const claude = account("claude");
  claude.profile.provider = "claude";
  claude.usage!.provider = "claude";
  claude.usage!.fetchedAt = now - USAGE_STALE_MS["openai-codex"];
  const missing = account("a");
  missing.profile.provider = "claude";
  missing.usage = null;
  const patch = { model: { provider: "claude-sdk", modelId: "sonnet" } };
  assert.equal(rank([missing, claude], patch).profileId, "claude");
  claude.usage!.fetchedAt = now - USAGE_STALE_MS.claude;
  assert.equal(rank([missing, claude], patch).profileId, "a");
});
test("unknown windows, unavailable limits and rolled-over cycles are not fresh headroom", () => {
  for (const candidate of [
    account("partial", null),
    account("rolled"),
    account("unavailable"),
  ]) {
    if (candidate.profile.id === "rolled")
      candidate.usage!.long!.resetsAt = new Date(now).toISOString();
    if (candidate.profile.id === "unavailable")
      candidate.usage!.limitsAvailable = false;
    assert.equal(rank([candidate, account("z-fresh")]).profileId, "z-fresh");
    assert.equal(
      rank([candidate, account("z-spent", 95)]).profileId,
      candidate.profile.id,
    );
  }
});
test("malformed cached percentages cannot count as fresh headroom", () => {
  const malformed = account("a-malformed", NaN);
  assert.equal(rank([malformed, account("z-fresh")]).profileId, "z-fresh");
});

test("one fresh exhausted window remains exhausted when the other is unknown", () => {
  const unknown = account("z-unknown");
  unknown.usage = null;
  assert.equal(
    rank([account("a-spent", null, 95), unknown]).profileId,
    "z-unknown",
  );
  assert.equal(
    rank([account("a-spent", 90, null), unknown]).profileId,
    "z-unknown",
  );
});
test("thresholds are strict and configurable", () => {
  const changed = { fiveHourUsedThreshold: 40, weeklyUsedThreshold: 50 };
  const unknown = account("z-unknown");
  unknown.usage = null;
  assert.equal(
    rankAccountCandidates(
      [account("at-short", 40, 10), unknown],
      request,
      changed,
      now,
      "default",
    ).profileId,
    "z-unknown",
  );
  assert.equal(
    rankAccountCandidates(
      [account("at-weekly", 10, 50), unknown],
      request,
      changed,
      now,
      "default",
    ).profileId,
    "z-unknown",
  );
  assert.equal(
    rankAccountCandidates(
      [account("room", 39, 49), unknown],
      request,
      changed,
      now,
      "default",
    ).profileId,
    "room",
  );
});
test("providers never mix, even for degradation and protected-default fallback", () => {
  const other = account("claude-default");
  other.profile.provider = "claude";
  assert.deepEqual(rank([other], { allowDisabledDefault: true }), {
    profileId: null,
    degraded: "no-enabled-account",
  });
});
test("unrestricted sessions include enterprise accounts without special ranking", () => {
  const enterprise = account("work", 20, 30, 1);
  enterprise.profile.enterprise = true;
  assert.equal(rank([account("personal"), enterprise]).profileId, "work");
});
test("enterprise is never relaxed, including health/model/disabled degradation", () => {
  const personal = account("default", 1, 1, 1);
  assert.deepEqual(
    rank([personal], { requiresEnterprise: true, allowDisabledDefault: true }),
    { profileId: null, degraded: "no-enterprise-account" },
  );
  const work = account("work");
  work.profile.enterprise = true;
  work.offersModel = false;
  assert.deepEqual(rank([personal, work], { requiresEnterprise: true }), {
    profileId: "work",
    degraded: "no-eligible-account",
  });
  work.profile.enabled = false;
  assert.deepEqual(rank([personal, work], { requiresEnterprise: true }), {
    profileId: null,
    degraded: "no-enterprise-account",
  });
});
for (const filter of ["disabled", "login", "model", "bench"] as const) {
  test(`hard filter ${filter} excludes a better-ranked account`, () => {
    const filtered = account("early", 1, 1, 1);
    if (filter === "disabled") filtered.profile.enabled = false;
    if (filter === "login") filtered.profile.health.state = "needs-login";
    if (filter === "model") filtered.offersModel = false;
    if (filter === "bench") filtered.limited = { until: now + 60_000 };
    assert.equal(rank([filtered, account("good")]).profileId, "good");
  });
}
test("unknown health remains usable", () => {
  const candidate = account("unknown");
  candidate.profile.health.state = "unknown";
  assert.deepEqual(rank([candidate]), { profileId: "unknown" });
});
test("degradation prefers healthy accounts over needs-login despite exhausted usage", () => {
  const a = account("a", 99, 99, 2);
  a.offersModel = false;
  const b = account("b", 10, 30, 1);
  b.profile.health.state = "needs-login";
  assert.deepEqual(rank([a, b]), {
    profileId: "a",
    degraded: "no-eligible-account",
  });
  a.profile.health.state = "unknown";
  assert.equal(rank([a, b]).profileId, "a");
  a.profile.health.state = "needs-login";
  assert.deepEqual(rank([a, b]), {
    profileId: "b",
    degraded: "no-eligible-account",
  });
});
test("all-login degradation prefers the offered model before better usage", () => {
  const missing = account("a-missing-model", 10, 30, 1);
  missing.offersModel = false;
  missing.profile.health.state = "needs-login";
  const offered = account("z-offered-model", 99, 99, 48);
  offered.profile.health.state = "needs-login";
  for (const candidates of [
    [missing, offered],
    [offered, missing],
  ]) {
    assert.deepEqual(rank(candidates), {
      profileId: offered.profile.id,
      degraded: "no-eligible-account",
    });
  }
});
test("all-disabled background fallback is explicit; interactive gets no account", () => {
  const fallback = account("default");
  fallback.profile.enabled = false;
  const another = account("other");
  another.profile.enabled = false;
  assert.deepEqual(rank([fallback, another]), {
    profileId: null,
    degraded: "no-enabled-account",
  });
  assert.deepEqual(rank([fallback, another], { allowDisabledDefault: true }), {
    profileId: "default",
    degraded: "disabled-default",
  });
});
test("retry exclusions also constrain degradation and disabled-default fallback", () => {
  const failed = account("default");
  assert.deepEqual(
    rank([failed], {
      excludeProfileIds: ["default"],
      allowDisabledDefault: true,
    }),
    { profileId: null, degraded: "no-enabled-account" },
  );
  const next = account("next");
  next.offersModel = false;
  assert.deepEqual(rank([failed, next], { excludeProfileIds: ["default"] }), {
    profileId: "next",
    degraded: "no-eligible-account",
  });
});

test("real gather asks each account's model/effort snapshot and reads cache only", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const noModel = account("a-no-model");
    const noEffort = account("b-no-effort");
    const good = account("good");
    const disabled = account("disabled");
    disabled.profile.enabled = false;
    const other = account("other-provider");
    other.profile.provider = "claude";
    const candidates = [noModel, noEffort, good, disabled, other];
    vi.mocked(listCredentialProfiles).mockReturnValue(
      candidates.map(({ profile }) => ({
        ...profile,
        name: profile.id,
        status: "ready",
        createdAt: 0,
        updatedAt: 0,
      })),
    );
    vi.mocked(modelsForAccount).mockImplementation(async (profile) =>
      profile.id === "a-no-model"
        ? []
        : [
            {
              provider: "openai-codex",
              id: "codex",
              name: "Codex",
              reasoning: true,
              contextWindow: 1000,
              supportedThinkingLevels:
                profile.id === "b-no-effort" ? ["low"] : ["high"],
            },
          ],
    );
    vi.mocked(cachedUsageIndicator).mockImplementation(
      (profile) =>
        candidates.find((candidate) => candidate.profile.id === profile.id)!
          .usage as UsageIndicator,
    );
    assert.deepEqual(await pickAccount(request), { profileId: "good" });
    assert.deepEqual(
      vi.mocked(modelsForAccount).mock.calls.map(([profile]) => profile.id),
      ["a-no-model", "b-no-effort", "good"],
    );
    assert.equal(vi.mocked(cachedUsageIndicator).mock.calls.length, 3);
    vi.mocked(cachedUsageIndicator).mockImplementation(() => {
      throw new Error("malformed cached usage");
    });
    assert.deepEqual(await pickAccount(request), { profileId: "good" });
    vi.mocked(modelsForAccount).mockImplementation(async () => {
      throw new Error("bad account catalog");
    });
    assert.deepEqual(await pickAccount(request), {
      profileId: "a-no-model",
      degraded: "no-eligible-account",
    });
    noModel.profile.health.state = "needs-login";
    good.profile.health.state = "needs-login";
    noEffort.profile.health.state = "unknown";
    noEffort.usage!.short!.usedPct = 99;
    vi.mocked(cachedUsageIndicator).mockImplementation(
      (profile) =>
        candidates.find((candidate) => candidate.profile.id === profile.id)!
          .usage as UsageIndicator,
    );
    assert.deepEqual(await pickAccount(request), {
      profileId: "b-no-effort",
      degraded: "no-eligible-account",
    });
  } finally {
    vi.useRealTimers();
  }
});
