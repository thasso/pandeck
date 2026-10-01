# Linting and compiler strictness

The repo's static gates are four, in order of authority:

1. **`tsc --noEmit`** (`pnpm run typecheck`) — the authority on what typechecks.
2. **ESLint** (`pnpm run lint`) — type-aware rules for mistakes the compiler
   permits.
3. **knip** (`pnpm run lint:deadcode`) — the module boundary the compiler cannot
   see: an export nothing imports.
4. **Prettier** (`pnpm run format`) — formatting, and formatting only.

`pnpm run lint` is blocking: `--max-warnings 0`, and
`reportUnusedDisableDirectives: "error"` so a suppression that no longer
suppresses anything fails too. It runs in its own CI job and inside
`pnpm run test`. On the 24-core runner a cold lint measured 110s serial, 60s
with two ESLint workers, 43s with four, 50s with eight, and 64s with `auto`; CI
therefore uses four workers for a cold cache. A restored run stays serial: it is
about 2s, while starting four workers raises it to about 3s and triggers
ESLint's poor-concurrency warning. The React-compiler rules dominate the cold
path; the cache carries their results too.

The cache uses `--cache-strategy content`: the default keys on mtime, which a
fresh checkout invalidates wholesale, and content hashing is what lets CI
restore it at all (`docs/ci-cd.md` — CI restores it on pull requests only,
because ESLint's cache cannot see cross-file type dependencies). CI chooses the
worker count by whether that restore produced a cache file, so a cache miss gets
the four-worker path rather than paying the 110s serial fallback.

## The two TypeScripts, and why

The workspace compiles with `typescript@7`, the native port. It ships **no
JavaScript compiler API**: `ts.createProgram`, `ts.SyntaxKind` and the project
service are all absent, and typescript-eslint's peer range excludes it. So the
linter runs on `typescript@6` — the last release of the JS-based compiler, whose
API is exactly what type-aware linting needs.

- `pnpm-workspace.yaml` `catalog.typescript` (7.x) is what each package's `tsc`
  uses. It decides what compiles.
- `pnpm-workspace.yaml` `catalogs.lint.typescript` (6.x) is a **root**
  devDependency only, consumed by typescript-eslint.

They can disagree. When they do, **tsc wins** — it is the compiler that actually
builds the app. One rule has already been staged off for exactly this reason
(see `no-unnecessary-type-assertion` below), and any autofix from a type-aware
rule must be re-checked with `pnpm run typecheck` before it is trusted.

## Compiler options

`tsconfig.base.json` at the repo root holds every option the three packages
share, so they cannot drift; each package's `tsconfig.json` extends it and adds
only what is genuinely local (module resolution, `lib`, `jsx`, `types`). The
solution-style root `tsconfig.json` has no files of its own and references those
three package configs. `eslint-import-resolver-typescript` consumes that
reference graph instead of globbing three separate projects. The resolver was
the source of the misleading “Multiple projects found” lint warning — not the
typescript-eslint project service — and this removes the warning without
silencing it. It did not materially change the cold timing; ESLint worker
concurrency is the speedup.

On everywhere: `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

`noPropertyAccessFromIndexSignature` is deliberately **not** enabled: 3204 sites
in the server alone, and it buys style rather than safety.

## `exactOptionalPropertyTypes`

It is **on in all three packages**, from `tsconfig.base.json`, with no package
overriding it. It separates an ABSENT optional property from one explicitly set
to `undefined` — the bug class an agent introduces by spreading a partial into a
wire message, which matters here because this is a wire protocol over a
persistence layer. It cost 917 sites to turn on.

### Writing new code under it

At a USE site, in preference order:

```ts
// 1. cheap value (identifier, `this.x`, a property chain): guard in place
{ ...(title !== undefined ? { title } : {}) }

// 2. already a ternary: fold it, so the condition is evaluated once
{ ...(cond ? { title: label } : {}) }

// 3. computed value: bind first, so it is evaluated exactly once
const dueDate = normalizeDateOnly(input.dueDate);
{ ...(dueDate !== undefined ? { dueDate } : {}) }
```

Match the operator you are replacing: `a ?? undefined` drops null as well, so it
becomes `a != null`, while `a || undefined` is falsy-based and becomes `a ?`.

To CLEAR a field, use `delete obj.k` (mutable record) or `Patch`/`applyPatch`
(below). Never assign `obj.k = undefined`.

### The two legitimate reasons to write `?: T | undefined`

Everything else defeats the flag, so each of these needs the reason on it.

- **A React component prop.** `<C x={maybe} />` and omitting `x` are
  indistinguishable to React — both leave `props.x === undefined` — so a prop
  really does accept undefined, and saying it once at the declaration beats a
  conditional spread at every call site. This is by far the biggest group (365
  of the 369 widenings in this repo).

  A mapped-type wrapper CAN express this —
  `{ [K in keyof T]: undefined extends T[K] ? T[K] | undefined : T[K] }` widens
  optional props while keeping required ones required and still rejecting
  undefined on them, verified under the flag. It is deliberately not used. It
  would save ~192 component signatures, but it HIDES the widening from anyone
  reading the interface, it has to be applied consistently everywhere a props
  type is exported, `Pick`ed or composed or the wrapped and unwrapped forms
  silently diverge, and an explicit `?: T | undefined` is greppable — which is
  what makes this rule enforceable at all. Do not re-propose the wrapper.

- **A record whose job is to store what it was handed**, i.e. a test double
  capturing call arguments, or a structural "source" interface describing an
  object being read whose own field is `T | undefined`.

A patch is NOT one of these — it has its own type, below.

### Patches: `undefined` means "clear this field"

`Partial<T>` cannot express a clearing patch under this flag: it maps `k?: V` to
`k?: V`, so `{ k: undefined }` is rejected and the only way to make the call
compile is to drop the key — which means the OPPOSITE thing, leaving the old
value in place. `app/shared/protocol.ts` therefore carries two helpers:

- **`Patch<T>`** — `{ [K in keyof T]?: T[K] | undefined }`. The parameter type
  of anything that patches by merging: `patchPullRequestCard`, `patchCard` in
  `pendingApprovals`, the workflow `updateCard` seam, and the test fixture
  factories whose overrides deliberately clear a default.
- **`applyPatch(base, patch)`** — apply one. Use it instead of
  `{ ...base, ...patch }`, which leaves a cleared key PRESENT with the value
  `undefined`: a shape the base type says cannot exist, and one `JSON.stringify`
  then drops, so the object in memory stops matching the one on disk and on the
  wire. Deleting the key keeps all three in agreement.

### Where judgment was needed

The mechanical part is guarding a use site. The part that is not:

- **Spread-over-merge.** `{ ...base, ...{ k: undefined } }` OVERWRITES `base.k`;
  omitting the key preserves it. Only a spread whose keys are NOT statically
  known is a hazard — a spread of literals, including `...(c ? { a } : {})`,
  provably cannot supply some other key. Real clearing sites found this way
  include the credential-clearing paths in
  `braveSettings`/`openAiCompatibleSettings`/ `context7Settings`,
  `pullRequestActions`' `busyAction`, and the attachment payload stripped in
  `sessionPreviewStore`.
- **Hoisting a value out of a guard.** Binding a computed value to a const must
  not move it across a conditional edge: `cond && x ? { k: f(x.y) } : null`
  hoisted above the ternary evaluates `f(x.y)` when `x` is null. That is a
  TypeError, not a type error.
- **`delete obj.k` versus never setting `k`**, and mutable accumulators built
  then assigned — `MutableTurn` in `sessionAudit.ts` guards each assignment
  rather than widening, because its consumers all guard when projecting.

### What the flag buys the `Partial<T>` spreads that remain

`...patch` over a base is still the right code where the patch is NOT meant to
clear anything, and those sites are now PROTECTED rather than hazardous:
`pushWorkflow.ts:133`, `projectRegistry.ts:313` and `commitWorkflow.ts:987`/
`:1197` keep plain `Partial<T>`, and because `Partial<T>` under this flag
rejects an explicit `undefined`, a caller can no longer pass one and clobber a
default the base had set. The distinction is now in the type: `Partial<T>` means
"cannot clear", `Patch<T>` means "may clear".

`scripts/codemods/` holds the transformations that did the mechanical 80%, with
notes on what each one refuses to decide; a rebase re-runs them.

## The ruleset

ESLint carries no stylistic rules. `typescript-eslint`'s `stylisticTypeChecked`
preset is deliberately not extended — Prettier owns formatting, and the rest of
that preset (`array-type`, `consistent-type-definitions`,
`prefer-nullish-coalescing`, …) is taste, not correctness.

What is on: `recommendedTypeChecked`, plus `await-thenable`,
`switch-exhaustiveness-check`, `no-import-type-side-effects`, `no-unused-vars`
with `^_`, `import-x`'s `no-duplicates`/`no-self-import`, `eqeqeq`,
`no-constant-binary-expression`, `prefer-const`, `no-fallthrough`,
`only-throw-error`, `prefer-promise-reject-errors`,
`restrict-template-expressions`, `no-floating-promises`, `no-misused-promises`,
`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`,
`react-hooks/purity`, `react-hooks/immutability`, and `@vitest/eslint-plugin`'s
`no-focused-tests`/`no-disabled-tests`/`no-identical-title` — a stray `.only`
silently disabling a test file is invisible to CI otherwise.

`import-x`'s resolution rules (`no-unresolved`, `default`, `namespace`,
`no-named-as-default*`) are off: tsc already resolves every import and is
stricter about it, and import-x only produces false positives for NodeNext
exports maps, `?worker` queries and CJS default interop.

`react-hooks/purity` blocks render-time clocks and randomness from changing the
component tree for identical inputs — including unstable list keys that remount
rows and lose their DOM and component state. `react-hooks/immutability` also
catches a closure read before its declaration, which prevents the compiler from
tracking its later value.

### The free tier: rules adopted at zero

A second group is on for a different reason. Each of these was measured at
**zero findings across the whole repo** before it was turned on, so adopting it
cost no code change at all. They find no bug that exists today; they make a
class of mistake unwritable tomorrow, which is what this gate is for when the
author is an agent. A rule in this group is NOT a backlog item and does not
belong in the staged table below — that table is for rules with work attached.

- **Silent no-ops.** `no-self-compare`, `no-template-curly-in-string`,
  `no-unreachable-loop`, `no-constructor-return`, `default-case-last`,
  `no-return-assign`, and `array-callback-return` — a `.map` callback that falls
  off the end yields an array of `undefined` and nothing complains.
- **Types that lie.** `related-getter-setter-pairs`, `default-param-last`,
  `no-non-null-asserted-nullish-coalescing` (`a! ?? b` kills its own fallback),
  `prefer-return-this-type`, `no-useless-empty-export`, and
  `no-unnecessary-type-arguments`.
- **`return-await`, in `error-handling-correctness-only` mode.** This option is
  load-bearing. Returning a promise from inside a `try` without awaiting it
  escapes the `catch` and `finally` entirely — that is the correctness case, and
  it is at zero. The other modes are style calls the repo does not make and are
  NOT clean here: the default `in-try-catch` reports 12 sites in 6 files and
  `always` reports 175 in 51. Do not "simplify" the option away.
- **Module graph.** `import-x`'s `no-useless-path-segments`,
  `no-empty-named-blocks` and `no-mutable-exports` — an exported `let` is shared
  mutable state whose writer is invisible from the call site.
- **The React compiler's rules.** `eslint-plugin-react-hooks` v7 ships far more
  than `rules-of-hooks` and `exhaustive-deps`; eleven of the thirteen additional
  rules that are on were adopted at zero: `set-state-in-render`,
  `static-components`, `error-boundaries`, `use-memo`, `void-use-memo`,
  `memoized-effect-dependencies`, `exhaustive-effect-dependencies`,
  `incompatible-library`, `unsupported-syntax`, `config` and `gating`. The last
  four fire when the compiler cannot reason about a file, which would silently
  weaken the other seven, so they are errors rather than the preset's warnings.
  This block is the whole cold-lint cost (see the timings above): it is the one
  part of this group that is not free, and the trade is 30s of CI for the
  remount-on-every-render and stale-memo classes.
- **Assertions that never assert.** `@vitest/eslint-plugin`'s `valid-expect`,
  `valid-expect-in-promise`, `no-standalone-expect`,
  `require-awaited-expect-poll`, `no-unneeded-async-expect-function`,
  `no-commented-out-tests`, `no-alias-methods`, `prefer-vi-mocked` and
  `no-duplicate-hooks`. `valid-expect` runs with `maxArgs: 2`, also
  load-bearing: Vitest's `expect(value, message)` is real API that this repo
  uses, and the default of 1 flags 11 legitimate call sites across 6 test files.

The bar for adding to this group is the same one it was built on: measure with
`eslint --no-cache -f json` first, and adopt only at zero. A rule that reports
even one finding is a staged rule with a backlog, not a free one — and the
answer is never a suppression or a code change bent to fit the rule.

Zero has a second reading here, and it is the trap this group is most exposed
to: a rule that is **inert** measures zero too. A removed rule name can survive
as a deprecated tombstone whose `create()` returns `{}`, so it configures
cleanly, lints nothing, and reports nothing —
`react-hooks/component-hook-factories` is exactly this in v7 and is deliberately
NOT in the config; `static-components` covers the factory case at the use site.
So a zero measurement is only half the evidence. The other half is a **positive
control**: write a file that violates the rule, confirm the rule reports it,
then delete the file. Adopt no rule here on a zero alone.

### What `switch-exhaustiveness-check` actually guarantees

Less than its name suggests, and the gap is worth knowing. It runs with
`considerDefaultExhaustiveForUnions: true`, so **a switch carrying a `default:`
counts as exhaustive** and a newly added union variant will not fail the build
there. The guarantee is therefore: a switch over a union with NO `default:` must
handle every member.

That exempts the surfaces the rule is most wanted for — the client/server
message dispatchers in `connection.ts` and `useAssistant.ts`, and the adapter
routers — because they are intentionally partial and funnel the remainder
through a default. Tightening the option to `false` is staged in the table
below.

The consequence for new code: when a switch must handle a value that can also be
`undefined`, **narrow the `undefined` out before the switch** rather than
absorbing it in a `default:`. A default silently opts that switch out of
exhaustiveness checking for every future variant; an early return does not.
`decideNextStep` in `workflow/codeDeliveryRecipe.ts` is written this way.
Several older switches (`apns.ts`, `claudeSdk/ClaudeSdkSession.ts`,
`tools/github/githubTools.ts`) still use the `default:` form; they are part of
the staged 18 and convert when the option flips.

### `exhaustive-deps` is a behaviour gate, not hygiene

A dependency array decides when an effect re-runs, so a breach is never fixed by
stuffing the array: adding a dependency that churns causes loops and
re-subscription storms, and removing one freezes stale state. The fixes that
hold, in the order they are usually right:

- **Depend on the stable part.** A controller object rebuilt on every reply
  (`useMemory`, `useAssistant`'s `state`) must not be a dependency; its
  `useCallback` methods can be, so destructure the method. A dependency that
  churns because its producer allocates is fixed at the PRODUCER — bail out of
  the state write when the content is unchanged, or memoize the projection.
- **A `useRef` for a value that must not retrigger.** Where a token or key is
  the trigger and everything else is read at the moment it fires, latch the rest
  through a ref rather than listing it. Say why in a comment; the ref is the
  claim, the comment is the evidence.
- **`useCallback`/`useMemo` on the dependency itself**, when the value is
  genuinely derived and its identity is what churns.

The ONE deliberate omission is the **content key**: a memo keyed on a hash of a
value's content so its identity changes only when the content does
(`lib/worktreeDirty.ts`, `lib/workflowIndicator.ts`, `lib/sessionRows.ts`,
`lib/transcriptKeys.ts`). The key IS the dependency contract, the array it
replaces is rebuilt on every broadcast, and the memo it feeds is decorative
without it. Those sites carry an `eslint-disable-next-line` **on the dependency
array line** with a reason naming the key and what depending on the array would
re-render. There are five in the tree; a sixth has to make the same argument.

Coverage is not limited to TypeScript: `scripts/**/*.mjs`, `eslint.config.js`
and the production service worker `app/web/public/sw.js` are linted with
`js.configs.recommended` and their own globals. Generated `assistant-data/` is
ignored at any directory depth, including a package-local runtime directory
created when the server runs from a worktree. `app/web/src/lib/pcm16Worklet.js`
is deliberately ignored — it runs on the audio render thread, whose globals are
its own.

## Staged rules

The TypeScript, React, and Vitest config blocks list rules that are **off with a
measured backlog**. They are not rejected — each is a real signal, and each was
measured before it was staged (the last option rows are on rules that are
already on, measured when those rules were adopted).

Every number below was re-measured at **b887a1f2**. A count is a measurement
anchored to a commit, not a standing fact: nine of the rows below had drifted
upward from their original figures by the time they were refreshed, because the
codebase grew and the backlogs grew with it. Re-measure with
`eslint --no-cache -f json` before adopting one, and never adjust a number to
match a guess.

| rule                                                                           | sites | files |
| ------------------------------------------------------------------------------ | ----- | ----- |
| `require-await`                                                                | 1091  | 158   |
| `no-unsafe-member-access`                                                      | 892   | 52    |
| `no-unsafe-assignment`                                                         | 646   | 68    |
| `no-unnecessary-type-assertion`                                                | 556   | 175   |
| `no-explicit-any`                                                              | 268   | 38    |
| `no-base-to-string`                                                            | 160   | 40    |
| `consistent-type-imports`                                                      | 134   | 65    |
| `no-unsafe-argument`                                                           | 107   | 30    |
| `no-unsafe-call`                                                               | 60    | 19    |
| `no-unsafe-return`                                                             | 49    | 25    |
| `unbound-method`                                                               | 43    | 26    |
| `vitest/expect-expect`                                                         | 38    | 24    |
| `preserve-caught-error` (TS)                                                   | 34    | 29    |
| `no-useless-assignment`                                                        | 19    | 17    |
| `switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: false` | 18    | 15    |
| `@typescript-eslint/no-deprecated`                                             | 12    | 6     |
| `react-hooks/no-deriving-state-in-effects`                                     | 3     | 3     |
| `import-x/no-cycle` with `allowUnsafeDynamicCyclicDependency: false`           | 49    | 46    |

Adopt them **one rule per change, smallest job first** — which is not the same
as smallest count, see below: clear the rule's list, delete its line, and the
gate tightens permanently.

Two entries will never reach zero that way. `no-deprecated`'s three MCP SDK
sites can be migrated, but its nine browser-compatibility sites keep the rule
off until those fallbacks are no longer required; repo policy does not trade
them for scattered suppressions. And `no-unnecessary-condition` is off for a
reason that is not its size at all.

Several entries cost far more than their number suggests, which is why the order
is by job and not by count. The clearest case: the smallest entry in the table
is `no-deriving-state-in-effects` at 3, and it is among the largest jobs on it.
Several of the small counts are not small jobs — read the note on an entry
before planning against its number.

`react-hooks/no-deriving-state-in-effects` owns three different synchronization
contracts: expandable navigator state seeded from a changing file tree,
browser-persisted viewed paths keyed by worktree and scope, and an optimistic
Task order reset by authoritative server replies. Removing those effects means
redesigning state ownership in each hook, not deleting redundant state.

`vitest/expect-expect` cannot follow assertions hidden behind a test function or
an awaited standalone `main()`. The remaining shape is older test modules whose
assertions deliberately run during module evaluation and whose `test()` body is
empty. Moving both shapes into test callbacks is a test-architecture change.

`@typescript-eslint/no-deprecated` has 12 residual sites. Nine are deliberate
browser compatibility: eight `caretRangeFromPoint` uses preserve Safari support
where `caretPositionFromPoint` is absent, and `execCommand` is the clipboard
fallback. Three `Server` uses require the MCP SDK's `Server` → `McpServer` API
migration, including construction and session wiring, rather than a type rename.

`switch-exhaustiveness-check`'s 18 is not the smallest job: `connection.ts`
would need dozens of no-op cases, while `peerPrompt.ts` (missing `"failed"`) and
`KnowledgeBrowser.tsx` (missing `"file"`) are one-liners.
`preserve-caught-error` is staged for TypeScript only — it is already **on and
blocking** for `scripts/**/*.mjs`, which inherit `js.configs.recommended` rather
than the staged block.

`no-unnecessary-type-assertion` is staged for a second reason: its autofix, run
on TypeScript 6, removed assertions TypeScript 7 still requires and broke the
build. Adopt it only with `pnpm run typecheck` after every fix.

The last row is not a rule but an OPTION on a rule that is already blocking —
the same shape as the `switch-exhaustiveness-check` row above it. Its 49 are not
49 unfixed cycles: they are import sites on chains that pass through one of the
four deliberate lazy `hub.ts` seams. Nothing is waiting on it for correctness —
knip's `cycles` gate already proves the static graph acyclic. See "What
`import-x/no-cycle` actually guarantees".

### Why `no-unnecessary-condition` is not on the staged list

It is not staged pending a cleanup. It is rejected, and the reason is worth
recording because its headline number invites someone to schedule it.

At b887a1f2 it reports 877 sites across 290 files: 592 `neverOptionalChain` (an
optional chain on a value that is never nullish), 116 `neverNullish` (an `??`
whose left side is never nullish), 61 `comparisonBetweenLiteralTypes`, 53
`alwaysFalsy`, 41 `alwaysTruthy`, 12 `noOverlapBooleanExpression`, 2
`alwaysNullish`. The first two are mostly cosmetic, and largely the
conditional-spread idiom `exactOptionalPropertyTypes` deliberately introduced.
Reading the 12 strongest findings, the ones where the types have no overlap,
shows what the rule would do here:

```ts
// promptBudgets.ts — validating a persona parsed out of a config key
const known =
  AGENT_TYPE_LIST.includes(persona as AgentType) &&
  ...
  budgets[persona as AgentType] !== undefined; // flagged as "unnecessary"
```

The index cannot be `undefined` only because of the `as AgentType` cast three
lines up. At runtime `persona` is a substring of a user-authored config key and
can be anything at all. `tempoTools.ts` has the same shape guarding untrusted
tool input.

So the rule's sharpest signal, in this codebase, points at **runtime guards that
exist precisely because a cast made the type system stop checking**. Acting on
it deletes validation at a trust boundary and turns the gate green for it — the
opposite of what a guardrail is for. A rule whose strongest findings must be
ignored is worse than an absent rule, because a staged entry implies an intent
to adopt.

If the `as` casts at those boundaries are ever replaced by real parsing that
narrows honestly, this decision is worth revisiting; until then the rule stays
off and off the list.

### What `import-x/no-cycle` actually guarantees

**Two gates cover circular dependencies, and neither is redundant.**
`import-x/no-cycle` is on and blocking, and gives the per-import-site diagnostic
— which import, on which line, closes which chain. **knip's `cycles` category is
what proves the static value graph acyclic**, gated at zero in
`config/deadcode-budgets.json`. The ESLint rule alone cannot make that claim
here, and the reason is worth stating exactly:

- **A type-only import is never a cycle.** `verbatimModuleSyntax` erases it, so
  it cannot be a load-order hazard, and the rule skips `import type` (and an
  import whose every specifier is `type`) at both ends of the traversal. So it
  is about the RUNTIME graph, not the type graph: `tools/catalog.ts` and
  `promptConditions.ts` still refer to each other's types, deliberately.
- **`allowUnsafeDynamicCyclicDependency: true` is coarser than "permits a chain
  containing a lazy edge".** In the rule's traversal the dynamic-edge check is a
  `return`, not a `continue`, and it sits BEFORE the cycle check:

  ```js
  if (
    options.allowUnsafeDynamicCyclicDependency &&
    toTraverse.some((d) => d.dynamic)
  )
    return; // abandons this module entirely
  if (path === filename && toTraverse.length > 0) return true; // the cycle check, not reached
  ```

  So the FIRST dynamic edge met while iterating a module's imports ends
  detection for that module — it does not merely skip that edge. Measured, not
  inferred: a purely static two-module cycle between `sessionActivity.ts` and
  `pendingApprovals.ts` (both hold lazy `hub.ts` imports) passes `pnpm run lint`
  and fails `pnpm run lint:deadcode`.

The option is set anyway, because the four modules that reach `hub.ts` back
lazily — `sessionActivity.ts`, `pendingApprovals.ts`, `pullRequestCards.ts`,
`peerPrompt.ts` — do it precisely so the static graph stays acyclic, each with a
comment saying so. Rejecting that would push them onto a startup-ordered
injection seam: a self-healing lazy read traded for one that silently does
nothing if a setter never ran, and two of the four already swallow failure in a
`catch {}`. Tightening the option to `false` is staged at 49 sites / 46 files;
until then knip is what holds the line, which is why the category is declared.

Breaking a cycle is a design decision, so the shapes used here are worth naming.
In order of preference:

1. **Extract the shared lower layer into a leaf** — the honest fix when two
   modules import each other because one of them holds something that is really
   beneath both: `worktrees/worktreeResolve.ts` (identity/resolution, out of
   `worktrees.ts`), `mcp/toolGroups/packRuntime.ts` (what a pack definition is
   built from, out of `registry.ts`), `tools/toolPolicy.ts` (gates and Plan
   mode, out of `catalog.ts`), `claudeSdk/modelSettings.ts` (the persona-free
   half of `options.ts`), `web/components/AgentModelFields.tsx`.
2. **Hand the dependency down as data.** `tools/catalog.ts` composes every tool
   module, so nothing under `tools/` may read it back; where a tool genuinely
   needs the catalog, the catalog passes it in — `sessionAuditTools(inventory)`,
   and `SessionToolServerConfig.searchHint`.
3. **Delete a convenience re-export.** `agents.ts` re-exported the catalog's
   integration-tool API purely so callers had one import site; that alone put
   the persona registry in a cycle with the catalog.

## Dead code: the gate at the module boundary

> An export needs a consumer outside its own file; knip enforces it.
> Un-exporting hands the symbol to `noUnusedLocals`, so the compiler takes over
> from there.

That is the whole policy. No per-export comment or justification is required or
wanted: the export plus its importer is complete information and `grep` finds
it, so a reason comment would only restate what the gate already guarantees.

### Why the compiler cannot do this

`noUnusedLocals` is **file-local**, and not by omission. `tsc` checks one
program at a time and a module's exports are its public API, so an export has no
observable "unused" state inside the file that declares it. Measured on this
repo: an unexported unused interface errors with `TS6196`, and adding `export`
to the same declaration silences it. The compiler guards the interior; nothing
in it guards the boundary.

knip is what guards the boundary. It resolves the whole workspace from a set of
entry points and reports what nothing reaches.

### The gate, and where it lives

`config/deadcode-budgets.json` is the source of truth. knip has no numeric
threshold — it exits non-zero on the first finding — so
`scripts/check-deadcode.mjs` runs it, counts findings per category, and fails on
a category that **exceeds** its committed number. Nothing else restates a count.

**`budgets` is empty, and every one of the 15 categories is gated at zero.** The
gate is closed: unused exports, unused exported types, unused files, duplicate
exports, unused/unlisted/unresolved dependencies and optional peers, unlisted
binaries, catalog entries and references, enum members, namespace members and
circular dependencies all fail on the first finding. An export must have a
consumer outside its own file — full stop, no staged pool to add to.

`cycles` is the one category knip does not report by default, and its
`--include` NARROWS the report rather than adding to it (verified: under
`include: ["cycles"]` an unused export stops being reported). Enumerating every
wanted type would fix that and defeat the undeclared-category guard, so
`scripts/check-deadcode.mjs` runs a second `--cycles` pass — about 2.5s — and
merges it into the same tally.

It is declared because **the ESLint rule does not subsume it.** With
`allowUnsafeDynamicCyclicDependency: true`, detection stops at a module's first
dynamic edge, so a purely static cycle between two modules that also hold lazy
`hub.ts` imports is invisible to `pnpm run lint` (above, with the measurement).
knip has no such option and reports the static value graph directly. The two
count different units — on the commit that adopted the rule, knip found 12
distinct cycles where ESLint reported 77 offending import sites — so neither
number is a correction of the other. Both are zero now: knip is what proves it,
and ESLint is what names the offending import when someone reintroduces one.

**Never set `ignoreExportsUsedInFile`.** It is unset, and it must stay that way:
it suppresses exactly "exported, but only read inside its own file", which is
the finding this entire effort was about. Turning it on erases roughly 413 of
the 493 findings at a stroke and leaves the gate reporting green forever — the
failure mode is not a wrong number but a permanently silent one. Verified rather
than assumed: with it on, a re-exported dead symbol produces no finding at all.

A budget is a high-water mark, so it only ever moves down. Adding one back means
re-opening a category that is closed, so it is a decision to argue for, not a
way to land a change: lowering or removing a number takes a `changes` entry in
the same file, the checker rejects a log whose last entry for a category
disagrees with the current number, and it refuses a budget of `0` outright — at
zero you delete the entry, which is what makes the gate permanent.

`slackWarnAtPercentOfBudget` stays required even with no budgets to apply it to:
the checker rejects a config without it, or with a value outside `(0, 100]`. It
does nothing while `budgets` is empty and starts warning the moment a category
is re-opened — which is the point at which someone wants to know they are
approaching a number they argued for.

`knip` is pinned to an exact version in `pnpm-workspace.yaml`'s catalog like
every other dependency, and here the pin also protects the zero: a major bump
reads the same tree differently and re-opens findings — knip 5 read the tree
this one now reports as clean as 315 unused exports and 471 unused types — so
treat a version bump as a re-measurement, not a routine upgrade.

### What closing it actually did

Closing it drained 493 findings — the 460 knip reported plus the 33 that
`includeEntryExports` surfaced in `app/shared` (below) — without deleting 493
symbols, because the two outcomes are not the same thing:

| outcome                                     | exports | types |
| ------------------------------------------- | ------: | ----: |
| un-exported in place — nothing else changed |     228 |   185 |
| dead pass-through re-export specifier       |       7 |     4 |
| deleted on a `TS6133`/`TS6196`              |      53 |    16 |

**The 413 un-exported symbols are the durable value of that change, and it is
invisible in the diff:** each was an ordinary module-internal helper that
happened to carry an `export` keyword, so nothing checked whether its own file
still read it. Removing the keyword moved all 413 from ungoverned to
`noUnusedLocals`-checked — the compiler now fails the build the moment one of
them loses its last reader, with no knip run and no budget involved. Only 69
symbols were actually dead, and each deletion was justified by a compiler
diagnostic rather than by judgement.

That is the shape of the fix to reach for when the gate fires. Un-exporting is
not a way of hiding a finding from knip; it is handing the symbol to a stricter
checker.

### Tests count as consumers

`knip.json` accepts knip's vitest plugin, which makes every `*.test.ts(x)` file
an entry point. A symbol that only a test imports therefore passes the gate.

That is deliberate. Measured by dropping test files from the analysis entirely:
**26 symbols — 23 exports and 3 types — exist only for tests**, and no source
file becomes unreachable. Those 26 are what the gate does not see even now that
it reports zero. Buying them back means overriding the plugin per workspace,
which produces a config that turns on knip's own internals and rots at the next
release. The trade is not worth it; treat "exported only for a test" as a known,
accepted category rather than a finding to chase.

### Entry exports: on for `app/shared`

knip's default `includeEntryExports: false` never reports exports **in** an
entry file, and `app/shared` is _entirely_ entry files — its ten entry points
are its `package.json` `exports` map — so under the default it reported zero not
because it was clean but because it was exempt. `knip.json` therefore sets
`includeEntryExports: true` on that workspace, and it is the one place the
option is on.

It matters there in a way it does not elsewhere, because a wire type is dead in
a specific and invisible way: `protocol.ts` re-exports `workflow.ts`,
`memory.ts` and `memoryValidation.ts` with `export *`, so the barrel itself
counts as every one of their symbols' importer. Under the default, a wire type
that neither the server nor the web client uses still looks consumed. It also
does not stay a shared-package problem: deleting the server's last reader of a
type strands the declaration in `app/shared` with every gate green, which is
exactly the shared/server/web drift the workspace rule in the root `CLAUDE.md`
exists to prevent.

The option is **per workspace**, which is what makes this cheap: turning it on
for `app/shared` changes no other workspace's report. The remaining exempt
workspace is the root one, where `scripts/codemods/*.mjs` are entry points. Six
of their exports have no importer, and they are ordinary over-exports rather
than false positives — the codemods import each other, so the module's _other_
exports are consumed and only those six are not. What argues against covering
them is not that the findings are wrong, it is that `scripts/**/*.mjs` is in no
`tsconfig`: un-exporting there hands the symbol to ESLint's `no-unused-vars`,
not to `noUnusedLocals`, so the compiler-holds-the-line argument above does not
apply.

### Configuration

`knip.json` at the repo root covers all four workspaces, including `scripts/`.
It carries only what knip does not already infer: the codemod entry points,
which no `package.json` script names; the server's `check*`/`measure*` scripts;
the `project` globs; and `ignoreBinaries` for `nix` and `vitest`, which
`scripts/` shells out to and no manifest here provides.

Keep it **hint-free**. `pnpm exec knip` prints a "Configuration hints" section
for a pattern it would have inferred anyway, and every one of those is config
that can silently stop matching.

`tailwindcss` reads as an unused devDependency until `.css` is in `app/web`'s
`project` glob, because the only thing that uses it is `index.css`'s
`@import "tailwindcss"` by way of `@tailwindcss/vite`. That is the fix — let
knip follow the import — not an `ignoreDependencies` entry. Never resolve a
dependency finding by deleting a dependency the build needs. (The other known
false positive, the `// @vitest-environment jsdom` pragma at the top of 77 web
tests reading as an unlisted `vitest-environment-jsdom`, is a knip 5 behaviour
and does not occur here.)

