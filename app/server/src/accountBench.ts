import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  accountLimitMatches,
  accountLimitModel,
} from "@assistant/shared/accountHealth";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import type { RunFailureFacts } from "./session/adapters/contract.ts";

export const QUOTA_BENCH_MS = 30 * 60_000;
export const RATE_LIMIT_BENCH_MS = 5 * 60_000;
interface AccountBench {
  since: number;
  until: number;
  source: "usage" | "quota" | "rate_limit";
  model?: string;
}
interface RecordEntry {
  order: number;
  bench?: AccountBench;
}

/** Failure report order and positive operation-start order, independently per scope. */
export class AccountBenchStore {
  private readonly records = new Map<string, Map<string, RecordEntry>>();
  private changed = 0;
  constructor(
    private readonly path: string,
    private readonly now: () => number,
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const [id, scopes] of Object.entries(raw)) {
        if (
          !/^[A-Za-z0-9_-]+$/.test(id) ||
          !scopes ||
          typeof scopes !== "object" ||
          Array.isArray(scopes)
        )
          continue;
        const entries = new Map<string, RecordEntry>();
        for (const [model, value] of Object.entries(scopes)) {
          if (model && accountLimitModel(model) !== model) continue;
          const bench = value as AccountBench | null;
          if (
            bench &&
            ["usage", "quota", "rate_limit"].includes(bench.source) &&
            Number.isFinite(bench.since) &&
            Number.isFinite(bench.until) &&
            bench.until <= 8.64e15 &&
            bench.until > now()
          ) {
            entries.set(model, {
              order: 0,
              bench: {
                since: bench.since,
                until: bench.until,
                source: bench.source,
                ...(model ? { model } : {}),
              },
            });
          }
        }
        if (entries.size) this.records.set(id, entries);
      }
    } catch {
      /* Missing or corrupt persistence does not block runs. */
    }
  }

  get revision(): number {
    return this.changed;
  }
  ids(): IterableIterator<string> {
    return this.records.keys();
  }
  nextExpiry(): number | undefined {
    const live = [...this.records.values()].flatMap((scopes) =>
      [...scopes.values()].flatMap(({ bench }) =>
        bench && bench.until > this.now() ? [bench.until] : [],
      ),
    );
    return live.length ? Math.min(...live) : undefined;
  }
  expire(): void {
    let changed = false;
    for (const scopes of this.records.values())
      for (const record of scopes.values()) {
        if (record.bench && record.bench.until <= this.now()) {
          delete record.bench;
          changed = true;
        }
      }
    if (changed) {
      this.changed++;
      this.persist();
    }
  }
  read(id: string, model?: string): AccountBench | undefined {
    const scopes = this.records.get(id);
    const whole = scopes?.get("")?.bench;
    if (model === undefined && whole && whole.until > this.now()) return whole;
    return [...(scopes?.values() ?? [])]
      .flatMap(({ bench }) =>
        bench &&
        bench.until > this.now() &&
        (model === undefined ||
          !bench.model ||
          accountLimitMatches(bench.model, model))
          ? [bench]
          : [],
      )
      .sort((a, b) => b.until - a.until)[0];
  }
  failure(id: string, failure: RunFailureFacts, order: number): void {
    if (failure.kind !== "quota" && failure.kind !== "rate_limit") return;
    const model = accountLimitModel(failure.limitModel) ?? "";
    const since = this.now();
    const until =
      failure.resetAtMs ??
      since + (failure.kind === "quota" ? QUOTA_BENCH_MS : RATE_LIMIT_BENCH_MS);
    if (!Number.isFinite(until) || until <= since || until > 8.64e15) return;
    const previous = this.records.get(id)?.get(model)?.bench;
    this.apply(
      id,
      model,
      {
        since,
        until: Math.max(until, previous?.until ?? 0),
        source: failure.kind,
        ...(model ? { model } : {}),
      },
      order,
    );
  }
  working(id: string, model: string | undefined, order: number): void {
    this.apply(id, "", undefined, order);
    const key = accountLimitModel(model);
    if (!key) return;
    for (const scope of this.records.get(id)?.keys() ?? [])
      if (scope && accountLimitMatches(scope, model))
        this.apply(id, scope, undefined, order);
    this.apply(id, key, undefined, order);
  }
  usage(
    id: string,
    snapshot: OpenAiUsageSnapshot | Partial<ClaudeUsageSnapshot>,
    order: number,
  ): void {
    const scopes = new Map<
      string,
      Array<{ pct: number | null; reset: string | null }>
    >();
    const add = (
      model: string | null | undefined,
      pct: number | null,
      reset: string | null,
    ) => {
      // Usage titles describe counters as well as models (e.g. "Model limit").
      const words = model
        ?.toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter(
          (word) =>
            !/^(?:model|models|usage|rate|request|requests|token|tokens|message|messages|limit|limits|quota|cap|window|windows|primary|secondary|additional|total|all|per|api|account|subscription|plan|org|organization|team|budget|spend|control|session|weekly|monthly|daily|minute|minutes|hour|hours|day|days|week|weeks|month|months)$/.test(
              word,
            ),
        )
        .join("-");
      const key = accountLimitModel(words) ?? "";
      const values = scopes.get(key) ?? [];
      values.push({ pct, reset });
      scopes.set(key, values);
    };
    if ("available" in snapshot) {
      if (!snapshot.available) return;
      for (const window of snapshot.windows)
        add(window.label, window.usedPercent, window.resetsAt);
      if (snapshot.spendControl)
        add(
          null,
          snapshot.spendControl.usedPercent,
          snapshot.spendControl.resetsAt,
        );
    } else {
      if (!snapshot.rateLimitsAvailable) return;
      for (const window of [snapshot.fiveHour, snapshot.weekly])
        if (window) add(null, window.utilizationPct, window.resetsAt);
      // An unnamed model window cannot prove a model scope, so `add` benches
      // the whole account for it.
      for (const window of snapshot.modelScoped ?? [])
        add(window.modelDisplayName, window.utilizationPct, window.resetsAt);
      for (const window of snapshot.limits ?? [])
        if (window.isActive)
          add(window.scope?.modelDisplayName, window.percent, window.resetsAt);
    }
    for (const [model, values] of scopes) {
      const existing = this.records.get(id)?.get(model)?.bench;
      // Usage windows cannot disprove or re-label a provider-reported failure.
      if (
        existing &&
        existing.until > this.now() &&
        existing.source !== "usage"
      )
        continue;
      const exhausted = values.filter(
        ({ pct }) => pct !== null && Number.isFinite(pct) && pct >= 100,
      );
      const until = Math.max(
        0,
        ...exhausted
          .map(({ reset }) => (reset ? Date.parse(reset) : 0))
          .filter(Number.isFinite),
      );
      if (until > this.now())
        this.apply(
          id,
          model,
          {
            since: this.now(),
            until,
            source: "usage",
            ...(model ? { model } : {}),
          },
          order,
        );
      else if (
        !exhausted.length &&
        values.every(
          ({ pct }) =>
            pct !== null && Number.isFinite(pct) && pct >= 0 && pct < 100,
        )
      )
        this.apply(id, model, undefined, order);
    }
  }
  forget(id: string): void {
    const scopes = this.records.get(id);
    if (
      this.records.delete(id) &&
      [...(scopes?.values() ?? [])].some(({ bench }) => !!bench)
    ) {
      this.changed++;
      this.persist();
    }
  }
  private apply(
    id: string,
    model: string,
    bench: AccountBench | undefined,
    order: number,
  ): void {
    const scopes = this.records.get(id) ?? new Map<string, RecordEntry>();
    const previous = scopes.get(model);
    const latest = Math.max(
      previous?.order ?? 0,
      ...[...scopes].flatMap(([scope, entry]) =>
        scope && model && accountLimitMatches(model, scope)
          ? [entry.order]
          : [],
      ),
    );
    if (order < latest) return;
    if (
      bench &&
      previous?.bench?.until === bench.until &&
      previous.bench.source === bench.source
    )
      bench = previous.bench;
    scopes.set(model, { order, ...(bench ? { bench } : {}) });
    this.records.set(id, scopes);
    // Ordering alone stays process-local; only live bench changes are durable.
    if (JSON.stringify(previous?.bench) !== JSON.stringify(bench)) {
      this.changed++;
      this.persist();
    }
  }
  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const raw = Object.fromEntries(
        [...this.records].flatMap(([id, scopes]) => {
          const live = [...scopes].flatMap(([model, { bench }]) =>
            bench && bench.until > this.now() ? [[model, bench] as const] : [],
          );
          return live.length ? [[id, Object.fromEntries(live)] as const] : [];
        }),
      );
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch {
      /* In-memory benches remain usable if persistence fails. */
    }
  }
}
