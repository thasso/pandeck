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
import { knowledgeFiles, type KbFileInfo } from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import { knowledgeBaseEnabled } from "./knowledgeBaseSettings.ts";
import { knowledgeLegacyPath } from "./knowledgeLegacyLinks.ts";

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
  // Off, the Knowledge Base answers nothing: its links read as unknown.
  const knowledge =
    knowledgeBaseEnabled() &&
    unique.some((uri) => parsePaObjectLink(uri)?.objectType === "knowledge")
      ? await knowledgeFiles(new KnowledgeBaseStore()).catch(() => null)
      : null;
  return Promise.all(unique.map((uri) => resolveOne(uri, sessions, knowledge)));
}

async function resolveOne(
  uri: string,
  sessions: Awaited<ReturnType<typeof hub.listSessions>>,
  knowledge: KbFileInfo[] | null,
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
      // The link names a file by its path. When the folder cannot be read,
      // say "unknown" rather than draw a broken link.
      if (!knowledge)
        return { ...fallbackPaObjectResolution(parsed), existence: "unknown" };
      // A link from before links were paths names a retired entry id.
      const legacyPath = knowledgeLegacyPath(parsed.id, knowledge);
      const file = knowledge.find(
        (candidate) =>
          candidate.path === parsed.id || candidate.path === legacyPath,
      );
      if (!file) return resolved(parsed, undefined, false);
      return {
        ...resolved(parsed, file.title, true),
        href: paObjectHref({ ...parsed, id: file.path }),
      };
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
