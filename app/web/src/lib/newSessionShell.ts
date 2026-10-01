import { UNLABELED_SESSION_TITLE } from "@assistant/shared";

/**
 * The optimistic session shell: what the staging surface (`/sessions/create`,
 * `/sessions`) renders between the first send and the moment the URL lands on
 * the session that send created.
 *
 * The real session does not exist yet — it is being bootstrapped server-side
 * (a worktree checkout, the engine start, the first prompt) — so the surface
 * renders as if it will: the prompt stays put, the header keeps the STAGED
 * identity, and exactly one line says what the bootstrap is doing. The
 * decisions live here rather than in `App.tsx` because they are the contract
 * the scenario test drives.
 */

/** The one bootstrap line, or nothing when another source already narrates. */
export type NewSessionNarration =
  | { kind: "starting"; label: string }
  | { kind: "failed"; label: string; detail: string };

export interface NewSessionShell {
  /**
   * A first send from this surface is out and unadopted. The surface is a
   * SESSION from here on: the header shows even where an idle new-session
   * screen hides it, and the quick-start rows stay down.
   */
  bootstrapping: boolean;
  /** Stable placeholder until the created session's row receives its final name. */
  title: string;
  /** True while the title should use the app's working-text treatment. */
  titleGenerationPending: boolean;
  /** Staged identity for the header's second line; empty when there is none. */
  subtitle: string;
  narration: NewSessionNarration | null;
  /**
   * This send failed AND created nothing, so running it again is the way out.
   * ONE rule for both halves of that offer — the retry affordance and the
   * composer's re-issue routing — because they make the same claim: a re-issue
   * once a session exists does not retry anything, it creates a second session
   * and leaves the first one behind.
   */
  retryable: boolean;
  /**
   * A failure arriving NOW is narrated here, under the prompt this send kept,
   * with the retry beside it — so it must not also be said in passing
   * (`docs/messaging.md`).
   *
   * Claimed while the send is in flight rather than once it has failed, because
   * the announcement is decided at the message's ARRIVAL: a home that only
   * exists after the failure has landed is not a home, and asking afterwards is
   * how a suppression came to defer an arrival instead of consuming it.
   *
   * What it claims is this send's OWN blocker, not every error that lands
   * while it is out: the server's pre-creation refusals name nothing, because
   * the session they would name does not exist yet, and once one does only its
   * own id is claimed (`lib/messageArrival.ts`). A background session failing
   * mid-bootstrap belongs to that session.
   */
  ownsFailure: boolean;
}

export interface NewSessionShellInput {
  /** The staging surface is the one rendering (`/sessions/create`, `/sessions`). */
  isNewChatRoute: boolean;
  /** A first send is held or armed: it left, and its session has not been adopted. */
  firstSendPending: boolean;
  /**
   * The list row of the session this surface is SHOWING, when there is one. A
   * server-minted session has no row under the staged id, so its title arrives
   * with the adoption (or the route advance) rather than mid-bootstrap; a
   * client-id session (claude-sdk) is named in place as soon as the list lands.
   */
  sessionTitle?: string;
  /** Naming state carried by that row, when the row already exists. */
  sessionTitleGenerationPending?: boolean;
  /** Whether a row-less first send is expected to run the naming agent. */
  autoNamingEnabled: boolean;
  /** The model the pickers show — the one the first send carries. */
  modelName?: string;
  /** Branch of the staged worktree, when one was picked. */
  worktreeName?: string;
  /** The send provisions its own worktree; it has no name until the card names it. */
  newWorktree?: boolean;
  /** Project the session is staged in, when no worktree names it. */
  projectName?: string;
  /** The agent is answering: the transcript narrates from here on. */
  agentResponding: boolean;
  /**
   * The worktree-provisioning card is on screen for THIS send. It is the
   * bootstrap's narration for as long as it is there (phases and, on failure,
   * the blocker plus its own Retry), so this one stands down rather than
   * saying the same thing twice.
   */
  worktreeNarrationVisible: boolean;
  /**
   * That card reports a failed checkout. It is a blocker this module never sees
   * as an `error` (a provisioning failure is reported on its own channel), and
   * it means no session was created.
   */
  provisionFailed: boolean;
  /**
   * The chat error channel, read as this bootstrap's outcome. The wire does not
   * support proving that: the server's real first-send blockers ("Model …/… is
   * not available.", a credential-profile or persona refusal) are plain errors
   * with no clientRequestId to correlate, so an unrelated failure arriving in
   * this window would be attributed here too. Two things keep that honest — the
   * caller RETIRES the previous outcome when it arms, and `sendLanded` below
   * ends the claim as soon as a session demonstrably exists.
   */
  error: string | null;
  /**
   * This send's session has been created (`stagedTranscript`'s `landed`). The
   * bootstrap is over: whatever fails after it is a failure IN that session,
   * not the session failing to start, and saying otherwise would offer to
   * create a second one.
   */
  sendLanded: boolean;
}

