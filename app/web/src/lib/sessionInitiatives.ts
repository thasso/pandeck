/**
 * Which Initiative a Sessions inbox card belongs to (`docs/initiatives.md`,
 * Sessions working on its Tasks). Read from the `initiatives` summaries alone:
 * a session is a COORDINATOR when an Initiative records it as driving it
 * (`coordinatorSessionIds`), and a MEMBER when it was started from one of the
 * Initiative's Tasks (`sessionIds`). Nothing is inferred from spawns or
 * titles.
 *
 * Framework-free by the `lib/` contract.
 */
import type { InitiativeSummary } from "@assistant/shared";

export interface SessionInitiativeRelation {
  id: string;
  title: string;
  /** Recorded as driving it, rather than started from one of its Tasks. */
  coordinator: boolean;
  /** The Initiative's progress, which a coordinator's marker draws. */
  done: number;
  total: number;
  /** Any further Initiatives it belongs to, named only in the tooltip. */
  others: string[];
}

/** How an Initiative is named outside its own page. */
function initiativeName(initiative: { id: string; title: string }): string {
  return `Initiative-${initiative.id} ${initiative.title}`;
}

/**
 * Each session's Initiative: the first one recording it as coordinator, else
 * the first one it works on, in the list's own order. A coordinator outranks
 * a member because it is the stronger statement about the session.
 */
export function initiativesBySession(
  initiatives: readonly InitiativeSummary[],
): Map<string, SessionInitiativeRelation> {
  const found = new Map<
    string,
    { coordinator: InitiativeSummary[]; member: InitiativeSummary[] }
  >();
  const entry = (sessionId: string) => {
    let value = found.get(sessionId);
    if (!value) {
      value = { coordinator: [], member: [] };
      found.set(sessionId, value);
    }
    return value;
  };
  for (const initiative of initiatives) {
    for (const id of initiative.coordinatorSessionIds)
      entry(id).coordinator.push(initiative);
    for (const id of initiative.sessionIds) {
      const value = entry(id);
      if (!value.coordinator.includes(initiative))
        value.member.push(initiative);
    }
  }
  const result = new Map<string, SessionInitiativeRelation>();
  for (const [sessionId, { coordinator, member }] of found) {
    const all = [...coordinator, ...member];
    const lead = all[0]!;
    result.set(sessionId, {
      id: lead.id,
      title: lead.title,
      coordinator: coordinator.length > 0,
      done: lead.progress.done,
      total: lead.progress.total,
      others: all.slice(1).map(initiativeName),
    });
  }
  return result;
}

/** The marker's tooltip and spoken label. */
export function sessionInitiativeLabel(
  relation: SessionInitiativeRelation,
): string {
  const lead = relation.coordinator
    ? `Coordinating ${initiativeName(relation)}: ${relation.done} of ${relation.total} Tasks done`
    : `Part of ${initiativeName(relation)}`;
  return relation.others.length
    ? `${lead}; also ${relation.others.join(", ")}`
    : lead;
}

/** Everything the marker renders, for the card's relations key. */
export function sessionInitiativeKey(
  relation: SessionInitiativeRelation | undefined,
): string {
  return relation
    ? [
        relation.id,
        relation.title,
        relation.coordinator ? "c" : "m",
        relation.done,
        relation.total,
        ...relation.others,
      ].join("\u001f")
    : "";
}
