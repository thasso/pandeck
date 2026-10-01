/**
 * @module messageArrival
 * @purpose Decide, from the ARRIVAL of a server message, what the user is told
 *   about it: what it says, which object keeps it, and whether anything on
 *   screen already renders it (`docs/messaging.md`).
 * @useWhen A server message has just landed. Nothing here may be re-asked later
 *   from reducer state — an announcement is an event, and the store that
 *   outlives it does not name it.
 * @intent The decision is pure and takes the arrival plus the small view facts
 *   it needs, so the invariants that keep breaking here — arrival identity, a
 *   suppression that consumes rather than defers — are testable without a DOM.
 *   The one mutable thing is the failure-home claim, which is a fact only the
 *   surfaces that render failures can state.
 */
import type {
  MessageTarget,
  NoticeSeverity,
  ServerMessage,
  TimelineAnchorTarget,
} from "@assistant/shared";

/** What an arrival says to the user, before any decision about where. */
export interface ArrivalMessage {
  severity: NoticeSeverity;
  message: string;
  target?: MessageTarget;
}

/**
 * The view facts an arrival needs to be read at all: whether the message is
 * about the chat this connection is looking at, and whether a jump is still
 * being waited on. Both are correlation, not ownership — they answer "is this
 * message even ours", which is the same question the matching reducer branch
 * asks before it changes anything.
 */
export interface ArrivalContext {
  viewedSessionId: string | null;
  revealRequestId: string | null;
  /** What that jump is to, so a miss names what is gone. */
  revealTargetKind?: TimelineAnchorTarget["kind"] | null;
}

/**
 * What this arrival says, or null when it says nothing to the user.
 *
 * One place, listing every message that speaks. It used to be ten reducer
 * branches each assigning a global slot, which is how a message came to be
 * announced from persistent state: once the sentence is IN the store, the only
 * way back out is to guess whether the store still means it.
 */
export function arrivalMessage(
  msg: ServerMessage,
  context: ArrivalContext,
): ArrivalMessage | null {
  switch (msg.type) {
    case "notice":
      return {
        severity: msg.severity,
        message: msg.message,
        ...(msg.target ? { target: msg.target } : {}),
      };
    case "error":
      return {
        severity: "error",
        message: msg.message,
        ...(msg.target ? { target: msg.target } : {}),
      };
    case "event":
      // A run's outcome belongs to the chat it ran in, and only the viewed
      // chat's runtime events reach this client's state at all.
      if (msg.sessionId !== context.viewedSessionId) return null;
      if (msg.event.type !== "runStatus" || msg.event.status !== "error")
        return null;
      return {
        severity: "error",
        message: msg.event.message ?? "Run failed.",
      };
    case "permanentAssistantQueue":
      return permanentAssistantQueueFailure(msg);
    case "draftSession":
      return msg.notice ? { severity: "info", message: msg.notice } : null;
    case "timelineAnchor":
      // Only the jump still being waited on: an answer to a superseded request
      // would report a miss the reader has already navigated past.
      if (msg.anchor || msg.requestId !== context.revealRequestId) return null;
      return {
        severity: "info",
        message:
          context.revealTargetKind === "approval"
            ? "That approval card no longer exists."
            : "That message is no longer in the other session.",
      };
    default:
      return null;
  }
}

/**
 * The one thing a permanent-Assistant queue update SAYS, or null.
 *
 * `queued` and `working` are conditions on the prompt they name — states that
 * message is IN until the next update replaces them — so they are rendered on
 * that prompt's own row (`PromptQueueState` in `useAssistant`) and are never
 * announced. `completed` resolves them and says nothing either. What is left is
 * a genuine failure, and it names the session it happened in, so it reaches the
 * user exactly once: in place above that composer, or announced naming the
 * session when the user is elsewhere.
 *
 * One function, asked by both the announcer and the reducer that keeps the
 * failure, so the two can never disagree about which object it was.
 */
function permanentAssistantQueueFailure(
  msg: Extract<ServerMessage, { type: "permanentAssistantQueue" }>,
): ArrivalMessage | null {
  if (msg.state !== "failed") return null;
  return {
    severity: "error",
    message: msg.error ?? "The queued message failed. Please retry.",
    target: { type: "session", id: msg.sessionId },
  };
}

