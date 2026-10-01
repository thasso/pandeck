/**
 * `show_files` — put files that already exist on this host in front of the
 * user, without copying them anywhere.
 *
 * The app serves any absolute path under `/api/files/...`
 * (`app/server/src/directFileHttp.ts`). An agent can write a Markdown link to
 * that URL by hand, and a hand-written link stays a link. This tool exists for
 * what a link cannot do: confirm the file is really there, report its size, and
 * emit the structured output the chat renders as a CARD per file — the tile
 * with the file's kind, size and viewer/download actions
 * (`app/web/src/components/ServedFileCard.tsx`). The snippet in the payload is
 * the agent's own copy, for placing the file inside its reply.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { ShowFilesCard, ShowFilesCardFile } from "@assistant/shared";
import { parseDocumentTarget } from "@assistant/shared/documentTargets";
import { servedFileKindOf } from "@assistant/shared/servedFiles";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { CWD, DATA_DIR } from "../../config.ts";
import { directFileUrlPath } from "../../directFileHttp.ts";
import { assertArtifactSessionId } from "../../documentGrantTargets.ts";

type ShowFilesParams = {
  paths: string[];
  label?: string;
};

const MAX_FILES = 10;

const showFilesParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["paths"],
  properties: {
    paths: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FILES,
      items: { type: "string" },
      description:
        "Files to show: a path (absolute or relative to the working directory) or an address the app already serves (`/api/files/...`, `/api/session-artifacts/<session>/<path>`). They stay where they are; nothing is copied.",
    },
    label: {
      type: "string",
      description:
        "Caption for a single file, in place of its name — what it SHOWS, not where it sits.",
    },
  },
} as const;

export const showFilesTool = defineAgentTool<ShowFilesParams>({
  name: "show_files",
  label: "Show files",
  description:
    "Show files from this host in the chat: each one becomes a card the user can open or download, with a picture shown inside its card. The result also carries the Markdown snippet for each file, so you can place the same file inside your reply where it belongs. Files are never copied and never enter your own context.",
  parameters: showFilesParamsSchema as unknown as Record<string, unknown>,
  async execute(params, ctx) {
    const cwd = ctx.session.cwd ?? CWD;
    const paths = params.paths.slice(0, MAX_FILES);
    const files: ShowFilesCardFile[] = [];

    for (const raw of paths) {
      if (ctx.signal?.aborted) throw new Error("Operation aborted");
      const { path, url } = await resolveShowTarget(raw, cwd);
      const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`File not found: ${path}`);
        throw error;
      });
      // The same bar the HTTP route holds: a directory, a socket or a device
      // is not something the reader can be shown.
      if (!stats.isFile())
        throw new Error(
          stats.isDirectory()
            ? `Not a file: ${path} is a directory.`
            : `Not a regular file: ${path}`,
        );

      const name = basename(path);
      const label = (paths.length === 1 ? params.label?.trim() : "") || name;
      const caption = markdownText(label);
      // Presentation follows the shared classification, never the caller's
      // spelling: an image is the one kind a Markdown embed renders in place.
      // The CARD classifies the same file itself, from the same address, so the
      // row deliberately states no kind for it to trust.
      const isImage = servedFileKindOf(path) === "image";
      files.push({
        url,
        name,
        label,
        size: stats.size,
        snippet: isImage ? `![${caption}](${url})` : `[${caption}](${url})`,
      });
    }

    const card: ShowFilesCard = { files };
    return jsonResult({ renderKind: "showFiles" as const, version: 1, card });
  },
});

/**
 * Escape what would break the snippet's link text: a `]` closes it early, a
 * backslash escapes the next character, and a newline ends the link outright. A
 * file name is user data, so this is not hypothetical.
 */
