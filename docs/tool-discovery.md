# Deferred tool discovery

## Loading tiers

The catalog in `app/server/src/tools/catalog.ts` is the source of truth for each
persona. Eager groups are definitions on the first request. Deferred groups are
registered but discovered on demand: pi uses the app-owned `find_tools`; Claude
uses the CLI's native ToolSearch. Integration gates still decide usability and
never make a deferred tool eager.

`pnpm run measure:tools` reports the current per-persona and per-group
definition characters, activation precision, unused loaded characters, provider
cache hits, and opt-in pi payload-prefix captures. Task-264's deleted
`task-workflow` family (3,363 definition characters on coding personas) is
reported separately rather than credited to discovery. Set
`ASSISTANT_TOOL_PAYLOAD_PROBE_FILE=/path/to/probe.jsonl` before real pi turns to
capture content-free request size/hash/common-prefix metrics through pi's
`onPayload` hook; request bodies are never persisted.

## pi discovery contract

`find_tools` supports two paths:

- `names` activates exact known ids without ranking. Unknown and gate-disabled
  names are explicitly reported.
- `query` ranks whole normalized tokens. Token weights are inverse document
  frequency over the current persona catalog, so catalog-wide common words
  become stopwords without a hand-maintained list. Tool-name matches outweigh
  description matches; adjacent phrases and multi-token group coherence add a
  bonus. Results must meet both an absolute floor and 50% of the top score. They
  default to the top coherent group; a second group is admitted only when
  several qualifying tools support it and direct name/phrase evidence shows
  genuine multi-family intent. Calls default to four tools and cap at eight.

A low-confidence or closely split query loads nothing. It returns compact
candidates (name, group, one-line summary), and the model recalls `find_tools`
with exact `names`. This second call is load-bearing: replaying 175 historical
activations showed that ranking alone traded recall roughly one-for-one for
precision. Family `searchHint`s and de-genericised group descriptions therefore
ship with the scorer and are also projected as Claude's `anthropic/searchHint`
metadata.

Regression examples are executable in `findTools.test.ts`: “read another session
transcript” and “look at what another agent session did” rank session tools
first and no longer elevate Jira from substring matches such as `at` in
“approval-gated”. Broad cross-family wording returns candidates. The historical
false-negative case named `session_submit_result` but loaded unrelated tools;
structured `names` now activates it exactly. Candidate fallback is the explicit
answer to remaining ranking false negatives rather than silently broadening the
load.

## Provider placement and cache evidence

Deferred definitions do not join the original request prefix. Anthropic records
them as `tool_reference` blocks on historical tool results; OpenAI Responses
records synthetic `tool_search_call`/`tool_search_output` items after the
function output. Removing one therefore rewrites history from that activation
point, which is why ordinary per-turn pruning would lose useful tail-cache hits.

The table below was measured from Claude CLI request history. The app's pi logs
persist usage per turn rather than per provider call, so OpenAI Responses prefix
divergence remains a separate measurement: the opt-in `onPayload` probe records
real adjacent payload prefix ratios without retaining content. `measure:tools`
reports those captures beside cache hits/misses instead of pretending the two
providers have identical evidence.

## Activation lifetime

Activation is additive during ordinary live work. Aggressive turn-by-turn
removal is deliberately forbidden because most user boundaries retain the
provider tail cache:

| idle gap  | measured cache hit |
| --------- | -----------------: |
| <5 min    |                91% |
| 5–10 min  |                98% |
| 10–30 min |                96% |
| 30–60 min |                94% |
| 1–2 h     |                18% |
| 2–24 h    |                24% |

The median boundary was 8.3 minutes. Boundaries at least six hours apart were
only 3.8%; at least twelve hours, 1.1%. Beyond an hour, the median cache read
was zero. Remaining long-gap hits repeatedly covered shared cross-session
prefixes (10,618 and 32,260 tokens), which sit before deferred definitions.

Consequently:

1. Reopen is cold and seeds only deferred definitions that the transcript
   actually called.
2. A live user-turn boundary prunes never-called deferred loads only after six
   idle hours (`UNUSED_TOOL_PRUNE_IDLE_MS`). Called tools, eager tools,
   `find_tools`, and pi builtins survive. Active-set changes still flow through
   `mergedActiveToolNames`, reasserting extra builtins.
3. Tool activation and pruning leave pi's system prompt byte-identical. The
   historical tool-result position may change after a cold prune, but the
   surviving shared prefix cannot.

The six-hour threshold assumes today's short/implicit provider cache tier and
must be remeasured if cache-retention configuration changes.

## Diagnostics

`SessionToolExposure` reports each definition's exact character size and whether
it was called, plus loaded-but-unused count and characters. The Tools inspector
shows these values for both harnesses. Claude reports what its native context
usage says is loaded; the app measures its ToolSearch behavior but does not try
to rescore or prune vendor-owned context.