/**
 * The session-scoped failure an arrival puts ON its session, or null.
 *
 * Derived from the message rather than from anything already stored, and in one
 * place rather than at each branch that could raise one — the rule written at
 * ten call sites is the rule that rots at nine.
 */
export function sessionFailureFrom(
  msg: ServerMessage,
): { sessionId: string; message: string } | null {
  const failure = failureOnObject(msg);
  if (failure?.type !== "session") return null;
  return { sessionId: failure.id, message: failure.message };
}

/**
 * The object types other than `session` whose failures the client keeps ON the
 * object, for the surface that has that object open to render in place.
 *
 * A worktree is deliberately absent: its failures are already narrated by the
 * dialog or the delivery card that issued them, so a fourth store would be a
 * second copy of a note that is already on screen.
 */
const OBJECT_FAILURE_TYPES = [
  "project",
  "task",
  "knowledge",
] as const satisfies readonly MessageTarget["type"][];

export type ObjectFailureType = (typeof OBJECT_FAILURE_TYPES)[number];

/**
 * The failure an arrival puts on a project, Task or Knowledge entry, or null.
 *
 * Same derivation as the session case and from the same one place, so the store
 * that keeps a failure and the decision not to also announce it can never
 * disagree about which object it was about.
 */
export function objectFailureFrom(
  msg: ServerMessage,
): { type: ObjectFailureType; id: string; message: string } | null {
  const failure = failureOnObject(msg);
  if (!failure || !isObjectFailureType(failure.type)) return null;
  return { type: failure.type, id: failure.id, message: failure.message };
}

function isObjectFailureType(
  type: MessageTarget["type"],
): type is ObjectFailureType {
  return (OBJECT_FAILURE_TYPES as readonly string[]).includes(type);
}

/**
 * The one derivation behind both accessors: an ERROR that names a single member
 * of a type, read from the message and nothing that outlived it.
 *
 * Errors only, and a member only. A warning has no in-place note to live in, and
 * a target with no id is a collection condition, which `isConditionCollection`
 * answers instead.
 */
function failureOnObject(
  msg: ServerMessage,
): { type: MessageTarget["type"]; id: string; message: string } | null {
  const arrival =
    msg.type === "error"
      ? { severity: "error" as const, message: msg.message, target: msg.target }
      : msg.type === "notice"
        ? { severity: msg.severity, message: msg.message, target: msg.target }
        : msg.type === "permanentAssistantQueue"
          ? permanentAssistantQueueFailure(msg)
          : null;
  if (!arrival || arrival.severity !== "error") return null;
  const target = arrival.target;
  if (!target?.id) return null;
  return { type: target.type, id: target.id, message: arrival.message };
}

/**
 * Collections whose load failure the client keeps as a CONDITION on the
 * collection itself (`projectListError`, `worktreeListError`, `taskListError`),
 * rendered by the pane whenever the user goes there.
 *
 * Listed once, and read by both the reducer that stores the condition and the
 * announcer that therefore says nothing: two lists would drift into a failure
 * that is either stored and also announced, or announced and stored nowhere.
 */
const CONDITION_COLLECTIONS: readonly MessageTarget["type"][] = [
  "project",
  "task",
  "worktree",
];

/** Whether this target names one of those collections rather than a member. */
function isConditionCollection(target: MessageTarget | undefined) {
  return Boolean(
    target && !target.id && CONDITION_COLLECTIONS.includes(target.type),
  );
}

/**
 * The failures a surface currently on screen renders IN PLACE.
 *
 * Ownership has two halves and only one of them is a wire fact. WHICH object a
 * failure is about is the server's to say, and it now does. Whether that
 * object's surface is in front of the user is something only the view layer
 * knows, so the surfaces state it here — rather than the announcer reaching
 * into app state to guess, which is the shape every bug in this area has had.
 */
