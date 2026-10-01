import type { SlashCommandInfo } from "@assistant/shared";

export const slashCommands: SlashCommandInfo[] = [
  {
    name: "commit",
    description:
      "Stage all changes, generate a commit message, and create a git commit",
    usage: "/commit [--dry] [--force] [additional context]",
    agentTypes: ["workshop", "developer"],
  },
  {
    name: "push",
    description:
      "Push the current branch to its remote (human free-form host command)",
    usage: "/push [--force] [remote] [branch]",
    agentTypes: ["workshop", "developer"],
  },
  {
    name: "pr",
    description: "Commit, push, and open or reuse a pull request",
    usage:
      "/pr [--draft] [--base <branch>] [--force] [--force-commit] [context]",
    agentTypes: ["workshop", "developer"],
  },
  {
    name: "compact",
    description:
      "Summarize older session context while keeping recent messages",
    usage: "/compact [custom summary instructions]",
    // Includes the permanent-assistant singleton: it is long-running (never
    // rotates on a fixed schedule) and can otherwise only shed context through
    // automatic overflow compaction or a full rotation, so manual control over
    // WHEN to compact matters more here than for ordinary sessions.
    agentTypes: ["assistant", "workshop", "developer", "personal-assistant"],
    // Harness-independent: both harnesses implement `compactContext` (pi's
    // AgentSession compaction / the Claude CLI's own manual compaction), driven
    // by the shared host-command path in `hostSlashCommands.ts`.
  },
  {
    name: "review",
    description: "Open a NEW session staged to code-review this session's work",
    usage: "/review [extra instructions]",
    agentTypes: ["workshop", "developer"],
    // A navigating slash command: the web client lands on the new-session page
    // with a review draft prefilled and this session's Task/worktree/project
    // staged. No synthetic tool turn appears in the transcript it was typed
    // into, and the server never runs it (connection.ts rejects dispatch).
    execution: "client",
  },
  {
    name: "clear",
    description:
      "Drop this session's model context; the transcript keeps every message",
    usage: "/clear",
    // Same reach as /compact, the permanent-assistant singleton included: both
    // are ways to shed context in a session that cannot simply be replaced.
    agentTypes: ["assistant", "workshop", "developer", "personal-assistant"],
    // Harness-independent: both harnesses implement `clearContext` (pi resets
    // its session leaf, the Claude harness drops the CLI resume id), driven by
    // the shared host-command path in `hostSlashCommands.ts`.
  },
];

export function findSlashCommand(name: string): SlashCommandInfo | undefined {
  return slashCommands.find((cmd) => cmd.name === name);
}

export interface ParsedCommitArgs {
  dryRun: boolean;
  force: boolean;
  additionalContext: string;
}

export function parseCommitArgs(rawArgs: string): ParsedCommitArgs {
  const parts = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const context: string[] = [];
  let dryRun = false;
  let force = false;
  for (const part of parts) {
    const unquoted = part.replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (unquoted === "--dry" || unquoted === "--dry-run") dryRun = true;
    else if (unquoted === "--force") force = true;
    else context.push(unquoted);
  }
  return { dryRun, force, additionalContext: context.join(" ").trim() };
}

export interface ParsedPrArgs {
  draft: boolean;
  base?: string;
  /** Force-push with lease. Does not bypass commit safety review. */
  force: boolean;
  /** Explicitly bypass commit safety blockers. */
  forceCommit: boolean;
  additionalContext: string;
}

/** Parse `/pr [--draft] [--base <branch>] [--force] [--force-commit] [context]`. */
export function parsePrArgs(rawArgs: string): ParsedPrArgs {
  const parts = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const values = parts.map((part) => part.replace(/^(["'])([\s\S]*)\1$/, "$2"));
  const context: string[] = [];
  let draft = false;
  let force = false;
  let forceCommit = false;
  let base: string | undefined;
  let flags = true;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (flags && value === "--") {
      flags = false;
      continue;
    }
    if (flags && value === "--draft") draft = true;
    else if (flags && value === "--force") force = true;
    else if (flags && value === "--force-commit") forceCommit = true;
    else if (flags && value === "--base") {
      const next = values[index + 1];
      if (!next || next.startsWith("--"))
        throw new Error("/pr --base requires a branch name.");
      base = next;
      index += 1;
    } else if (flags && value.startsWith("--base=")) {
      base = value.slice("--base=".length).trim();
      if (!base) throw new Error("/pr --base requires a branch name.");
    } else context.push(value);
  }

  return {
    draft,
    ...(base ? { base } : {}),
    force,
    forceCommit,
    additionalContext: context.join(" ").trim(),
  };
}
