/**
 * Bodies for the native file/shell tools (`read`, `write`, `edit`, `bash`).
 *
 * They deliberately share ONE presentation: the same mono block shell
 * (`.tool-code` in index.css, matching Shiki's), the same single line-number
 * gutter carrying REAL file lines, and the same scroll-don't-wrap default
 * (`wrap` is the chat header's opt-in). A tool body must never render a second,
 * meaningless 1..N gutter beside the numbers the tool itself reported, and never
 * show snippet-relative numbers as if they were file lines — see
 * `lib/toolOutput.ts` for what each harness actually provides.
 */
import { useMemo } from "react";
import { CodeBlock } from "../common/CodeBlock.tsx";
import { CollapsibleOutput } from "../common/CollapsibleOutput.tsx";
import { AnsiText } from "../common/AnsiText.tsx";
import {
  diffMarkdownLines,
  diffMarkdownWords,
} from "../../lib/knowledgeMarkdownDiff.ts";
import {
  bashCommand,
  diffRowsFromRuns,
  markIntralineChanges,
  parseNumberedDiff,
  parseNumberedFileOutput,
  tokenizeCode,
  type ToolDiffRow,
} from "../../lib/toolOutput.ts";

/**
 * A file excerpt: `read` output (either a `cat -n` gutter we lift out, or raw
 * text positioned by the call's `offset`) and `write` content.
 */
export function FileExcerptBody({
  text,
  filename,
  startLine,
  wrap,
}: {
  text: string;
  filename?: string | undefined;
  /** Fallback first line when the payload carries no numbers (pi `read` offset). */
  startLine?: number | undefined;
  wrap: boolean;
}) {
  const parsed = useMemo(() => parseNumberedFileOutput(text), [text]);
  const code = parsed ? parsed.code : text;
  const first = parsed ? parsed.startLine : Math.max(1, startLine ?? 1);
  return (
    <>
      <CodeBlock
        code={code}
        filename={filename}
        showLineNumbers
        startLine={first}
        wrap={wrap}
      />
      {parsed?.notice ? (
        <div className="mt-1 px-1 text-sm text-muted-foreground">
          {parsed.notice}
        </div>
      ) : null}
    </>
  );
}

const ROW_CLASS: Record<ToolDiffRow["kind"], string> = {
  add: "tool-diff-add",
  del: "tool-diff-del",
  context: "",
  gap: "tool-diff-gap",
};

const SIGN: Record<ToolDiffRow["kind"], string> = {
  add: "+",
  del: "-",
  context: " ",
  gap: " ",
};

/**
 * Diff rows in the same block shell as `FileExcerptBody`: one gutter (the real
 * file line when the provider positioned the diff, blank otherwise), a sign
 * column, whole-line add/remove colouring AND word-level marks inside replaced
 * lines (`markIntralineChanges`) — the intra-line detail the @pierre/diffs
 * surface gives the worktree views, without pulling that stack into the
 * transcript chunk. Truncation is `CollapsibleOutput`'s: every row is exactly one
 * line, so the visible line count is the visible row count.
 */
function ToolDiffRows({ rows, wrap }: { rows: ToolDiffRow[]; wrap: boolean }) {
  const numbered = rows.some((row) => row.line !== undefined);
  const width = numbered
    ? String(Math.max(...rows.map((row) => row.line ?? 0))).length
    : 0;
  return (
    <CollapsibleOutput
      text={rows.map((row) => row.text).join("\n")}
      renderContent={(visible) => (
        <pre
          className={`tool-code ${wrap ? "tool-code-wrap" : "overflow-x-auto"}`}
        >
          <code>
            {rows.slice(0, visible.split("\n").length).map((row, index) => (
              <span
                key={index}
                className={`tool-code-row ${ROW_CLASS[row.kind]}`}
              >
                {numbered ? (
                  <span className="tool-code-num">
                    {row.line === undefined
                      ? ""
                      : String(row.line).padStart(width, " ")}
                  </span>
                ) : null}
                <span className="tool-code-sign">{SIGN[row.kind]}</span>
                {row.segments
                  ? row.segments.map((segment, segmentIndex) =>
                      segment.changed ? (
                        <span key={segmentIndex} className="tool-diff-word">
                          {segment.text}
                        </span>
                      ) : (
                        <span key={segmentIndex}>{segment.text}</span>
                      ),
                    )
                  : row.text}
              </span>
            ))}
          </code>
        </pre>
      )}
    />
  );
}

/**
 * An `edit` call. Prefers the provider's positioned diff (`resultDiff`, pi's
 * `details.diff`) so the gutter shows the lines that actually changed; otherwise
 * diffs the call's own old/new strings and shows NO numbers rather than
 * snippet-relative ones.
 */
export function EditDiffBody({
  resultDiff,
  edits,
  wrap,
}: {
  resultDiff?: string | undefined;
  edits: Array<{ oldText: string; newText: string }>;
  wrap: boolean;
}) {
  const rows = useMemo(() => {
    const positioned = resultDiff ? parseNumberedDiff(resultDiff) : null;
    const lineRows = positioned ?? computedRows(edits);
    return markIntralineChanges(lineRows, (oldText, newText) =>
      diffMarkdownWords(oldText, newText, { tokenize: tokenizeCode }),
    );
  }, [resultDiff, edits]);
  if (rows.length === 0) return null;
  return <ToolDiffRows rows={rows} wrap={wrap} />;
}

function computedRows(
  edits: Array<{ oldText: string; newText: string }>,
): ToolDiffRow[] {
  const out: ToolDiffRow[] = [];
  edits.forEach((edit, index) => {
    if (index > 0) out.push({ kind: "gap", text: "…" });
    out.push(
      ...diffRowsFromRuns(diffMarkdownLines(edit.oldText, edit.newText)),
    );
  });
  return out;
}

/**
 * A `bash` call rendered as a shell session: the full command that ran (the
 * collapsed header only carries a truncated summary) followed by its output,
 * which grows live while the call is still running (pi streams bash output
 * through `tool_execution_update`).
 */
export function BashBody({
  args,
  output,
  running,
  wrap,
}: {
  args: unknown;
  output: string;
  running: boolean;
  wrap: boolean;
}) {
  const command = bashCommand(args);
  const hasOutput = output.trim().length > 0;
  const shell = (body: React.ReactNode) => (
    <pre className={`tool-code ${wrap ? "tool-code-wrap" : "overflow-x-auto"}`}>
      <code>
        {command !== null ? (
          <span className="tool-code-row">
            <span className="tool-code-prompt">$ </span>
            {command}
          </span>
        ) : null}
        {body}
      </code>
    </pre>
  );

  if (!hasOutput) {
    return shell(
      <span className="tool-code-row text-muted-foreground">
        {running ? "Running…" : "(no output)"}
      </span>,
    );
  }
  return (
    <CollapsibleOutput
      text={output}
      renderContent={(visible) => shell(<AnsiText text={visible} />)}
    />
  );
}