function markdownText(value: string): string {
  return value
    .replace(/[\\[\]]/g, (character) => `\\${character}`)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The file to stat and the address the card is built from.
 *
 * An input the app already serves keeps its own source identity — a captured
 * artifact stays an artifact, with its `/artifacts/...` viewer — so the address
 * goes through the shared target parser rather than being reassembled from a
 * filesystem path. Anything else is an ordinary path on this host.
 */
async function resolveShowTarget(
  input: string,
  cwd: string,
): Promise<{ path: string; url: string }> {
  const raw = input.trim();
  if (!raw) throw new Error("A file path is required.");
  if (raw.startsWith(HOST_URL_PREFIX) || raw.startsWith(ARTIFACT_URL_PREFIX)) {
    const target = parseDocumentTarget(raw);
    // A host path has no symlink rule ON PURPOSE (`docs/served-files.md`): the
    // route serves whatever path a token holder names, and an agent may already
    // read anything the service can, so a link there is simply a file. The
    // artifact branch below is the opposite case — a session directory IS an
    // authority boundary — and that is where canonicalization belongs.
    if (target?.kind === "hostFile")
      return { path: target.path, url: directFileUrlPath(target.path) };
    if (target?.kind === "sessionArtifact") {
      const { path, relativePath } = await sessionArtifactPath(
        target.sessionId,
        target.path,
      );
      return {
        path,
        url: sessionArtifactUrlPath(target.sessionId, relativePath),
      };
    }
    throw new Error(`Not a file this app serves: ${raw}`);
  }
  const path = resolveInputPath(raw, cwd);
  return { path, url: directFileUrlPath(path) };
}

const HOST_URL_PREFIX = "/api/files/";
const ARTIFACT_URL_PREFIX = "/api/session-artifacts/";

/** Absolute, `~`-relative or working-directory-relative, as the file tools take. */
function resolveInputPath(input: string, cwd: string): string {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? join(homedir(), input.slice(2))
        : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * A captured artifact, contained in the one session directory that owns it —
 * decided on the CANONICAL path, exactly as `directFileGrants.ts` decides it.
 * Lexical containment is not enough: `..` is the obvious way out, and a SYMLINK
 * inside the session directory needs no `..` at all, so `escape.png ->
 * ~/.ssh/id_ed25519` would read as perfectly contained while `stat` (and then
 * the artifact route) happily followed it out. The session folder is likewise
 * an authority boundary, not an alias to another session or to somewhere
 * outside `DATA_DIR`.
 *
 * The canonical spelling is what the caller then uses: its name decides the
 * card's kind, and its relative path is the URL the reader opens.
 */
async function sessionArtifactPath(
  sessionId: string,
  path: string,
): Promise<{ path: string; relativePath: string }> {
  // The id must name one direct child, before any of it reaches a join: the
  // identity check below compares POSIX `dirname`/`basename`, which would read
  // a backslash as an ordinary character in a name rather than as a separator.
  assertArtifactSessionId(sessionId);
  const artifactsRoot = await canonicalPath(
    join(DATA_DIR, "session-artifacts"),
    path,
  );
  const sessionRoot = await canonicalPath(join(artifactsRoot, sessionId), path);
  if (
    dirname(sessionRoot) !== artifactsRoot ||
    basename(sessionRoot) !== sessionId
  )
    throw new Error(`Not a session artifact: ${path}`);
  const file = await canonicalPath(resolve(sessionRoot, path), path);
  const relativePath = relative(sessionRoot, file);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  )
    throw new Error(`Not a session artifact: ${path}`);
  return { path: file, relativePath };
}

/** `realpath`, reporting a missing link target as the ordinary not-found error. */
async function canonicalPath(path: string, requested: string): Promise<string> {
  return realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new Error(`File not found: ${requested}`);
    throw error;
  });
}

function sessionArtifactUrlPath(sessionId: string, path: string): string {
  const segments = [sessionId, ...path.split("/")].map(encodeURIComponent);
  return `${ARTIFACT_URL_PREFIX}${segments.join("/")}`;
}
