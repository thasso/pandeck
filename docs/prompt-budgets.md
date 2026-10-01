# Prompt and Schema Budgets

Every session pays for its system prompt and its eager tool block before the
user has said anything. That cost is measured per persona and per harness by
`app/server/src/promptInventory.ts` (Task 281) and held against committed
ceilings by `app/server/src/promptBudgets.ts` (Task 288).

The enforced numbers live in `config/prompt-budgets.json` and nowhere else. No
checker, test or document restates them, so there is nothing to keep in sync;
run `pnpm run check:prompts` to see the current usage against them.

## A budget is a tripwire, not a target

The point of a budget is that growth is **deliberate and visible**, not that a
prompt may never grow. A rule that stops a real defect, a tool description that
prevents a misuse, a schema field the model needs — all of these are worth their
characters, and the right response to a breach can be to raise the number.

So: do not contort a prompt to fit. In particular, never fix a breach by
deleting a rule an agent actually needs, compressing prose into telegraphese,
moving text into a layer that happens not to be budgeted, or hiding it behind a
session condition that is on by default anyway. Each of those keeps the number
green and makes the product worse. Trim when the text is redundant or dead;
raise when it is not.

What the budget buys is the moment of choice: a breach forces someone to look at
the diff and decide, instead of letting the first request drift upward one
paragraph at a time.

## What is budgeted

Three limits, per persona and per harness (four personas × two harnesses = eight
budget sets):

| Limit          | Covers                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | every counted prompt layer: harness base, the persona file and its conditional sections, registry/KB/memory guidance, the profile suffix, project context, assembly framing |
| `eagerTools`   | name + description + JSON schema of every tool loaded up front, including pi's provider-native Bash/Monitor shadows and the harness builtins we construct                   |
| `firstRequest` | the two above — what the persona costs before the user's first word                                                                                                         |

`firstRequest` is set **below** `prompt + eagerTools` for every persona (500
characters below, today): a persona may spend the headroom of one or the other,
not both at once. Keep it that way when you change a number — a `firstRequest`
equal to the sum can never breach on its own, which makes it decoration.

Uncounted rows in the inventory (the vendor `claude_code` preset, Claude's
native tool definitions, the deferred tool universe) are reported but never
budgeted — we do not control them, or they do not reach the model up front. The
reasoning behind each exclusion is in the header of `promptInventory.ts`.

## How the numbers are measured

Characters, not tokens: the unit is the input we control and the only one a
committed budget can assert offline (rationale in `promptInventory.ts`). Roughly
four characters per token, and JSON schema text tokenizes denser than prose.

Four normalizations make the measurement reproducible on any machine, which is
what lets CI assert it:

- against this checkout's tracked `config/prompts`, not whatever a running
  server resolved;
- at the working directory `/repo` (`measurement.cwdLabel`), because the cwd
  reaches the prompt twice — pi's own cwd line and the `<project_context>` file
  path — so an un-normalized run counts the checkout's own path length twice
  over (measured: ~2 characters of prompt per character of path; the tool block
  is unaffected);
- at pi's install directory `/pi` (`PI_PACKAGE_LABEL`), because pi's default
  prompt names its own README, docs and examples by absolute path — three times.
  Un-normalized, the pi coding personas measure differently in a CI container
  (`/workspace/...`) than in a developer's checkout, and a pi version bump moves
  the number without moving a character of prompt, because pnpm encodes the
  version in the store path;
- with **every conditional section ON**, so a budget bounds the worst case over
  conditions. A real session with Slack off is smaller;
  `pnpm run measure:prompts` prints what each condition costs.

"Worst case" is therefore worst case over conditions, at normalized paths: a
session running from a 60-character checkout path really carries ~110 characters
more than the snapshot says, and pi's real install path adds roughly three times
its own length again (~675 characters in a pnpm checkout). Both are single-digit
percentages of the headroom, and pricing a path is not what the budget is for.

## The size snapshot