export function newSessionShell(input: NewSessionShellInput): NewSessionShell {
  const bootstrapping = input.isNewChatRoute && input.firstSendPending;
  const narration = bootstrapping ? bootstrapNarration(input) : null;
  const sessionTitle = input.sessionTitle?.trim();
  return {
    bootstrapping,
    title:
      sessionTitle || (bootstrapping ? UNLABELED_SESSION_TITLE : "New Session"),
    titleGenerationPending:
      bootstrapping &&
      (sessionTitle
        ? input.sessionTitleGenerationPending === true
        : input.autoNamingEnabled),
    subtitle: shellSubtitle(input),
    narration,
    retryable:
      bootstrapping &&
      !input.sendLanded &&
      (input.provisionFailed || narration?.kind === "failed"),
    // Exactly the conditions under which `bootstrapNarration` will turn the
    // next failure into its `failed` line: the provisioning card narrates its
    // own blockers, and a send that has landed is a session's problem now.
    ownsFailure:
      bootstrapping && !input.worktreeNarrationVisible && !input.sendLanded,
  };
}

function bootstrapNarration(
  input: NewSessionShellInput,
): NewSessionNarration | null {
  if (input.worktreeNarrationVisible) return null;
  if (input.error && !input.sendLanded)
    return {
      kind: "failed",
      label: "Could not start the session",
      detail: input.error,
    };
  if (input.agentResponding) return null;
  return { kind: "starting", label: "Starting session…" };
}

/**
 * The staged identity, in the order the user chose it: WHAT runs the session,
 * then WHERE. A session that has not been created has no id to fingerprint and
 * no plan to count, so this stands in for the live subtitle.
 */
function shellSubtitle(input: NewSessionShellInput): string {
  const place = input.newWorktree
    ? "new worktree"
    : (input.worktreeName ?? input.projectName);
  return [input.modelName, place].filter(Boolean).join(" · ");
}

/** Timeline row ids that belong to a staged send rather than to a session. */
interface StagedOptimisticEntry {
  id: string;
  /** The staged session this row was dispatched for, when it names one. */
  optimisticSessionId?: string;
}

export interface StagedTranscript<M> {
  /** The rows the staged surface renders. */
  messages: M[];
  /**
   * The created session's transcript has taken this send's prompt over, one
   * commit before the armed advance moves the URL onto it.
   */
  adopted: boolean;
  /**
   * The send demonstrably created its session: the viewed one did not exist
   * when it left. Independent of the rows, because it also answers "may this
   * send still be re-issued?" — once a session exists, re-issuing makes a
   * second one.
   */
  landed: boolean;
}