export interface FailureHomes {
  /**
   * The session whose failures are rendered above its composer. Errors only:
   * the in-place note exists for a failure, so a WARNING naming this session
   * still has nowhere to go and is still announced.
   */
  viewedSessionId: string | null;
  /**
   * A staged first send is on screen and narrates its own failure under the
   * prompt it kept, with the retry beside it. Claimed while the send is IN
   * FLIGHT, not once it has failed: the announcement is decided at arrival, so
   * a home that only appears afterwards is not a home.
   *
   * `sessionId` is the id that send will be NAMED by if the server names it at
   * all — the client-minted one for a claude-sdk send, `null` for a pi send
   * (whose durable id the server mints) and for a review handoff. It is what
   * keeps this claim to the send's own failure: the surface renders one
   * bootstrap, not everything that lands during it.
   */
  stagedSend: { sessionId: string | null } | null;
  /**
   * The projects, Tasks and Knowledge entries whose OWN surface is open AND
   * visible. Such a surface renders a failure naming its object two ways, and
   * both are in place: the control that was refused (the per-object mutation
   * states), and the object's failure note for the writes no control tracks —
   * archiving a Task, a comment on an entry.
   *
   * Usually at most one id per type, since the app opens one of each at a time.
   * Knowledge is the exception: an entry can be read on its route and in the
   * right panel's Knowledge tab at once, and each of those draws its own note.
   *
   * Empty where nothing of that type is on screen, which includes a member that
   * is only a ROW in a list (a row has no failure surface, so a failure about it
   * is announced naming the object instead of being hidden in a list the user is
   * scrolling past) and a surface that is mounted but HIDDEN — an unselected
   * panel tab draws its note where nobody can read it, which is the same as
   * suppressing the failure into nothing.
   */
  openObjects: Record<ObjectFailureType, readonly string[]>;
}

const NO_HOMES: FailureHomes = {
  viewedSessionId: null,
  stagedSend: null,
  openObjects: { project: [], task: [], knowledge: [] },
};

let homes: FailureHomes = NO_HOMES;

/**
 * Stated by the surfaces that render failures; read only at an arrival.
 *
 * Written from an effect and read from the socket, so a claim is accurate as of
 * the last COMMITTED render: a message landing in the gap between a view change
 * committing and its effect flushing is judged against the view the user just
 * left. That costs at most one duplicated or one missed announcement, never the
 * failure itself — `sessionFailures` keeps it on its object regardless, so the
 * user finds it by going there. It is not worth closing by writing the claim
 * during render, which would be a side effect in render for a window narrower
 * than a frame.
 */
export function setFailureHomes(next: FailureHomes): void {
  homes = next;
}

/** Test seam: what the surfaces have claimed. No production caller reads this. */
export function readFailureHomes(): FailureHomes {
  return homes;
}

/** Test seam: forget every claim. */
export function resetFailureHomes(): void {
  homes = NO_HOMES;
}

/**
 * Whether this arrival already has a home, so announcing it would say the same
 * thing twice.
 *
 * The check CONSUMES the arrival — there is nothing left to defer, because the
 * decision is made once, here, at the moment the message lands. A deferred
 * arrival used to be announced later, when the surface that owned it was gone
 * and the failure it described was long over.
 */
export function arrivalHasHome(
  arrival: ArrivalMessage,
  current: FailureHomes = homes,
): boolean {
  if (arrival.severity !== "error") return false;
  if (isConditionCollection(arrival.target)) return true;
  const target = arrival.target;
  const session = target?.type === "session" ? target.id : undefined;
  if (current.stagedSend) {
    // The blockers this surface actually narrates are the server's PRE-creation
    // refusals — an unavailable model, a credential profile, a worktree that is
    // gone — and every one of them names nothing, because the session it would
    // name does not exist yet. Once one does, only its OWN id may be claimed:
    // suppressing every error that lands during a bootstrap silently swallowed
    // a background session's failure, which is the same shape as suppressing
    // every notice that named the viewed session.
    if (!target) return true;
    if (session && session === current.stagedSend.sessionId) return true;
  }
  if (session) return session === current.viewedSessionId;
  // Keyed by object and compared by id: a claim for the open Task says nothing
  // about the twenty other rows in the list, whose failures still have to be
  // announced to reach the user at all.
  if (!target?.id || !isObjectFailureType(target.type)) return false;
  return current.openObjects[target.type].includes(target.id);
}