`app/server/src/__snapshots__/prompt-sizes.md` records every layer of every
persona on both harnesses. It is generated, never hand-edited, and it is the
review artifact: a prompt or tool edit lands as a per-layer character delta next
to the change that caused it.

It also gives a breach its attribution — but from **git**, not from the working
tree. By the time a change is reviewed its snapshot has been regenerated, so the
file on disk equals the current sizes and can explain nothing; the check reads
the snapshot as committed at the merge base with `main` (or at `HEAD` when there
is no reachable default branch, which is the right baseline while iterating on
an uncommitted edit) and reports the layers that grew against it, counting a
layer the baseline never had as growth from zero. Where no baseline is reachable
— a shallow clone, or before the snapshot's first commit — the message lists the
limit's largest layers and says only that.

Regenerate it with:

```
pnpm --filter @assistant/server test -u src/promptBudgets.test.ts
```

It holds sizes only — no budgets (a raise must not churn it), no absolute paths
(they differ per machine) and no prompt text (the tracked prompt assets already
show that diff).

## Raising a budget

Raising is a normal, expected edit. It takes two things in the same change:

1. the new number in `config/prompt-budgets.json`;
2. an entry in `raises` recording it:

```json
{
  "budget": "workshop.pi.eagerTools",
  "from": 18500,
  "to": 19500,
  "task": 342,
  "date": "2026-08-14",
  "why": "the review tools' schemas grew with the per-thread anchor fields"
}
```

`why` says what the added characters buy; the loader rejects a stub, and "over
budget" is not a reason. `task` and `date` record who agreed and when. The log
is append-ordered: entries go at the end, and the **last** entry for a budget
must match its current value, so the log cannot go stale. Nothing sorts by
`date`. That applies to lowering a budget after a cleanup too, which is worth
recording for the same reason.

Nothing here is a permission gate: an agent that has read the diff and thinks
the text earns its place should raise the number and say so, not spend the
session shaving adjectives.

## Adding or narrowing a budget

`limits` in the config is a list of selectors over the inventory's layers, so a
new budget is a config edit rather than a code change. A limit sums the
`counted` layers whose `section` it names, optionally narrowed by `layers`
patterns (`*` wildcard):

```json
{
  "id": "toolSchemas",
  "label": "eager tool schemas",
  "sections": ["tools"],
  "layers": ["tools:eager:schemas"],
  "covers": "serialized JSON schemas of the eager tools"
}
```

Every declared limit needs a number for every persona and harness; the loader
refuses a config with one missing and names it, and `pnpm run check:prompts`
prints the measured values to fill in. Adding a limit also means adding a row to
the table above.

A selector that matches nothing is the failure mode to watch for — its budget
would sit at 0 and stay green forever — so the check treats it as an error when
it matches nothing for any persona, and as a warning when it matches nothing for
only some (a limit narrowed to a conditional layer legitimately misses the
personas that do not carry it). Layer ids are exactly those in the snapshot.

## Enforcement

- `promptBudgets.test.ts` asserts the budgets and the snapshot against the same
  baseline the CLI uses, so `pnpm run test` fails on a breach and reads the same
  way.
- `pnpm run check:prompts` prints the full report and exits 1 on a breach, a
  broken selector, a stale or missing snapshot, a stale `raises` entry, or a
  malformed config. CI runs it as its own step so the failure is named in the
  job list, and checks out full history so the merge-base baseline exists. The
  baseline is the merge base with `PA_BASE_REF` when it is set — CI sets it to
  the pull request's base commit, so a PR stacked on another branch is
  attributed against that branch instead of `main` — and with the default branch
  otherwise.
- A limit at or above `warnAtPercentOfBudget` prints a warning and still exits
  0: the signal that the next paragraph will need a decision.

The budgets were first set on 2026-08-03 (Task 288) roughly 10–17% above the
measured sizes of that day (median ~13%, tightest 9.97%), rounded to round
numbers. Nothing about that headroom is sacred; it was chosen to catch drift,
not to price any particular feature.
