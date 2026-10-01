/** Durable, generic session → first-class-object context relationships. */
import type { PaObjectType } from "@assistant/shared/objectLinks";
import type { SessionObjectRef } from "@assistant/shared";
import {
  addLink,
  incoming,
  outgoing,
  memoizedOnLinks,
  outgoingByType,
  type NodeRef,
  type NodeType,
} from "./links.ts";

export type SessionContextObjectType = Exclude<
  PaObjectType,
  "session" | "approval"
>;
export type SessionContextSource = SessionObjectRef["source"];

const NODE_TYPE: Record<SessionContextObjectType, NodeType> = {
  knowledge: "knowledge",
  task: "task",
  project: "project",
  worktree: "worktree",
};

function sessionNode(sessionId: string): NodeRef {
  return { type: "session", id: sessionId };
}

function objectNode(objectType: SessionContextObjectType, id: string): NodeRef {
  return { type: NODE_TYPE[objectType], id };
}

export function linkSessionToObject(
  sessionId: string,
  objectType: SessionContextObjectType,
  id: string,
  source: SessionContextSource,
): void {
  const cleanSession = sessionId.trim();
  const cleanId = id.trim();
  if (!cleanSession || !cleanId)
    throw new Error("Session and object ids are required.");
  addLink(
    sessionNode(cleanSession),
    "context",
    objectNode(objectType, cleanId),
    { metadata: { source } },
  );
}

export function objectRefsForSession(sessionId: string): SessionObjectRef[] {
  return outgoing(sessionNode(sessionId), "context")
    .map(refFromLink)
    .filter((ref): ref is SessionObjectRef => ref !== null);
}

function refFromLink(link: {
  toType: NodeType;
  toId: string;
  metadata?: unknown;
  createdAt: number;
}): SessionObjectRef | null {
  const objectType = objectTypeForNode(link.toType);
  if (!objectType) return null;
  return {
    objectType,
    id: link.toId,
    source: contextSource(link.metadata),
    linkedAt: link.createdAt,
  } satisfies SessionObjectRef;
}

/**
 * Every session's context refs in one query, for the session list; rebuilt
 * only after a session edge changes ({@link memoizedOnLinks}). Every rebuild
 * shares these refs until then, so they are FROZEN at build time (a ref's
 * fields are all primitives, so freezing each ref is a deep freeze): a caller
 * that writes to one throws instead of corrupting every later list.
 */
export const objectRefsBySession: () => ReadonlyMap<
  string,
  readonly Readonly<SessionObjectRef>[]
> = memoizedOnLinks("session", () => {
  const index = new Map<string, readonly Readonly<SessionObjectRef>[]>();
  for (const [sessionId, links] of outgoingByType("session", "context")) {
    const refs = links
      .map(refFromLink)
      .filter((ref): ref is SessionObjectRef => ref !== null)
      .map((ref) => Object.freeze(ref));
    if (refs.length > 0) index.set(sessionId, Object.freeze(refs));
  }
  return index;
});

export function sessionIdsForObject(
  objectType: SessionContextObjectType,
  id: string,
): string[] {
  return incoming(objectNode(objectType, id), "context")
    .filter((link) => link.fromType === "session")
    .map((link) => link.fromId);
}

function objectTypeForNode(type: NodeType): SessionContextObjectType | null {
  switch (type) {
    case "knowledge":
      return "knowledge";
    case "task":
      return "task";
    case "project":
      return "project";
    case "worktree":
      return "worktree";
    default:
      return null;
  }
}

function contextSource(metadata: unknown): SessionContextSource {
  if (metadata && typeof metadata === "object") {
    const source = (metadata as { source?: unknown }).source;
    if (
      source === "initial-context" ||
      source === "comment-handoff" ||
      source === "manual"
    )
      return source;
  }
  return "manual";
}
