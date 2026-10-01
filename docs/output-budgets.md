# Agent tool output budgets

Native tool output is retained for audit without making the same large payload
part of every later provider request. `app/server/src/outputPolicy.ts` owns the
harness-neutral policy; the Claude `PostToolUse` hooks and pi inline extension
apply it before the result enters provider history.

## Budgets and navigation

| Surface                                    |                                                Default retained window |
| ------------------------------------------ | ---------------------------------------------------------------------: |
| Unranged source/document read              |                                      400 lines, then 12,000 characters |
| Unranged `.jsonl`/`.ndjson`/log/trace read |                                      120 lines, then 12,000 characters |
| Explicitly ranged read                     |                requested lines, with a 24,000-character safety ceiling |
| General shell/search output                |                                        160 lines and 12,000 characters |
| Failed shell/quality gate (pi)             |                         relevant tail, 160 lines and 16,000 characters |
| Failed native shell (Claude)               |      vendor 12,000-character cap plus bounded command/conflict context |
| Successful test/typecheck/build/lint/check | command, exit code, and at most eight summary lines / 2,000 characters |

A default read window reports file size when available and gives both previous
and next offsets whenever structured line metadata proves that more content
exists. Without metadata, hitting the injected line limit is the conservative
continuation signal. Log-like reads also tell the agent to use `rg`/`jq` or a
structured summary. An explicit `offset`/`limit` is the exemption for a larger
read range; it is still subject to the safety ceiling so one malformed line
cannot consume the request.

Claude also receives first-line vendor caps (`BASH_MAX_OUTPUT_LENGTH=12000`,
`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=3000`, `MAX_MCP_OUTPUT_TOKENS=5000`,
`TASK_MAX_OUTPUT_LENGTH=12000`) and enables the CLI's large-MCP-output files.
These caps are added to either the profile-scrubbed environment or a copy of the
normally inherited process environment, so sessions without a credential profile
receive them too. The context-aware success/read hooks remain authoritative.
Claude Read handling follows the installed SDK's structured `FileReadOutput`
text variant
(`{ type: "text", file: { content, numLines, startLine, totalLines, ... } }` in
`sdk-tools.d.ts`) and preserves that schema in `updatedToolOutput`; the harness
test uses that exact payload, matching the review-time hook execution probe.
Pi's inline extension is loaded even when discovered extensions are disabled.

## Diagnostics and retained raw output

- Pi shell failures replace the provider-facing result with the command, exit
  code, and bounded tail. Rebase/merge/cherry-pick failures add a compact
  conflict recipe: `git status --short`, `git diff --name-only --diff-filter=U`,
  then `git diff --cc -- <path>`.
- Claude routes native failures through `PostToolUseFailure`; its SDK schema
  permits bounded `additionalContext` but not `updatedToolOutput`. Therefore the
  CLI's `BASH_MAX_OUTPUT_LENGTH` cap bounds the original failure, while the hook
  adds the failed command and the same targeted conflict recipe. Claude's
  failure output is not rewritten into pi's tail shape and does not expose a
  structured exit-code field.
- Broad diffs keep leading hunks and recommend `git diff --stat` followed by
  `git diff -- <path>` rather than another full diff.
- Successful quality gates replace routine progress with the command and final
  summary lines. Failures are never reduced to a success-style summary.
- Only when policy truncation actually removes text from a successful/read
  result is the complete raw result copied to
  `DATA_DIR/session-artifacts/<session>/tool-output/`, registered in the session
  artifact drawer, and linked from the provider-facing notice. A continuation
  annotation alone retains the whole returned window, so it creates no artifact
  or `Full raw output` link; the source path remains the way to request later
  windows. If pi or Claude already produced a full-output temp file for genuine
  elision, that file is copied rather than the vendor's bounded preview. Claude
  failure artifacts remain CLI-owned because `PostToolUseFailure` cannot replace
  or attach an artifact notice to the result.

The main trade-off is that a useful diagnostic can occur outside a failure's
last 160 lines. The full artifact is the escape hatch; callers should then use a
targeted `rg` or bounded read against it. Commands with inherently interactive
or binary output are not summarized specially and remain under the general
character/line ceiling.

Representative behavior is covered by `outputPolicy.test.ts` (build success,
test failure, conflict diagnostics, broad diff, explicit read), plus harness
hook tests. Run the synthetic repeatable benchmark with:

```sh
pnpm --filter @assistant/server measure:output-policy
```

## Benchmark record

The benchmark uses representative generated build, test-failure, diff, and
JSONL-read payloads. UTF-8 bytes are exact. Context occupancy uses the project's
fast 4-characters-per-token estimate; processed input models the retained result
being carried through three subsequent provider requests. Those token rows
demonstrate repeat exposure, not provider billing measurements.

| Metric                                                       |    Before |   After | Reduction |
| ------------------------------------------------------------ | --------: | ------: | --------: |
| Largest result size                                          |  86.0 KiB | 2.6 KiB |     97.0% |
| Retained result bytes                                        | 238.3 KiB | 7.1 KiB |     97.0% |
| Result context occupancy (estimated tokens)                  |    61,015 |   1,827 |     97.0% |
| Processed input over three later requests (estimated tokens) |   183,045 |   5,481 |     97.0% |

| Sample                          |      Raw | Retained | Mode                   |
| ------------------------------- | -------: | -------: | ---------------------- |
| Successful production build     | 86.0 KiB |  0.3 KiB | quality success        |
| Failing test run                | 54.7 KiB |  2.4 KiB | failure tail           |
| Broad diff                      | 60.5 KiB |  1.9 KiB | selected leading hunks |
| Large JSONL default read window | 37.1 KiB |  2.6 KiB | read window            |