### Running it

`pnpm run lint:deadcode` takes ~2.6s cold, with no cache (~1.7s of it knip, the
rest pnpm's own startup). That is far below the ~60s at which a check earns its
own CI step instead, so it runs inside `pnpm run test` next to `lint` and
`check:instructions`, and has a CI step of its own only so a breach names itself
in the log. `--list` prints every finding grouped by category; `pnpm exec knip`
gives knip's own report with file and line.

## Escape hatches

An `eslint-disable` is a last resort and must carry a reason on the same line:

```ts
// eslint-disable-next-line no-control-regex -- git refs genuinely forbid control characters
```

Getting green by disabling a rule per file, or by scattering suppressions, is a
failed outcome; fix the code or stage the rule with its count. The same goes for
`_`-prefixed parameters: use one only where a parameter is structurally required
(a positional signature, a callback shape, interface conformance) and delete the
dead code otherwise.

## Handling a breach

- **A new violation of an enabled rule** — fix the code. It is a blocking gate
  on purpose.
- **A rule is wrong for this repo** — turn it off in `eslint.config.js` with a
  comment saying why, as the `import-x` resolution rules are.
- **A rule is right but the backlog is large** — stage it with its measured
  count in the block above and in this document, and say so in the change.
- **ESLint and `tsc` disagree** — `tsc` wins; see the two-TypeScripts section.
- **A dead-code category reports a finding** — the export you added has no
  importer. Give it one, or un-export it and let `noUnusedLocals` take over.
  Adding a budget to `config/deadcode-budgets.json` is not the fix: every
  category is gated at zero, and a number there re-opens a closed gate.
