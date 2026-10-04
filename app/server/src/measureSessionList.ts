/**
 * `pnpm run measure:session-list` — what one session-list rebuild costs, by
 * part.
 *
 * The list is rebuilt on every session change (up to ~4 times a second while
 * agents stream), on the thread that serves every connection. This prints the
 * median and p90 of each batched prologue read `listSessions` makes, then of
 * the whole default, archived and single-row (`onlyIds`) builds.
 *
 *   pnpm run measure:session-list -- --data-dir ~/assistant-data
 *   pnpm run measure:session-list -- --data-dir ~/assistant-data --runs 50 --json
 *
 * It never opens the given data dir's database: it COPIES `app.sqlite3` (with
 * its WAL) and the file-backed stores the list reads into a temporary data dir,
 * measures that copy, and deletes it on exit. The two legacy card stores are
 * copied too, so a data dir that has not yet imported them imports into the
 * copy, never the original. Opening the copy applies any
 * pending migration there, which is what makes it safe to run from a branch.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

/** The database, and the files `listSessions` reads or imports per rebuild. */
const COPIED_FILES = [
  "app.sqlite3",
  "app.sqlite3-wal",
  "pending-approvals.json",
  "pull-request-cards.json",
  "answered-questions.json",
];

interface PartTiming {
  part: string;
  medianMs: number;
  p90Ms: number;
  size?: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at]!;
}

async function time(
  part: string,
  runs: number,
  fn: () => unknown,
): Promise<PartTiming> {
  let size: number | undefined;
  const samples: number[] = [];
  // One untimed call so a first-use statement prepare or file parse is not
  // what the median reports.
  await fn();
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    const result = await fn();
    samples.push(performance.now() - startedAt);
    if (result instanceof Map || result instanceof Set) size = result.size;
    else if (Array.isArray(result)) size = result.length;
  }
  samples.sort((a, b) => a - b);
  return {
    part,
    medianMs: quantile(samples, 0.5),
    p90Ms: quantile(samples, 0.9),
    ...(size !== undefined ? { size } : {}),
  };
}

async function main(): Promise<void> {
  const source = arg("data-dir");
  if (!source) throw new Error("--data-dir <production data dir> is required");
  const sourceDir = resolve(source);
  if (!existsSync(join(sourceDir, "app.sqlite3")))
    throw new Error(`${sourceDir} holds no app.sqlite3`);
  const runs = Number.parseInt(arg("runs") ?? "30", 10);
  const json = process.argv.includes("--json");

  const copyDir = mkdtempSync(join(tmpdir(), "pa-session-list-"));
  try {
    for (const name of COPIED_FILES) {
      const from = join(sourceDir, name);
      if (existsSync(from)) copyFileSync(from, join(copyDir, name));
    }
    // Every module below resolves DATA_DIR at import time, so the copy has to
    // be the data dir before the first one loads.
    process.env.DATA_DIR = copyDir;
    const [
      { listSessions },
      { sessionStore },
      { projectStore },
      { worktreeIdBySession },
      { objectRefsBySession },
      { subagentStore },
      { backgroundWorkStore },
      { peerPromptStore },
      { agentHandoffStore },
      { pendingApprovalSessionIds },
      { pullRequestSummariesBySession },
      { listTasks },
      { taskStore },
      { removeLink },
    ] = await Promise.all([
      import("./sessions.ts"),
      import("./db/sessionStore.ts"),
      import("./db/projectStore.ts"),
      import("./db/worktreeStore.ts"),
      import("./db/sessionObjectStore.ts"),
      import("./db/subagentStore.ts"),
      import("./db/backgroundWorkStore.ts"),
      import("./db/peerPromptStore.ts"),
      import("./db/agentHandoffStore.ts"),
      import("./pendingApprovals.ts"),
      import("./pullRequestCards.ts"),
      import("./tasks.ts"),
      import("./db/taskStore.ts"),
      import("./db/links.ts"),
    ]);

    const defaultRows = sessionStore.list({ excludeArchived: true });
    const defaultIds = defaultRows.map((row) => row.id);
    const readAt = sessionStore.getReadAt;
    const probeId = defaultIds[0];

    const timings: PartTiming[] = [];
    const parts: Array<[string, () => unknown]> = [
      [
        "sessionStore.list (default)",
        () => sessionStore.list({ excludeArchived: true }),
      ],
      ["sessionStore.list (with archived)", () => sessionStore.list({})],
      [
        "projectStore.sessionProjectIndex",
        () => projectStore.sessionProjectIndex(),
      ],
      ["worktreeIdBySession", () => worktreeIdBySession()],
      ["objectRefsBySession", () => objectRefsBySession()],
      [
        "worktreeMissingAckBySession",
        () => sessionStore.worktreeMissingAckBySession(),
      ],
      // What the per-session Task progress index used to assemble after every
      // Task write, and the join it reads now.
      ["listTasks (full summaries)", () => listTasks()],
      ["taskStore.sessionTaskStatuses", () => taskStore.sessionTaskStatuses()],
      [
        "peerPromptStore.pendingDeliveryRecipientIds",
        () => peerPromptStore.pendingDeliveryRecipientIds(),
      ],
      [
        "agentHandoffStore.queuedSessionIds",
        () => agentHandoffStore.queuedSessionIds(),
      ],
      [
        "subagentStore.delegationSummaries",
        () => subagentStore.delegationSummaries(),
      ],
      [
        "backgroundWorkStore.activityByOwner",
        () => backgroundWorkStore.activityByOwner(),
      ],
      ["pendingApprovalSessionIds", () => pendingApprovalSessionIds()],
      ["pullRequestSummariesBySession", () => pullRequestSummariesBySession()],
      [
        "spawnedParentsByChildIds (default ids)",
        () => sessionStore.spawnedParentsByChildIds(defaultIds),
      ],
      ["listSessions (default)", () => listSessions([], readAt)],
      [
        // Deleting an edge that does not exist changes no row but counts as a
        // session-edge write, so this is the rebuild right after one.
        "listSessions (default, after a session edge write)",
        () => {
          removeLink(
            { type: "session", id: "measure-session-list" },
            "context",
            { type: "task", id: "0" },
          );
          return listSessions([], readAt);
        },
      ],
      [
        "listSessions (includeArchived)",
        () => listSessions([], readAt, { includeArchived: true }),
      ],
      ...(probeId
        ? ([
            [
              "listSessions (includeArchived, onlyIds: 1 row)",
              () =>
                listSessions([], readAt, {
                  includeArchived: true,
                  onlyIds: new Set([probeId]),
                }),
            ],
          ] as Array<[string, () => unknown]>)
        : []),
    ];
    for (const [part, fn] of parts) timings.push(await time(part, runs, fn));

    if (json) {
      console.log(
        JSON.stringify(
          { runs, defaultRows: defaultIds.length, timings },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      `session list rebuild — ${defaultIds.length} default rows, ${runs} runs per part\n`,
    );
    const width = Math.max(...timings.map((t) => t.part.length));
    for (const t of timings) {
      console.log(
        `${t.part.padEnd(width)}  median ${t.medianMs.toFixed(2).padStart(7)} ms  p90 ${t.p90Ms.toFixed(2).padStart(7)} ms${t.size !== undefined ? `  (${t.size})` : ""}`,
      );
    }
  } finally {
    const { closeDb } = await import("./db/index.ts");
    closeDb();
    rmSync(copyDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
