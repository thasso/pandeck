/**
 * `ls` — a bounded directory listing, ported from pi's `ls` builtin (Task-319).
 *
 * It is a PORT, not an import: `app/server/src/CLAUDE.md` and
 * `architecture.test.ts` keep `@earendil-works/*` out of `tools/`. pi's builtin
 * is also dropped from `piSdk/options.ts` (`PI_SEARCH_BUILTIN_TOOLS`) — this tool
 * SHADOWS it there, so leaving it listed would have been dead config that still
 * priced and described a definition the model never sees (see that constant for
 * the registry ordering). Dropped along the way: pi's prompt-extras snippet (an
 * `AgentTool` has no such channel) and its `pi-tui` renderers.
 *
 * Why an app tool when both harnesses can shell out: this host's interactive
 * shell aliases leak into agent `bash` calls (`ls` is `eza --icons=always`), so
 * a shell listing spends tokens on Nerd Font glyphs and depends on whatever the
 * user's rc files define. This reads the directory directly, with no subprocess.
 *
 * Registered EAGER for the coding personas: a deferred listing tool would cost a
 * discovery round trip and be strictly worse than the shell call it replaces.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defineAgentTool } from "../../mcp/tool.ts";
import { CWD } from "../../config.ts";

type LsParams = {
  path?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 500;
const MAX_BYTES = 50 * 1024;

const lsParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "Absolute, `~`-relative, or relative to the working directory, which is the default.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: `Maximum entries to return (default ${DEFAULT_LIMIT}).`,
    },
  },
} as const;

export const lsTool = defineAgentTool<LsParams>({
  name: "ls",
  label: "ls",
  description: `List a directory: entries sorted alphabetically, dotfiles included, '/' suffix for directories, bounded at ${DEFAULT_LIMIT} entries or ${MAX_BYTES / 1024}KB. Prefer it over a shell listing — it reads the directory directly, so no shell alias can reshape the output.`,
  parameters: lsParamsSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);
    const dirPath = resolveListingPath(params.path, ctx.session.cwd ?? CWD);
    const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT));

    const target = await stat(dirPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(`Path not found: ${dirPath}`);
      throw error;
    });
    if (!target.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch (error) {
      throw new Error(
        `Cannot read directory ${dirPath}: ${(error as Error).message}`,
      );
    }
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    const entries: string[] = [];
    let entryLimitReached = false;
    for (const name of names) {
      if (entries.length >= limit) {
        // Deliberately pi's behaviour: the notice is raised on the FIRST name
        // past the limit, so if every remaining name turns out to be unstattable
        // (and skipped) it overstates what a larger limit would return. Counting
        // the survivors first would cost a `stat` per remaining entry — the one
        // thing the limit exists to avoid.
        entryLimitReached = true;
        break;
      }
      throwIfAborted(ctx.signal);
      // A directory gets the '/' suffix; an entry we cannot stat (a broken
      // symlink, a race with a delete) is skipped rather than reported.
      let suffix = "";
      try {
        if ((await stat(join(dirPath, name))).isDirectory()) suffix = "/";
      } catch {
        continue;
      }
      entries.push(name + suffix);
    }
    // The resolved path rides on `details` for EVERY outcome, empty included:
    // that is the one case where a log reader cannot infer it from the text.
    if (entries.length === 0)
      return {
        content: [{ type: "text", text: "(empty directory)" }],
        details: { path: dirPath },
      };

    // Byte truncation only: the entry count is already capped above.
    const truncation = truncateHeadBytes(entries.join("\n"), MAX_BYTES);
    const notices: string[] = [];
    const details: {
      path: string;
      entryLimitReached?: number;
      truncation?: Truncation;
    } = { path: dirPath };
    if (entryLimitReached) {
      notices.push(
        `${limit} entries limit reached. Use limit=${limit * 2} for more`,
      );
      details.entryLimitReached = limit;
    }
    if (truncation.truncated) {
      notices.push(`${MAX_BYTES / 1024}KB limit reached`);
      details.truncation = truncation;
    }
    const text =
      notices.length > 0
        ? `${truncation.content}\n\n[${notices.join(". ")}]`
        : truncation.content;
    return { content: [{ type: "text", text }], details };
  },
});

/**
 * Line counts are kept although pi's TUI renderer (the only thing that read
 * them) is gone: once the text is truncated they are the log's only record of
 * how much was dropped, and `details` is where the UI/logs look.
 */
interface Truncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxBytes: number;
}

/** Keep whole leading lines that fit in `maxBytes`; never a partial line. */
function truncateHeadBytes(
  content: string,
  maxBytes: number,
): Truncation & { content: string } {
  const lines = content.split("\n");
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes)
    return {
      content,
      truncated: false,
      totalLines: lines.length,
      outputLines: lines.length,
      totalBytes,
      outputBytes: totalBytes,
      maxBytes,
    };
  const kept: string[] = [];
  let outputBytes = 0;
  for (const line of lines) {
    // Every line after the first also carries the newline joining it.
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) break;
    kept.push(line);
    outputBytes += lineBytes;
  }
  return {
    content: kept.join("\n"),
    truncated: true,
    totalLines: lines.length,
    outputLines: kept.length,
    totalBytes,
    outputBytes,
    maxBytes,
  };
}

/**
 * Resolve against the session's cwd, expanding `~` and accepting absolute
 * paths — the same reach the harness's own `bash`/`read` tools already have, so
 * there is deliberately no clamping to the working directory.
 */
function resolveListingPath(input: string | undefined, cwd: string): string {
  const raw = input?.trim() || ".";
  const expanded =
    raw === "~"
      ? homedir()
      : raw.startsWith("~/")
        ? join(homedir(), raw.slice(2))
        : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
