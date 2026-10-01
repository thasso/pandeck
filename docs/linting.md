# Linting and compiler strictness

The repo's static gates are four, in order of authority:

1. **`tsc --noEmit`** (`pnpm run typecheck`) — the authority on what typechecks.
2. **oxlint** (`pnpm run lint`) — type-aware rules for mistakes the compiler
   permits.
3. **knip** (`pnpm run lint:deadcode`) — the module boundary the compiler cannot
   see: an export nothing imports.
4. **Prettier** (`pnpm run format`) — formatting, and formatting only.

`pnpm run lint` is blocking: `--deny-warnings`, and
`reportUnusedDisableDirectives: "error"` so a suppression that no longer
suppresses anything fails too. It runs in CI's check job and inside
`pnpm run test`. A full run takes about 5s on four cores at about 1.7 GB peak,
so it has no cache and no worker tuning. `.oxlintrc.json` is the configuration.

## Why oxlint, not ESLint

The gate was type-aware ESLint until
[#3](https://github.com/thasso/pandeck/issues/3). Measured at e5f76be on a
24-core machine, a cold serial run took 113s and peaked at 9.5 GB RSS. With
Node's default heap it died of OOM after 66s, and the first CI run on a 4 vCPU /
16 GB GitHub runner was cancelled after 25 minutes. Where the cost came from:

- typescript-eslint needs the JS compiler API, which only TypeScript 6 still
  ships. TS 6 needed 13s and 1.5 GB to check `app/server` and 16.5s and 1.1 GB
  for `app/web`; TS 7 checks each in about 3s.
- `eslint --concurrency` built those programs again in every worker, so N
  workers held N copies.
- The React Compiler rules ran a Babel compile per web file: about 33s.
- `import-x/no-cycle` walked the module graph from every file: about 16s and 1.5
  GB.

oxlint runs the same ruleset natively. Its type-aware rules go through
`oxlint-tsgolint`, which is built on typescript-go 7, the compiler `tsc` uses,
so a lint rule and `tsc` can no longer disagree about a type. At the switch a
full run took 3.7s and 1.6 GB on 24 cores, about 5s on four, and 14s on one
thread. Every rule below was checked with a positive control under both tools
before ESLint was removed.

The switch dropped seven rules oxlint does not implement, all at zero findings:
`import-x/no-useless-path-segments`, `react-hooks/config`, `react-hooks/gating`
(both report React Compiler configuration problems, and the repo passes none),
`react-hooks/memoized-effect-dependencies`, `vitest/prefer-vi-mocked`, and
`no-dupe-args`/`no-octal` (parse errors in a TypeScript module anyway).
Re-adding one through oxlint's `jsPlugins` would bring an ESLint plugin runtime
back into the gate; measure the cost before doing it.

It also found 17 sites ESLint had missed, fixed in the same change: four
duplicate imports, twelve `(x?.y as T).z` chains (ESLint's
`no-unsafe-optional-chaining` stops at the `as`), and a render-time `new Date()`
in `TimeGrid.tsx` that `react-hooks/purity` should have caught.

TypeScript 6 is still installed at the root, as `catalogs.codemods`, for
`scripts/codemods/` alone: they drive `ts.createProgram`, which TypeScript 7
does not ship. Nothing in a gate runs on it.

## Compiler options

`tsconfig.base.json` at the repo root holds every option the three packages
share, so they cannot drift; each package's `tsconfig.json` extends it and adds
only what is genuinely local (module resolution, `lib`, `jsx`, `types`). The
solution-style root `tsconfig.json` has no files of its own and references those
three package configs. oxlint and `oxlint-tsgolint` find each file's owning
package config themselves.

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

The gate carries no stylistic rules, and no oxlint category is enabled: every
rule is named in `.oxlintrc.json`, so an oxlint upgrade cannot switch one on.
typescript-eslint's `stylisticTypeChecked` preset was deliberately never
mirrored. Prettier owns formatting, and the rest of that preset (`array-type`,
`consistent-type-definitions`, `prefer-nullish-coalescing`, …) is taste, not
correctness.

What is on: the rules of ESLint's `js/recommended` and typescript-eslint's
`recommendedTypeChecked`, listed out by name, plus `await-thenable`,
`switch-exhaustiveness-check`, `no-import-type-side-effects`, `no-unused-vars`
with `^_`, `import/no-duplicates`/`no-self-import`/`export`, `eqeqeq`,
`no-constant-binary-expression`, `prefer-const`, `no-fallthrough`,
`only-throw-error`, `prefer-promise-reject-errors`,
`restrict-template-expressions`, `no-floating-promises`, `no-misused-promises`,
`react/rules-of-hooks`, `react/exhaustive-deps`, `react/purity`,
`react/immutability`, and Vitest's `no-focused-tests`/`no-disabled-tests`/
`no-identical-title`. A stray `.only` silently disabling a test file is
invisible to CI otherwise.

Module RESOLUTION is not linted: `tsc` already resolves every import and is
stricter about it (NodeNext exports maps, `?worker` queries, CJS default
interop).

`react/purity` blocks render-time clocks and randomness from changing the
component tree for identical inputs, including unstable list keys that remount
rows and lose their DOM and component state. Read the time through
`hooks/useNow.ts` instead. `react/immutability` also catches a closure read
before its declaration, which prevents the compiler from tracking its later
value.

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
  NOT clean here: `in-try-catch` reports 19 sites in 10 files and `always`
  reports 339 in 99. Do not "simplify" the option away.
- **Module graph.** `import/no-empty-named-blocks` and
  `import/no-mutable-exports` — an exported `let` is shared mutable state whose
  writer is invisible from the call site.
- **The React Compiler's rules.** oxlint ports them natively; eleven are on
  beyond `rules-of-hooks` and `exhaustive-deps`, all adopted at zero:
  `set-state-in-render`, `static-components`, `error-boundaries`, `purity`,
  `immutability`, `use-memo`, `void-use-memo`, `incompatible-library` and
  `unsupported-syntax`. The last two fire when the compiler cannot reason about
  a file, which would silently weaken the others, so they are errors.
  `static-components` also covers a component built by a factory called during
  render.
- **Assertions that never assert.** Vitest's `valid-expect`,
  `valid-expect-in-promise`, `no-standalone-expect`,
  `require-awaited-expect-poll`, `no-unneeded-async-expect-function`,
  `no-commented-out-tests`, `no-alias-methods` and `no-duplicate-hooks`.
  `valid-expect` runs with `maxArgs: 2`, also load-bearing: Vitest's
  `expect(value, message)` is real API that this repo uses, and the default of 1
  flags 32 legitimate call sites across 12 test files.

The bar for adding to this group is the same one it was built on: measure with
`pnpm exec oxlint --type-aware -f json` and a throwaway config that `extends`
`.oxlintrc.json` and turns the rule on, and adopt only at zero. A rule that
reports even one finding is a staged rule with a backlog, not a free one — and
the answer is never a suppression or a code change bent to fit the rule.

Zero has a second reading here, and it is the trap this group is most exposed
to: a rule that is **inert** measures zero too. A rule that fails to load its
type information, or an option the implementation ignores, configures cleanly
and reports nothing. So a zero measurement is only half the evidence. The other
half is a **positive control**: write a file that violates the rule, confirm the
rule reports it, then delete the file. Adopt no rule here on a zero alone.

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
the staged 23 and convert when the option flips.

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
without it. Those sites carry an
`oxlint-disable-next-line react/exhaustive-deps` **on the dependency array
line** with a reason naming the key and what depending on the array would
re-render. There are seven in the tree; an eighth has to make the same argument.

`react/exhaustive-effect-dependencies`, the React Compiler's version of this
check, is staged off rather than adopted. oxlint's port also reports EXTRA
dependencies, which is exactly the trigger-token idiom above (`refreshToken` in
`WorktreeChangesetList.tsx`), and it demands functions that capture only state
setters, which `exhaustive-deps` correctly lets through: listing one re-runs the
effect on every render. Most of its 39 findings point at intended code.

Coverage is not limited to TypeScript: `scripts/**/*.mjs` and the production
service worker `app/web/public/sw.js` get the rest of ESLint's `js/recommended`
and their own globals. Generated `assistant-data/` is ignored at any directory
depth, including a package-local runtime directory created when the server runs
from a worktree. `app/web/src/lib/pcm16Worklet.js` is deliberately ignored — it
runs on the audio render thread, whose globals are its own.

## Staged rules

The TypeScript, React, and Vitest blocks of `.oxlintrc.json` list rules that are
**off with a measured backlog**. They are not rejected — each is a real signal,
and each was measured before it was staged (the option rows are on rules that
are already on).

Every number below was measured with oxlint 1.86 at the switch from ESLint (#3).
A count is a measurement anchored to a commit, not a standing fact, and oxlint's
counts are not ESLint's: most rows rose, some sharply (`require-await` 1091 →
1886, `no-deprecated` 12 → 39), because the implementations differ as well as
the code. Re-measure before adopting one, and never adjust a number to match a
guess.

| rule                                                                           | sites | files |
| ------------------------------------------------------------------------------ | ----- | ----- |
| `typescript/require-await`                                                     | 1886  | 261   |
| `typescript/no-unsafe-member-access`                                           | 1021  | 64    |
| `typescript/no-unnecessary-type-assertion`                                     | 871   | 238   |
| `typescript/no-unsafe-assignment`                                              | 719   | 79    |
| `typescript/no-explicit-any`                                                   | 273   | 41    |
| `typescript/no-base-to-string`                                                 | 212   | 58    |
| `typescript/consistent-type-imports`                                           | 194   | 94    |
| `typescript/no-unsafe-argument`                                                | 109   | 31    |
| `typescript/no-unsafe-call`                                                    | 76    | 24    |
| `typescript/unbound-method`                                                    | 73    | 38    |
| `typescript/no-unsafe-return`                                                  | 56    | 31    |
| `vitest/expect-expect`                                                         | 47    | 29    |
| `preserve-caught-error` (TS)                                                   | 47    | 40    |
| `typescript/no-deprecated`                                                     | 39    | 20    |
| `react/exhaustive-effect-dependencies`                                         | 39    | 27    |
| `switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: false` | 23    | 19    |
| `no-useless-assignment`                                                        | 20    | 16    |
| `react/no-deriving-state-in-effects`                                           | 4     | 4     |

Adopt them **one rule per change, smallest job first** — which is not the same
as smallest count, see below: clear the rule's list, delete its line, and the
gate tightens permanently.

Two entries will not reach zero that way. `no-deprecated` holds eight
browser-compatibility sites that keep the rule off until those fallbacks are no
longer required; repo policy does not trade them for scattered suppressions. And
`exhaustive-effect-dependencies` is closer to rejected than staged, for the
reason given under `exhaustive-deps` above. `no-unnecessary-condition` is off
for a reason that is not its size at all.

Several entries cost far more than their number suggests, which is why the order
is by job and not by count. The clearest case: the smallest entry in the table
is `no-deriving-state-in-effects` at 4, and it is among the largest jobs on it.
Read the note on an entry before planning against its number.

`react/no-deriving-state-in-effects` owns several synchronization contracts,
among them expandable navigator state seeded from a changing file tree,
browser-persisted viewed paths keyed by worktree and scope, and an optimistic
Task order reset by authoritative server replies. Removing those effects means
redesigning state ownership in each hook, not deleting redundant state.

`vitest/expect-expect` cannot follow assertions hidden behind a test function or
an awaited standalone `main()`. The remaining shape is older test modules whose
assertions deliberately run during module evaluation and whose `test()` body is
empty. Moving both shapes into test callbacks is a test-architecture change.

`typescript/no-deprecated`'s 39: eight deliberate browser-compatibility sites
(seven `caretRangeFromPoint` uses preserve Safari support where
`caretPositionFromPoint` is absent, and `execCommand` is the clipboard
fallback), three MCP SDK `Server` uses that need the `Server` → `McpServer` API
migration rather than a type rename, 24 `matchMedia` test stubs that still
implement `addListener`/`removeListener`, and one each of `MutableRefObject` and
`FormEvent`. The last 26 are cheap.

`switch-exhaustiveness-check`'s 23 is not the smallest job: `connection.ts`
would need dozens of no-op cases, while a missing `"failed"` or `"file"` case
elsewhere is a one-liner. `preserve-caught-error` is staged for TypeScript only
— it is already **on and blocking** for `scripts/**/*.mjs`.

`no-unnecessary-type-assertion` was staged under ESLint partly because its
autofix, run on TypeScript 6, removed assertions TypeScript 7 still required.
oxlint checks on TypeScript 7, so that reason is gone; still run
`pnpm run typecheck` after every fix.

### Why `no-unnecessary-condition` is not on the staged list

It is not staged pending a cleanup. It is rejected, and the reason is worth
recording because its headline number invites someone to schedule it.

oxlint reports 1265 sites across 412 files at the switch. The breakdown below is
ESLint's at b887a1f2, where it reported 877 sites across 290 files: 592
`neverOptionalChain` (an optional chain on a value that is never nullish), 116
`neverNullish` (an `??` whose left side is never nullish), 61
`comparisonBetweenLiteralTypes`, 53 `alwaysFalsy`, 41 `alwaysTruthy`, 12
`noOverlapBooleanExpression`, 2 `alwaysNullish`. The first two are mostly
cosmetic, and largely the conditional-spread idiom `exactOptionalPropertyTypes`
deliberately introduced. Reading the 12 strongest findings, the ones where the
types have no overlap, shows what the rule would do here:

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

### What `import/no-cycle` actually guarantees

**Two gates cover circular dependencies.** `import/no-cycle` is on and blocking
and gives the per-import-site diagnostic: which import, on which line, closes a
chain. knip's `cycles` category, gated at zero in
`config/deadcode-budgets.json`, checks the same static graph from the whole-repo
side.

- **A type-only import is never a cycle.** `verbatimModuleSyntax` erases it, so
  it cannot be a load-order hazard, and the rule ignores it (`ignoreTypes`
  defaults to on). So the rule is about the RUNTIME graph, not the type graph:
  `tools/catalog.ts` and `promptConditions.ts` still refer to each other's
  types, deliberately.
- **A dynamic `import()` is never an edge.** Measured with positive controls: a
  cycle closed only by an `await import()` is not reported, even with
  `allowUnsafeDynamicCyclicDependency: false`, and a static cycle between two
  modules that ALSO hold a dynamic import is reported. That second case is the
  one ESLint's `import-x/no-cycle` missed: its traversal abandoned a module at
  its first dynamic edge, so a static cycle could hide behind one. oxlint has no
  such hole, so the option is not set and its old staged row (49 import-x sites)
  is gone.

The four modules that reach `hub.ts` back lazily — `sessionActivity.ts`,
`pendingApprovals.ts`, `pullRequestCards.ts`, `peerPrompt.ts` — do it precisely
so the static graph stays acyclic, each with a comment saying so. Rejecting that
would push them onto a startup-ordered injection seam: a self-healing lazy read
traded for one that silently does nothing if a setter never ran, and two of the
four already swallow failure in a `catch {}`.

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

It was declared because ESLint's `import-x/no-cycle` did not subsume it: that
rule stopped at a module's first dynamic edge, so a purely static cycle between
two modules that also held lazy `hub.ts` imports was invisible to lint. oxlint's
rule does not have that hole (above, with the measurement), and the category
stays declared anyway: it costs about 2.5s and checks the graph from knip's own
module resolution. The two count different units — on the commit that adopted
the rule, knip found 12 distinct cycles where ESLint reported 77 offending
import sites — so neither number is a correction of the other. Both are zero
now, and the lint rule is what names the offending import when someone
reintroduces one.

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
`tsconfig`: un-exporting there hands the symbol to oxlint's `no-unused-vars`,
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

An `oxlint-disable` is a last resort and must carry a reason on the same line:

```ts
// oxlint-disable-next-line no-control-regex -- git refs genuinely forbid control characters
```

oxlint also honours `eslint-disable` comments; write the `oxlint-` form, with
oxlint's rule names (`react/exhaustive-deps`, not `react-hooks/…`).

Getting green by disabling a rule per file, or by scattering suppressions, is a
failed outcome; fix the code or stage the rule with its count. The same goes for
`_`-prefixed parameters: use one only where a parameter is structurally required
(a positional signature, a callback shape, interface conformance) and delete the
dead code otherwise.

## Handling a breach

- **A new violation of an enabled rule** — fix the code. It is a blocking gate
  on purpose.
- **A rule is wrong for this repo** — turn it off in `.oxlintrc.json` with a
  comment saying why, as `no-unnecessary-condition` is.
- **A rule is right but the backlog is large** — stage it with its measured
  count in the block above and in this document, and say so in the change.
- **oxlint and `tsc` disagree** — `tsc` wins. Both run TypeScript 7, so a
  disagreement is an oxlint bug or a stale `oxlint-tsgolint`; check its version
  against the catalog's `typescript`.
- **A dead-code category reports a finding** — the export you added has no
  importer. Give it one, or un-export it and let `noUnusedLocals` take over.
  Adding a budget to `config/deadcode-budgets.json` is not the fix: every
  category is gated at zero, and a number there re-opens a closed gate.
