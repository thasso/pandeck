/**
 * Pull request detail-page fixtures: what `GET /api/pull-requests/conversation`
 * answers. The two Pandeck pull requests are REAL reads of this repository's
 * own #120 and #121 (description and head checks as GitHub reported them); the
 * review conversation is written by hand, because this repository's pull
 * requests carry no review traffic to show threads and verdicts with.
 *
 * Real data from other repositories never goes here: it lives in the
 * git-ignored `fixtures/local/` and is loaded only when present.
 */
import type {
  PullRequestConversationResponse,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { NOW, pullRequest } from "./worktree.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** thasso/pandeck#120 as GitHub answered it: yours, open, all checks green. */
export const pandeck120Conversation: PullRequestConversationResponse = {
  number: 120,
  fetchedAt: 0,
  body: "Implement Recommendation 5 for peer batches, send-now, and steering: settle delivery from immutable per-run terminal outcomes rather than promise resolution or idle transitions. Fence stale claims and late callbacks, and close run waiters during supported session teardown.\n\nReserve every batch member durably before provider exposure and reconcile uncertain delivery against canonical logs and accepted-steer receipts. Admitted or potentially read prompts are never automatically resent. Add migration 0079 with nullable `reserved_at_ms`, preserving migration 0078 and leaving legacy rows unchanged.\n\nTreat requested Stop as interruption, not failure: requested replies remain owed and correlatable with unchanged deadlines, without failure notices or automatic replay. Preserve actual replies and genuine failures; expose interruption state in peer cards until a reply settles it.\n\nReported verification passed at published head `6ab5abf5b42e1872b31136281e208f2560286adc` after rebasing onto main: full shared, web, and server suites; focused delivery, teardown, restart, and migration-upgrade checks; and typecheck, formatting, build, lint, and release/config gates. Scripted real Claude SDK paths verified uncertain acceptance does not replay and emits one safe notice.",
  author: "thasso",
  createdAt: 1791887003000,
  assignees: [],
  requestedReviewers: {
    users: [],
    teams: [],
  },
  timeline: [],
  threads: [],
  checks: {
    headSha: "6ab5abf5b42e1872b31136281e208f2560286adc",
    state: "success",
    items: [
      {
        name: "ci",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115248631273",
      },
      {
        name: "reproducible",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115248590532",
      },
      {
        name: "check",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247861236",
      },
      {
        name: "test-server (1/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247861125",
      },
      {
        name: "test-web (2/2)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247861058",
      },
      {
        name: "test-server (2/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247861019",
      },
      {
        name: "test-web (1/2)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247861013",
      },
      {
        name: "nix-build",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247860985",
      },
      {
        name: "test-server (3/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247860919",
      },
      {
        name: "nix-rebuild",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38383019724/job/115247860716",
      },
    ],
  },
};

/** thasso/pandeck#121 as GitHub answered it: merged. */
export const pandeck121Conversation: PullRequestConversationResponse = {
  number: 121,
  fetchedAt: 0,
  body: "Show display names for assignees and user-valued fields on Jira create/edit approval cards while preserving account IDs in server-side values and execution payloads.\n\nExtract the shared bulk user resolver for Jira and Tempo. Unresolved names fall back to account IDs, cancelled lookups create no approval, and empty assignee IDs are rejected. Previously staged cards remain executable.\n\nTests cover display names versus payload IDs, lookup failures, unassignment, empty IDs, and cancellation. Reported verification passed: tests, typecheck, lint, dead-code lint, and formatting checks.",
  author: "thasso",
  createdAt: 1791899750000,
  assignees: [],
  requestedReviewers: {
    users: [],
    teams: [],
  },
  timeline: [],
  threads: [],
  checks: {
    headSha: "df8475d83daf8d72d1716a8256783d9092b74e9a",
    state: "success",
    items: [
      {
        name: "ci",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115338086449",
      },
      {
        name: "reproducible",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115338019709",
      },
      {
        name: "test-server (1/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965346",
      },
      {
        name: "nix-rebuild",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965274",
      },
      {
        name: "check",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965266",
      },
      {
        name: "test-web (2/2)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965212",
      },
      {
        name: "test-server (2/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965202",
      },
      {
        name: "nix-build",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965188",
      },
      {
        name: "test-server (3/3)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336965126",
      },
      {
        name: "test-web (1/2)",
        tone: "success",
        status: "success",
        url: "https://github.com/thasso/pandeck/actions/runs/38409075933/job/115336964780",
      },
    ],
  },
};

export const pandeck120: PullRequestInventoryItem = pullRequest({
  repositoryKey: "thasso/pandeck",
  repoWebUrl: "https://github.com/thasso/pandeck",
  number: 120,
  url: "https://github.com/thasso/pandeck/pull/120",
  title: "Record interrupted peer turns without replaying admitted work",
  headBranch: "peer-turn-interruptions",
  author: "thasso",
  ci: {
    state: "success",
    total: 10,
    url: "https://github.com/thasso/pandeck/runs/115247861236",
  },
  review: { changesRequested: false },
  headSha: "6ab5abf5b42e1872b31136281e208f2560286adc",
  taskIds: [],
});

/** #121 after its merge, with the checkout still on disk. */
export const pandeck121: PullRequestInventoryItem = pullRequest({
  repositoryKey: "thasso/pandeck",
  repoWebUrl: "https://github.com/thasso/pandeck",
  number: 121,
  url: "https://github.com/thasso/pandeck/pull/121",
  title: "Show Jira user display names on mutation approval cards",
  headBranch: "jira-user-display-names",
  author: "thasso",
  mine: false,
  state: "merged",
  ci: undefined,
  review: undefined,
  mergeable: undefined,
  capabilities: undefined,
  sessionIds: [],
  taskIds: [],
});

/** Someone else's pull request, waiting on your review. */
export const reviewRequestedItem: PullRequestInventoryItem = pullRequest({
  number: 421,
  url: "https://github.com/pandeck/pandeck/pull/421",
  title: "Show the merge method the repository allows",
  headBranch: "merge-methods",
  mine: false,
  reviewRequested: true,
  teamReviewRequests: ["web-devs"],
  author: "sam-ortiz",
  ci: { state: "failure", total: 7 },
  review: { changesRequested: false, unresolvedThreads: 2 },
  mergeable: null,
  worktreeId: undefined,
  sessionIds: [],
  taskIds: [],
});

/** A review in flight: verdicts, a reply, open and resolved threads, red CI. */
export const reviewConversation: PullRequestConversationResponse = {
  number: 421,
  fetchedAt: NOW,
  body: [
    "The merge dialog offered every method GitHub knows, so a squash-only repository refused the click after the fact.",
    "",
    "- Read `allow_squash_merge` / `allow_merge_commit` / `allow_rebase_merge` with the repository metadata",
    "- Offer **only** those methods, defaulting to the repository's own default",
    "- Say why nothing is offered while the capabilities are unknown",
    "",
    "Closes #402.",
  ].join("\n"),
  author: "sam-ortiz",
  createdAt: NOW - 26 * HOUR,
  assignees: ["sam-ortiz"],
  requestedReviewers: { users: ["thasso"], teams: ["web-devs"] },
  timeline: [
    {
      kind: "review",
      verdict: "changes-requested",
      id: "r1",
      author: "lee-novak",
      body: "The default method must come from the repository, not from the first entry of the list. See the two inline notes.",
      createdAt: NOW - 20 * HOUR,
      url: "https://github.com/pandeck/pandeck/pull/421#pullrequestreview-1",
      threadComments: 2,
    },
    {
      kind: "comment",
      id: "c1",
      author: "sam-ortiz",
      body: "Fixed in `3f2c1a9`: the default is `capabilities.defaultMergeMethod`, and an unknown set offers nothing.",
      createdAt: NOW - 5 * HOUR,
      url: "https://github.com/pandeck/pandeck/pull/421#issuecomment-1",
    },
    {
      kind: "review",
      verdict: "approved",
      id: "r2",
      author: "lee-novak",
      body: "",
      createdAt: NOW - 2 * HOUR,
      url: "https://github.com/pandeck/pandeck/pull/421#pullrequestreview-2",
    },
  ],
  threads: [
    {
      id: "t1",
      path: "app/web/src/components/pullRequest/PullRequestMergeDialog.tsx",
      line: 112,
      diffHunk: [
        "@@ -108,6 +108,9 @@ export function PullRequestMergeDialog({",
        "   const methods = item.capabilities?.mergeMethods ?? [];",
        "-  const [method, setMethod] = useState(methods[0]);",
        "+  const [method, setMethod] = useState(",
        "+    item.capabilities?.defaultMergeMethod ?? methods[0],",
        "+  );",
      ].join("\n"),
      url: "https://github.com/pandeck/pandeck/pull/421#discussion_r1",
      comments: [
        {
          id: "t1c1",
          author: "lee-novak",
          body: "`methods[0]` is still the fallback when the default is not in the allowed set. Should that offer nothing instead?",
          createdAt: NOW - 20 * HOUR,
        },
        {
          id: "t1c2",
          author: "sam-ortiz",
          body: "Good catch — a default outside the allowed set now falls back to *no* selection, so the button stays disabled with the reason.",
          createdAt: NOW - 5 * HOUR,
        },
      ],
    },
    {
      id: "t2",
      path: "app/server/src/gitHosting.ts",
      line: 431,
      url: "https://github.com/pandeck/pandeck/pull/421#discussion_r2",
      comments: [
        {
          id: "t2c1",
          author: "lee-novak",
          body: "This cache never expires when the repository settings change. Five minutes is fine for the picker, but the merge itself must read fresh.",
          createdAt: NOW - 20 * HOUR,
        },
      ],
    },
    {
      id: "t3",
      path: "app/web/src/lib/pullRequestInbox.ts",
      line: 340,
      resolved: true,
      outdated: true,
      url: "https://github.com/pandeck/pandeck/pull/421#discussion_r3",
      comments: [
        {
          id: "t3c1",
          author: "lee-novak",
          body: 'Typo: "mergable".',
          createdAt: NOW - 20 * HOUR,
        },
      ],
    },
  ],
  checks: {
    headSha: "3f2c1a9e0d4b5c6a7f8e9d0c1b2a3f4e5d6c7b8a",
    state: "failure",
    items: [
      { name: "check", tone: "success", status: "success" },
      {
        name: "test-web (1/2)",
        tone: "failure",
        status: "failure",
        summary: "2 failed, 1,284 passed — PullRequestMergeDialog.test.tsx",
        url: "https://github.com/pandeck/pandeck/actions/runs/1/job/1",
      },
      { name: "test-web (2/2)", tone: "success", status: "success" },
      {
        name: "test-server (1/3)",
        tone: "pending",
        status: "in_progress",
        url: "https://github.com/pandeck/pandeck/actions/runs/1/job/2",
      },
      { name: "test-server (2/3)", tone: "success", status: "success" },
      { name: "test-server (3/3)", tone: "success", status: "success" },
      { name: "nix-build", tone: "skipped", status: "skipped" },
    ],
  },
};
