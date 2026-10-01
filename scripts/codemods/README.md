# Codemods

Kept, not deleted. These are the transformations that turned
`exactOptionalPropertyTypes` on across the workspace (917 sites). Retaining them
means a rebase is a re-run rather than a hand-merge — which is the one thing the
previous attempt at this change got wrong, and the reason its work became
unusable.

`docs/linting.md` is the contract for what the flag requires; this file is only
about the tools.

## Why they read v7 tsc but parse with ts6

The workspace compiles with `typescript@7`, which ships **no JavaScript compiler
API** — so a codemod cannot ask the real compiler which sites are wrong. The
root `typescript@6` (the linter's copy) has the API but is a different compiler
and may disagree; on this repo it reported 452 web errors where v7 reported 455.

So the split is deliberate:

- **v7 `tsc` decides WHICH sites are wrong.** It is the authority
  (`docs/linting.md`, "The two TypeScripts").
- **ts6 is used only for SYNTAX** — parsing, and resolving a JSX attribute to
  its declaration. No type inference is ever taken from it.
- **v7 `tsc` re-checks the result.** Every codemod is verified by the authority,
  never trusted.

There is deliberately no `tsc` at the repo root, so `tsc | grep -c 'error TS'`
from the root reports a confident **zero**. `eopt-diagnostics.mjs` refuses to
run rather than guess when a package binary is missing.

## Order

```sh
node scripts/codemods/eopt-widen-react-props.mjs    # 1: prop declarations
node scripts/codemods/eopt-guard-object-props.mjs   # 2: use-site guards
```

Both loop to a fixpoint internally (tsc names only the FIRST bad property of a
literal, and widening one prop can reveal a child's), and both are idempotent
once converged. Run `pnpm run typecheck` afterwards; the residue is judgment and
is meant to be done by hand.

## The files

| file                          | what it does                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `eopt-diagnostics.mjs`        | Collects and parses v7 `tsc --exactOptionalPropertyTypes` output. Shared by everything else.     |
| `eopt-classify.mjs`           | Read-only: groups error sites by SYNTACTIC shape. Run before/after to see what is left.          |
| `eopt-analyze-props.mjs`      | Read-only: initializer kinds, and the spread-hazard analysis. `--spread` lists the hazards.      |
| `eopt-analyze-jsx.mjs`        | Read-only: maps JSX sites to (component, prop) pairs, so the declaration count is known first.   |
| `eopt-widen-react-props.mjs`  | **Writes.** `x?: T` → `x?: T \| undefined` on React props only, never outside `app/web/src`.     |
| `eopt-guard-object-props.mjs` | **Writes.** Guards an object-literal property so the key is omitted instead of set to undefined. |

The analyzers are kept because they are how the fix strategy was chosen from
evidence rather than assumption, and they are how you would re-audit it.

## What codemod 2 refuses to do

It leaves these alone and reports them, because they are behaviour decisions:

- **An opaque spread before the property.** `{ ...base, k: undefined }`
  overwrites `base.k` while omitting the key preserves it. A spread of literals
  has statically known keys and is proved safe instead of being skipped.
- **A literal `k: undefined`.** That is a deliberate statement — in a patch it
  means "clear this field" — and guarding it would also produce the tautology
  `undefined !== undefined`.
- **Anything it cannot hoist safely.** It never binds a const across a function
  boundary (the name would be out of scope) or across a conditional edge (the
  value would be evaluated when it previously was not — a TypeError, not a type
  error).

It also cannot tell which nesting level a reported property lives at, so where a
name appears twice it may guard the wrong one. If the one it picks is REQUIRED,
the guard turns "got undefined" into "missing property", which tsc then reports.
That is why re-running `typecheck` is part of the procedure and not optional.

## The refusal lists, as of the base of this change

Re-derivable, but only from the BASE commit: the analyzers key off tsc
diagnostics, and on the finished branch there are none left, so `--hazards` now
correctly reports zero. Recipe:

```sh
git stash push -- app/ docs/ tsconfig.base.json .gitignore   # back to base
node scripts/codemods/eopt-widen-react-props.mjs
node scripts/codemods/eopt-guard-object-props.mjs --hazards
node scripts/codemods/eopt-guard-object-props.mjs --dry       # writes the report
git checkout -- app/ && git stash pop
```

Recorded here so the judgement calls stay auditable from the branch itself.

### Opaque spread before the property (12)

Each was reasoned about individually; a spread whose keys ARE statically known
is proved safe and guarded automatically instead of landing here.

```
  app/server/src/claudeSdk/ClaudeSdkSession.ts:1965 contextTokens    contextTokens: this.contextTokens
  app/server/src/claudeSdk/claudeSdkFork.test.ts:324 storeRoot    storeRoot: (sessionStore as { root?: string } | undefined)?.root
  app/server/src/session/log/timelinePayloadPolicy.ts:173 inputSummary    inputSummary: summaryLabel(inputSummary)
  app/server/src/tools/google/googleMeetTools.ts:196 meetingCode    meetingCode: params.meetingCode
  app/server/src/tools/jira/jiraTools.ts:2495 fallbackResolutionName    fallbackResolutionName: wantedName
  app/web/src/components/MemorySettingsSection.tsx:492 timezone    timezone: trimmed && isValidTimezone(trimmed) ? trimmed : undefined
  app/web/src/components/MemorySettingsSection.tsx:641 validFromMs    validFromMs: e.target.value
  app/web/src/components/MemorySettingsSection.tsx:668 validUntilMs    validUntilMs: e.target.value
  app/web/src/hooks/useBacklog.ts:355 projectId    projectId: byId.get(item.id)
  app/web/src/hooks/usePrefs.ts:219 workflowRoleRuntimes    workflowRoleRuntimes: normalizeWorkflowRoleRuntimes(
  app/web/src/lib/backlogTree.ts:271 parentId    parentId
  app/web/src/lib/peerPromptCardOverrides.ts:52 failureReason    failureReason: override.failureReason
```

### Literal `k: undefined` (39)

A deliberate statement, not a value that happens to be missing. In a patch it
means "clear this field", so guarding it would invert the meaning — and in a
test fixture that overrides a default, dropping the key would make the test
assert the opposite of what it claims.

```
  app/server/src/claudeSdk/claudeSdkFork.test.ts:239 uuid    uuid: undefined
  app/server/src/mcp/toolGroups/registry.test.ts:105 sessionFile    sessionFile: undefined
  app/server/src/pendingApprovals.ts:381 error    error: undefined
  app/server/src/prWorkflow.ts:263 taskCandidates    taskCandidates: undefined
  app/server/src/promptInventory.ts:463 appendSystemPrompt    appendSystemPrompt: undefined
  app/server/src/providerErrors.ts:136 retryable    retryable: undefined
  app/server/src/pullRequestActions.test.ts:469 worktreeId    worktreeId: undefined
  app/server/src/pullRequestActions.ts:203 busyAction    busyAction: undefined
  app/server/src/pullRequestActions.ts:264 rebaseHandedOff    rebaseHandedOff: undefined
  app/server/src/pullRequestActions.ts:301 busyAction    busyAction: undefined
  app/server/src/pullRequestActions.ts:320 busyAction    busyAction: undefined
  app/server/src/pullRequestActions.ts:509 conflicts    conflicts: undefined
  app/server/src/pullRequestActions.ts:544 actionError    actionError: undefined
  app/server/src/pullRequestMerge.ts:294 mergeable    mergeable: undefined
  app/server/src/pullRequestWatcher.test.ts:187 mergeable    mergeable: undefined
  app/server/src/pullRequestWatcher.test.ts:392 number    number: undefined
  app/server/src/sessionAudit.test.ts:109 callTranscript    callTranscript: undefined
  app/server/src/sessionAudit.test.ts:140 callTranscript    callTranscript: undefined
  app/server/src/tasks.test.ts:765 parentId    parentId: undefined
  app/server/src/tasks.test.ts:828 parentId    parentId: undefined
  app/server/src/tasks.test.ts:846 parentId    parentId: undefined
  app/server/src/tasks.test.ts:892 parentId    parentId: undefined
  app/server/src/tasks.test.ts:903 parentId    parentId: undefined
  app/server/src/tools/google/meetingMinutesScannerTools.ts:155 meetingSummary    meetingSummary: undefined
  app/server/src/workflow/codeDeliveryRecipe.test.ts:375 worktreeId    worktreeId: undefined
  app/server/src/workflow/deliveryOperations.ts:541 draft    draft: undefined
  app/server/src/workflow/pullRequestObservation.test.ts:351 draft    draft: undefined
  app/server/src/workflow/reviewSets.test.ts:537 worktreeId    worktreeId: undefined
  app/web/src/components/AgentQuestionForm.tsx:477 disposition    disposition: undefined
  app/web/src/components/AgentQuestionForm.tsx:482 disposition    disposition: undefined
  app/web/src/components/PullRequestCard.test.tsx:65 provider    provider: undefined
  app/web/src/components/PullRequestCard.test.tsx:415 provider    provider: undefined
  app/web/src/components/SessionDockActions.test.tsx:125 contextSlot    contextSlot: undefined
  app/web/src/components/TaskIdBadge.test.tsx:67 triagedAt    triagedAt: undefined
  app/web/src/hooks/useAssistant.test.ts:675 sourceToolCallId    sourceToolCallId: undefined
  app/web/src/lib/sessionPreviewStore.ts:98 data    data: undefined
  app/web/src/lib/worktreeHosting.test.ts:27 ci    ci: undefined
  app/web/src/lib/worktreeHosting.test.ts:31 review    review: undefined
  app/web/src/lib/worktreeInbox.test.ts:344 fetchedAt    fetchedAt: undefined
```

## Reports

Each writing codemod drops a dotfile next to itself (git-ignored, regenerated):
`.eopt-widened-props.txt` lists every widened declaration, and
`.eopt-guard-report.txt` lists every edit by kind plus the two refusal sets.
