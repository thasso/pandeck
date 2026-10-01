import {
  approvalCardHref,
  fallbackPaObjectResolution,
  paObjectHref,
  paObjectTypeLabel,
  parsePaObjectLink,
  paWorktreeTitle,
  type PaObjectLink,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import { readTask } from "./tasks.ts";
import { approvalForId } from "./pendingApprovals.ts";
import { getProject } from "./projectRegistry.ts";
import { hub } from "./hub.ts";
import { resolveWorktreeRow } from "./worktrees/worktreeResolve.ts";
import { getKnowledgeIndex, type KbIndex } from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";

/**
 * Compact resolver for first-class `pa://` object links.
 *
 * It intentionally returns title/route/existence metadata only. Callers that need
 * full object bodies must use the object's dedicated read surface.
 */
export async function resolvePaObjectLinks(
  uris: readonly string[],
): Promise<PaObjectLinkResolution[]> {
  const unique = [
    ...new Set(uris.map((uri) => uri.trim()).filter(Boolean)),
  ].slice(0, 100);
  const sessions = unique.some(
    (uri) => parsePaObjectLink(uri)?.objectType === "session",
  )
    ? await hub.listSessions({ includeArchived: true })
    : [];
  const knowledge = unique.some(
    (uri) => parsePaObjectLink(uri)?.objectType === "knowledge",
  )
    ? await getKnowledgeIndex(new KnowledgeBaseStore()).catch(() => null)
    : null;
  return Promise.all(unique.map((uri) => resolveOne(uri, sessions, knowledge)));
}

async function resolveOne(
  uri: string,
  sessions: Awaited<ReturnType<typeof hub.listSessions>>,
  knowledge: KbIndex | null,
): Promise<PaObjectLinkResolution> {
  const parsed = parsePaObjectLink(uri);
  if (!parsed) {
    return {
      uri,
      objectType: "unknown",
      knownType: false,
      id: uri,
      href: "#unresolved-pa-link",
      title: "Invalid app link",
      typeLabel: "Object",
      existence: "missing",
    };
  }

  switch (parsed.objectType) {
    case "task": {
      const task = readTask(parsed.id);
      return resolved(parsed, task ? task.title : undefined, Boolean(task));
    }
    case "project": {
      const project = getProject(parsed.id);
      return resolved(
        parsed,
        project ? project.name : undefined,
        Boolean(project),
      );
    }
    case "session": {
      const session = sessions.find((row) => row.id === parsed.id);
      return resolved(
        parsed,
        session ? session.title : undefined,
        Boolean(session),
      );
    }
    case "worktree": {
      const worktree = await resolveWorktreeRow(parsed.id);
      const project = worktree ? getProject(worktree.projectId) : null;
      const title = worktree
        ? paWorktreeTitle(worktree, project?.name)
        : undefined;
      return resolved(parsed, title, Boolean(worktree));
    }
    case "knowledge": {
      // Resolve titles/existence from the rebuildable KB index. When the index
      // is unavailable, fall back to an explicitly unknown placeholder rather
      // than a broken link, since the entry may simply not be indexed yet.
      if (!knowledge)
        return { ...fallbackPaObjectResolution(parsed), existence: "unknown" };
      const entry = knowledge.entries.find(
        (candidate) => candidate.id === parsed.id,
      );
      return resolved(parsed, entry?.title, Boolean(entry));
    }
    case "approval": {
      // The card's session is what gives it an address; the bare id has none.
      // No live `detail`: this answer is cached by the client, and the viewed
      // session's own cards resolve from its live approval state instead.
      const card = approvalForId(parsed.id);
      if (!card) return resolved(parsed, undefined, false);
      return {
        ...resolved(parsed, card.title, true),
        href: approvalCardHref(card.sessionId, card.id),
      };
    }
    default:
      return fallbackPaObjectResolution(parsed);
  }
}

function resolved(
  link: PaObjectLink,
  title: string | undefined,
  exists: boolean,
): PaObjectLinkResolution {
  const fallback = fallbackPaObjectResolution(link);
  return {
    ...fallback,
    href: paObjectHref(link),
    title: title?.trim() || fallback.title,
    typeLabel: paObjectTypeLabel(link.objectType),
    existence: exists ? "exists" : "missing",
  };
}