export interface StagedTranscriptInput<M> {
  /** The optimistic session's client id, or null when nothing is staged. */
  stagedSessionId: string | null;
  /** `state.optimistic`: rows this browser dispatched and the server has not echoed. */
  optimistic: readonly StagedOptimisticEntry[];
  /** `state.messages`: the live display projection. */
  messages: readonly M[];
  /** Id of the live worktree-provisioning row. */
  provisionMessageId: string;
  /** That row belongs to THIS send, so the staged transcript carries it. */
  provisionOwned: boolean;
  /** A first send from this surface is out and unadopted. */
  firstSendPending: boolean;
  /** `state.session?.sessionId` — the session this connection views. */
  viewedSessionId: string | null;
  /**
   * Every session id known when the send left: the list plus the id then
   * viewed. The session a first send creates is necessarily NOT in it, and that
   * absence is the only positive evidence this layer has that the session now
   * in view is the send's own answer.
   *
   * "Different from the one we left" is NOT that evidence, and the same
   * question is already settled that way one layer up:
   * `useSessionRouting`'s `stagedSendCreatedSession` refuses to advance the URL
   * onto anything present in its own arm-time set, because a late `loadSession`
   * answer, a background session settling or a server-initiated view switch all
   * move the viewed session mid-bootstrap. The two layers have to name the same
   * session or the surface paints one conversation under another one's URL —
   * so the caller records this set at arm exactly as the routing hook does.
   */
  knownSessionIdsAtSend: ReadonlySet<string> | null;
}

/**
 * What a staged surface shows instead of the previously viewed session's
 * transcript: the rows this browser already dispatched for the send.
 *
 * The handoff to the real session is the delicate half. The created session's
 * durable echo RECONCILES the optimistic row — it is gone from `optimistic` in
 * the same commit the durable prompt lands in `messages`, while the armed
 * advance only moves the URL an effect later. Rendering that commit literally
 * would blank the transcript the user is watching, so once the staged rows are
 * settled the shell adopts the live ones: they ARE this send's prompt, since
 * the reconciliation is what settled it.
 *
 * That adoption needs the session in view to BE the one this send created
 * (`landed`), never merely a session it did not start from. Any pre-existing
 * conversation can drift into view mid-bootstrap, and adopting one would paint
 * it — rows and identity — under the staging URL, which is the R3 leak this
 * whole helper exists to prevent. Where the evidence is missing the surface
 * shows the staged rows it has, and nothing else.
 */
export function stagedTranscript<M extends { id: string }>(
  input: StagedTranscriptInput<M>,
): StagedTranscript<M> {
  const landed = stagedSendLanded(input);
  const stagedId = input.stagedSessionId;
  if (!stagedId) return { messages: [], adopted: false, landed };
  const ids = new Set(
    input.optimistic
      .filter(
        (entry) =>
          !entry.optimisticSessionId || entry.optimisticSessionId === stagedId,
      )
      .map((entry) => entry.id),
  );
  // The worktree being provisioned for THIS send belongs to the staged
  // transcript too — it is the reason the prompt has not run yet.
  if (input.provisionOwned) ids.add(input.provisionMessageId);
  const staged = input.messages.filter((message) => ids.has(message.id));
  if (staged.length > 0) return { messages: staged, adopted: false, landed };
  const live = input.messages.filter(
    (message) => message.id !== input.provisionMessageId,
  );
  const adopted = input.firstSendPending && landed && live.length > 0;
  return adopted
    ? { messages: live, adopted: true, landed }
    : { messages: [], adopted: false, landed };
}

/**
 * Has this send's session been created? True only on positive evidence: the
 * connection views a session that did not exist when the send left.
 */
function stagedSendLanded(input: {
  viewedSessionId: string | null;
  knownSessionIdsAtSend: ReadonlySet<string> | null;
}): boolean {
  const { viewedSessionId, knownSessionIdsAtSend } = input;
  if (!viewedSessionId || !knownSessionIdsAtSend) return false;
  return !knownSessionIdsAtSend.has(viewedSessionId);
}
