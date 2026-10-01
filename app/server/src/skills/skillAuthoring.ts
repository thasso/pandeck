/**
 * Validated, Git-committing authoring of the skills library
 * ([Task-633](pa://task/633), `docs/skills.md`).
 *
 * This is the layer between the agent tools and {@link SkillLibraryStore}: it
 * resolves a DECLARED name to the folder the scanner reported, applies one
 * complete operation through the anchored no-follow source seam, re-scans, and
 * only then lets the store commit. A caller never supplies a filesystem path,
 * and nothing here writes or follows a symlink.
 *
 * Two rules make a commit trustworthy. The repository must be entirely clean
 * first (the store enforces it), so what is committed is exactly what the tool
 * wrote — including untracked additions, which is why a created skill is
 * complete rather than half-tracked. And the post-write scan must show the
 * target valid with NO diagnostic that was not already there: a mutation may
 * not repair, break or absorb a folder it was not asked about.
 */
import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  isSafeSkillName,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_FILE_PREVIEW_BYTES,
  MAX_SKILL_RAW_FILE_BYTES,
  type SkillDiagnostic,
  type SkillFileTree,
  type SkillSummary,
} from "@assistant/shared";
import { publishSkillLibrary } from "./skillLibrary.ts";
import { buildSkillFileTree } from "./skillFiles.ts";
import {
  assertSafeSkillName,
  readManifestHandle,
  assertSkillDescription,
  assertSkillManifest,
  formatSkillManifest,
  SkillValidationError,
  withDeclaredName,
} from "./skillManifest.ts";
import {
  scanSkillLibrary,
  skillSourceIdentity,
  type SkillLibraryScan,
} from "./skillLibraryScanner.ts";
import {
  skillLibraryStore,
  SkillMutationCancelledError,
  type SkillCommitMeta,
  type SkillCommittedEntry,
  type SkillCommitResult,
  type SkillLibraryStore,
  type SkillMutationContext,
  type SkillRepoStatus,
} from "./skillLibraryStore.ts";
import {
  createSkillChildDirectory,
  directoryChangedAt,
  createSkillChildFile,
  ensureSkillChildDirectory,
  iterateSkillDirectory,
  linkSkillChild,
  pinSkillHandle,
  readSkillDirectory,
  removeSkillChildFile,
  removeVerifiedSkillTree,
  rmdirSkillChild,
  sameSkillSource,
  readSkillChildLink,
  skillChildChangedAt,
  skillChildIdentity,
  skillChildStillIs,
  skillHandleIdentity,
  type SkillPin,
  type SkillTreeContents,
  unlinkSkillChildIfSame,
  SkillNameTakenError,
  withReservedSkillFolder,
  SKILL_FILE_NAME,
  withLibraryRoot,
  withSkillChild,
  withSkillChildForUpdate,
  withSkillSource,
  writeSkillChildFile,
  type SkillSourceIdentity,
} from "./skillSource.ts";

/** Bound on `SKILL.md` source a tool writes or reads back for editing. */
export const MAX_SKILL_SOURCE_BYTES = MAX_SKILL_BODY_BYTES;
/** Bound on ONE supporting text file a tool writes. */
export const MAX_SKILL_TEXT_FILE_BYTES = MAX_SKILL_FILE_PREVIEW_BYTES;
/** Bound on ONE imported attachment; the same limit the raw viewer serves. */
export const MAX_SKILL_IMPORT_BYTES = MAX_SKILL_RAW_FILE_BYTES;
/** Bounds on one supporting-file batch. */
export const MAX_SKILL_FILE_OPERATIONS = 20;
const MAX_SKILL_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_RELATIVE_PATH_BYTES = 4 * 1024;

/** One skill the scanner currently reports as valid. */
interface ResolvedSkill {
  name: string;
  description: string;
  folder: string;
  /** Library-relative `SKILL.md` path. */
  path: string;
}

/**
 * What a caller may pass a mutation besides the change itself.
 *
 * `signal` is the tool call's cancellation. A mutation honours it only at its
 * own checkpoints — before it writes, and inside the read-only proofs that can
 * hash whatever a hand author left beside a skill — never once it is committed
 * to finishing. Stopping a mutation is therefore always "nothing happened",
 * never "half of it happened".
 */
export interface SkillMutationOptions {
  signal?: AbortSignal;
}

/** What every mutation answers with. */
export interface SkillMutationOutcome {
  skill?: SkillSummary;
  folder: string;
  commit: SkillCommitResult;
  status: SkillRepoStatus;
}

/** One supporting-file change inside a single batch. */
export type SkillFileOperation =
  | { op: "write"; path: string; content: string }
  | {
      op: "edit";
      path: string;
      /** Exact, unique, non-overlapping replacements, as `skill_edit` applies. */
      edits: { oldText: string; newText: string }[];
    }
  | {
      op: "import";
      path: string;
      /**
       * The attachment's SIZE as recorded, checked against the per-file and
       * whole-batch budgets BEFORE a byte of it is read: an import that cannot
       * be accepted must not be allocated first.
       */
      size: number;
      /** Reads at most `limit` bytes, so a file that grew cannot beat the check. */
      read: (limit: number) => Promise<Uint8Array>;
      /** Attachment id, echoed back so the result names what was copied. */
      attachmentId: string;
    }
  | { op: "delete"; path: string };

/** What one applied file operation reports back. */
export interface AppliedFileOperation {
  op: string;
  path: string;
  /** Echoed for an import, so the result names what was copied. */
  attachmentId?: string;
  /** How many replacements an `edit` made. */
  replacements?: number;
}

/** The whole-library read behind `skill_list`. */
export interface SkillLibraryOverview {
  libraryPath: string;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
  repository: SkillRepoStatus;
}

/** The one-skill read behind `skill_get`. */
export interface SkillSourceRead {
  name: string;
  description: string;
  folder: string;
  path: string;
  /** Complete `SKILL.md` source INCLUDING frontmatter, bounded. */
  source: string;
  bytes: number;
  truncated: boolean;
  files: SkillFileTree;
}

/** Fresh scan plus compact repository state. */
export async function readSkillLibraryOverview(
  library: SkillLibraryStore = skillLibraryStore,
): Promise<SkillLibraryOverview> {
  await library.ensureInitialized();
  const scan = await scanSkillLibrary(library.root);
  const repository = await library.status();
  return {
    libraryPath: library.root,
    skills: scan.skills,
    diagnostics: scan.diagnostics,
    repository,
  };
}

/**
 * Read one valid skill's complete source and supporting-file tree. Returns
 * `null` for a name the library does not currently declare as valid — a name
 * with a diagnostic is not editable, and `skill_list` already explains why.
 */
export async function readSkillSource(
  name: string,
  library: SkillLibraryStore = skillLibraryStore,
): Promise<SkillSourceRead | null> {
  await library.ensureInitialized();
  const scan = await scanSkillLibrary(library.root);
  return resolveSkillSource(library.root, scan, name);
}

/** Resolve against a completed scan while refusing any subsequent source swap. */
export async function resolveSkillSource(
  root: string,
  scan: SkillLibraryScan,
  name: string,
): Promise<SkillSourceRead | null> {
  if (!isSafeSkillName(name)) return null;
  const summary = scan.skills.find((skill) => skill.name === name);
  if (!summary) return null;
  const target = targetOf(summary);
  const identity = skillSourceIdentity(scan, target.path);
  if (!identity) {
    throw changedSinceScan(target.path, "has no stable source identity");
  }
  try {
    return await withLibraryRoot(root, (rootHandle) =>
      withSkillSource(rootHandle, target.folder, async (source) => {
        if (!sameSkillSource(source.identity, identity)) {
          throw changedSinceScan(target.path, "changed identity");
        }
        const read = await readManifestHandle(source.file, source.size);
        const manifest = assertSkillManifest(read.source, target.path);
        if (
          manifest.name !== target.name ||
          manifest.description !== target.description
        ) {
          throw changedSinceScan(target.path, "changed frontmatter");
        }
        return {
          name: target.name,
          description: target.description,
          folder: target.folder,
          path: target.path,
          source: read.source,
          bytes: read.bytes,
          truncated: read.truncated,
          files: await buildSkillFileTree(source.folder),
        };
      }),
    );
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    throw changedSinceScan(target.path, "could not be reopened consistently");
  }
}

/** Create `<name>/SKILL.md` from a validated declared name, description, body. */
export async function createSkill(
  input: { name: string; description: string; body: string },
  meta: SkillCommitMeta,
  library: SkillLibraryStore = skillLibraryStore,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome> {
  const name = assertSafeSkillName(input.name);
  const description = assertSkillDescription(input.description);
  const source = formatSkillManifest({ name, description, body: input.body });
  assertSourceSize(source, `${name}/${SKILL_FILE_NAME}`);

  return runMutation(
    library,
    { ...meta, skillNames: [name] },
    async (ctx) => {
      // The pre-write scan reads every folder in the library, so it takes
      // the checkpoint too: nothing has happened yet, and a caller who
      // stopped should not have to wait out somebody's thousand folders.
      const before = await scanSkillLibrary(ctx.root, {
        checkpoint: ctx.checkpoint,
      });
      assertNameIsFree(before, name);
      // Everything up to here was reading; the next call creates a directory.
      ctx.checkpoint();
      await withLibraryRoot(ctx.root, async (rootHandle) => {
        // `mkdir` IS the collision check: it never overwrites, so no entry that
        // exists — or appears between a probe and the write — can be taken over.
        // The manifest is then written through the HELD descriptor rather than
        // through the name a second time: re-opening the name is how a folder a
        // hand edit put there in between would end up being written into.
        const created = await withReservedSkillFolder(
          rootHandle,
          name,
          async (reserved) => {
            // Registered only AFTER the folder exists, so the generic `git clean`
            // records it as pre-existing and never removes it; taking it back is
            // this mutation's own job, conditionally, below.
            ctx.touch(name);
            try {
              // Pinned before anything is written into it, and held until the
              // commit has settled: the undo below runs after this scope is gone,
              // and a bare inode NUMBER would by then be as true of a folder a
              // hand author put at the name as of this one.
              const folder = await pin(ctx, pinSkillHandle(reserved.handle));
              // Create-or-fail, not a plain write: the reservation stands at a
              // public name, so a hand author can reach into it, and a manifest
              // that appeared in that instant is theirs to keep.
              const manifest = await pin(
                ctx,
                createSkillChildFile(
                  reserved.handle,
                  SKILL_FILE_NAME,
                  encode(source),
                ),
              );
              // The commit contains exactly this one file, and exactly these
              // bytes. Staging the FOLDER would stage whatever else stands in it
              // by then; staging the NAME alone would still take whatever a hand
              // author wrote over it in the meantime.
              ctx.created(`${name}/${SKILL_FILE_NAME}`, {
                bytes: encode(source),
              });
              // Removing the folder again is this mutation's own job, not the
              // generic `git clean`'s: a failure after `run` returns (a rejecting
              // `pre-commit` hook, say) may find a file a hand author put in it,
              // and cleaning the name would take that with it. The removal below
              // takes back the manifest written here and leaves anything else.
              ctx.onRollback(() =>
                withLibraryRoot(ctx.root, (undoRoot) =>
                  removeAssembledSkill(
                    undoRoot,
                    name,
                    folder.identity,
                    [
                      {
                        kind: "file",
                        name: SKILL_FILE_NAME,
                        identity: manifest.identity,
                        // Written here, so the bytes written here are what must
                        // still be there for the undo to take it back.
                        content: { kind: "bytes", bytes: encode(source) },
                      },
                    ],
                    ctx.blobId,
                  ),
                ),
              );
              // The descriptor still pins the reservation, so this comparison is
              // sound where a bare `stat` would not be: an inode number is reused
              // the instant a directory is removed, but not while it is open.
              if (
                !(await skillChildStillIs(rootHandle, name, reserved.identity))
              ) {
                throw changedSinceScan(
                  name,
                  "was taken over by another entry while the skill was being created",
                );
              }
            } catch (error) {
              // Whatever went wrong, if the name is no longer the directory this
              // reserved, then a hand edit owns it now — and the manifest went
              // into the unreachable inode this created, or nowhere. Disowning it
              // keeps rollback from deleting the user's folder to undo work that
              // never landed in it, and keeps staging from committing it.
              if (
                !(await skillChildStillIs(rootHandle, name, reserved.identity))
              ) {
                ctx.disown(name);
              }
              if (error instanceof SkillNameTakenError) {
                // A manifest appeared inside the reservation between its `mkdir`
                // and this write. Create-or-fail refused it rather than writing
                // over it, and the raw EEXIST explains none of that.
                throw changedSinceScan(
                  `${name}/${SKILL_FILE_NAME}`,
                  "was written by something else while the skill was being created",
                );
              }
              throw error;
            }
            return true;
          },
        );
        if (created === null) {
          throw new SkillValidationError(
            `The library already contains a top-level entry named "${name}". Choose another skill name, or delete that entry by hand first.`,
          );
        }
      });
      return { before, name, folder: name };
    },
    options,
  );
}

/** Apply exact unique text replacements to one skill's `SKILL.md`. */
export async function editSkillSource(
  input: { name: string; edits: { oldText: string; newText: string }[] },
  meta: SkillCommitMeta,
  library: SkillLibraryStore = skillLibraryStore,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome & { replacements: number }> {
  const name = assertSafeSkillName(input.name);
  if (input.edits.length === 0)
    throw new SkillValidationError("At least one edit is required.");

  const outcome = await runMutation(
    library,
    { ...meta, skillNames: [name] },
    async (ctx) => {
      // The pre-write scan reads every folder in the library, so it takes
      // the checkpoint too: nothing has happened yet, and a caller who
      // stopped should not have to wait out somebody's thousand folders.
      const before = await scanSkillLibrary(ctx.root, {
        checkpoint: ctx.checkpoint,
      });
      const target = resolveSkill(before, name);
      const identity = scannedIdentity(before, target);
      ctx.touch(target.path);
      // The manifest is read and rewritten through one handle below, and the
      // truncation is the first irreversible step; this is the last moment a
      // stop costs nothing.
      ctx.checkpoint();
      const replacements = await withLibraryRoot(ctx.root, (rootHandle) =>
        withVerifiedSkillFolder(rootHandle, target, identity, async (folder) =>
          // One handle for the read and the rewrite: the text an edit matched
          // and the bytes it replaces belong to the same inode, and it is the
          // inode the scan selected.
          withSkillChildForUpdate(folder, SKILL_FILE_NAME, async (file) => {
            if (!sameFileIdentity(file.identity, identity.file)) {
              throw changedSinceScan(target.path, "changed identity");
            }
            const current = await readManifestHandle(file.handle, file.size);
            if (current.truncated) {
              throw new SkillValidationError(
                `${target.path} is larger than ${MAX_SKILL_SOURCE_BYTES} bytes, so it cannot be edited through this tool; edit it by hand in the library.`,
              );
            }
            const applied = applyExactReplacements(
              current.source,
              input.edits,
              target.path,
            );
            const manifest = assertSkillManifest(applied.content, target.path);
            if (manifest.name !== target.name) {
              throw new SkillValidationError(
                `An edit may not change the declared name ("${target.name}" → "${manifest.name}"). Use the rename tool, which also moves the source folder.`,
              );
            }
            assertSourceSize(applied.content, target.path);
            // From here the manifest's committed bytes are gone, so a later
            // staging or commit failure must be able to restore this path.
            const written = encode(applied.content);
            ctx.damaged(target.path);
            await file.replace(written);
            // And now the path holds exactly these bytes, which is what makes
            // restoring it safe: anything else there later is somebody else's.
            ctx.wrote(target.path, written);
            return applied.replacements;
          }),
        ),
      );
      return { before, name, folder: target.folder, extra: { replacements } };
    },
    options,
  );
  return { ...outcome, replacements: outcome.extra.replacements };
}

/** Apply one atomic batch of supporting-file writes, imports, and deletes. */
export async function manageSkillFiles(
  input: { name: string; operations: SkillFileOperation[] },
  meta: SkillCommitMeta,
  library: SkillLibraryStore = skillLibraryStore,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome & { applied: AppliedFileOperation[] }> {
  const name = assertSafeSkillName(input.name);
  const planned = await planFileOperations(input.operations);
  /** How many replacements each `edit` made, filled in as they are applied. */
  const replacements = new Map<string, number>();

  const outcome = await runMutation(
    library,
    { ...meta, skillNames: [name] },
    async (ctx) => {
      // The pre-write scan reads every folder in the library, so it takes
      // the checkpoint too: nothing has happened yet, and a caller who
      // stopped should not have to wait out somebody's thousand folders.
      const before = await scanSkillLibrary(ctx.root, {
        checkpoint: ctx.checkpoint,
      });
      const target = resolveSkill(before, name);
      const identity = scannedIdentity(before, target);
      for (const operation of planned)
        ctx.touch(`${target.folder}/${operation.path}`);
      // The batch applies as a whole, so the whole of it is what a stop can
      // still avoid: from the first write below it either lands or is undone.
      ctx.checkpoint();
      await withLibraryRoot(ctx.root, (rootHandle) =>
        withVerifiedSkillFolder(
          rootHandle,
          target,
          identity,
          async (folder) => {
            for (const operation of planned) {
              const path = `${target.folder}/${operation.path}`;
              // Reported when the change HAPPENS, never before attempting it.
              // A removal that refuses because a hand edit replaced the file
              // puts that replacement back, so the path was not changed by this
              // mutation — and a rollback that checked it out from HEAD would
              // then discard the replacement to undo work never done to it.
              if (operation.op === "delete") {
                await deleteRelativeFile(folder, operation.path, target.folder);
                ctx.removed(path);
              } else if (operation.op === "edit") {
                // An edit never creates anything: the file it rewrites was
                // committed before this mutation started (the tree was clean),
                // so the generic restore owns undoing it, exactly as it does
                // for a SKILL.md edit.
                const written = await editRelativeFile(
                  folder,
                  operation.path,
                  operation.edits,
                  target.folder,
                  // The truncating write is where the old bytes go.
                  () => ctx.damaged(path),
                );
                ctx.wrote(path, written.bytes);
                replacements.set(operation.path, written.replacements);
              } else {
                await writeRelativeFile(
                  folder,
                  operation.path,
                  operation.bytes,
                  target.folder,
                  // What this batch brings into existence is this batch's to
                  // remove, and nothing else's: Git cannot restore a path that
                  // is not in HEAD, and removing one BY NAME would delete
                  // whatever a hand author has since put there instead. So each
                  // created entry is pinned and taken back only while it is
                  // still that inode — a file only while it is the one written
                  // here, a directory only while it is empty. Deepest first,
                  // which is the reverse of creation order.
                  (created, kind, pinned) => {
                    ctx.hold(pinned.handle);
                    // Not in HEAD, so no restore can bring it back — but it
                    // does belong in the commit, and by its own exact path, so
                    // that staging the batch cannot sweep up a neighbour.
                    if (kind === "file") {
                      // These are bytes this batch wrote itself, so the proof
                      // is the bytes: the index entry has to hash to them.
                      ctx.created(`${target.folder}/${created}`, {
                        bytes: operation.bytes,
                      });
                    }
                    ctx.onRollback(() =>
                      withLibraryRoot(ctx.root, (undoRoot) =>
                        removeCreatedEntry(
                          undoRoot,
                          target,
                          identity,
                          created,
                          kind,
                          pinned.identity,
                          kind === "file"
                            ? async (handle) =>
                                (await ctx.blobId(handle)) ===
                                (await ctx.blobId(operation.bytes))
                            : undefined,
                        ),
                      ),
                    );
                  },
                  // The truncating open is where the old bytes go, so that is
                  // the moment the path becomes this mutation's to restore.
                  () => ctx.damaged(path),
                );
                // Written whole: from here the path may be restored only while
                // it still holds these bytes and nobody else's.
                ctx.wrote(path, operation.bytes);
              }
            }
          },
        ),
      );
      return {
        before,
        name,
        folder: target.folder,
        extra: {
          applied: planned.map((operation) => ({
            op: operation.op,
            path: operation.path,
            ...(operation.op === "import"
              ? { attachmentId: operation.attachmentId }
              : {}),
            ...(operation.op === "edit"
              ? { replacements: replacements.get(operation.path) ?? 0 }
              : {}),
          })),
        },
      };
    },
    options,
  );
  return { ...outcome, applied: outcome.extra.applied };
}

/** Move the source folder and rewrite the declared name in one commit. */
export async function renameSkill(
  input: { name: string; newName: string },
  meta: SkillCommitMeta,
  library: SkillLibraryStore = skillLibraryStore,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome & { previousName: string }> {
  const name = assertSafeSkillName(input.name);
  const newName = assertSafeSkillName(input.newName, "new name");
  if (name === newName)
    throw new SkillValidationError(
      `"${name}" is already the declared name; nothing to rename.`,
    );

  const outcome = await runMutation(
    library,
    { ...meta, skillNames: [name, newName] },
    async (ctx) => {
      // The pre-write scan reads every folder in the library, so it takes
      // the checkpoint too: nothing has happened yet, and a caller who
      // stopped should not have to wait out somebody's thousand folders.
      const before = await scanSkillLibrary(ctx.root, {
        checkpoint: ctx.checkpoint,
      });
      const target = resolveSkill(before, name);
      const identity = scannedIdentity(before, target);
      assertNameIsFree(before, newName);
      ctx.touch(target.folder);
      // The destination is reserved by the next call, which is a write.
      ctx.checkpoint();
      await withLibraryRoot(ctx.root, async (rootHandle) => {
        // The destination is CLAIMED, never taken. `mkdir` fails on any entry
        // that already holds the name, and every step below is the same kind of
        // create-or-fail call — `mkdir`, `link`, `O_CREAT|O_EXCL` — so the skill
        // is assembled at the new name without a single operation that could
        // replace something. A `rename` of the folder would have been simpler,
        // but POSIX `rename` REPLACES an empty destination directory, and no
        // check in front of it closes that window; `renameat2(RENAME_NOREPLACE)`
        // is not reachable from this runtime, so the primitives that already
        // refuse are used instead of one that has to be guarded.
        const performed = await withReservedSkillFolder(
          rootHandle,
          newName,
          async (reserved) => {
            // Registered only AFTER it exists, so rollback records it as
            // pre-existing and its generic `git clean` never touches a name a
            // hand edit may also want. This mutation undoes its own work.
            ctx.touch(newName);
            // Pinned before anything is placed inside it and held until the
            // commit settles: the undo runs after this scope is gone, and the
            // folder's inode NUMBER alone would by then say nothing about
            // whether the folder still is this one.
            const destination = await pin(ctx, pinSkillHandle(reserved.handle));
            const keep = pinKeeper(ctx, target.folder);
            // What the undo must find at the new name: the placement plus the
            // fresh manifest. Filled AS each entry is placed, never afterwards,
            // because a placement that fails halfway must still be undoable
            // down to the last name it managed to make.
            const undoable: PlacedEntry[] = [];
            // And what the source must still hold before it may be removed: the
            // same placement, plus the OLD manifest.
            const expectedSource: PlacedEntry[] = [];
            // The pinned source, which only exists once the folder below is
            // open: the removal further down is bound to these inodes.
            let sourcePins: PinnedSkillSource | undefined;
            try {
              await withVerifiedSkillFolder(
                rootHandle,
                target,
                identity,
                async (folder) => {
                  // Pinned here, because the source is REMOVED further down:
                  // the folder identity that removal is bound to, and the
                  // manifest identity it checks the tree against, must be
                  // inodes this call holds and not numbers the scan wrote down.
                  const pinned = await pinSkillSource(ctx, folder, target);
                  sourcePins = pinned;
                  const rewritten = withDeclaredName(
                    pinned.text,
                    target.path,
                    newName,
                  );
                  assertSkillManifest(
                    rewritten,
                    `${newName}/${SKILL_FILE_NAME}`,
                  );

                  // Everything except the manifest is hard-linked across: the
                  // new name is the same inode, so nothing is copied and the
                  // link itself proves later which names this call made.
                  await placeSkillChildren(
                    folder,
                    reserved.handle,
                    undoable,
                    keep,
                    target.folder,
                    ctx.committedObject,
                  );
                  // The manifest is written fresh because its declared name
                  // changes; `O_CREAT|O_EXCL` keeps that from replacing a file
                  // that appeared under the name in the meantime, and the pin
                  // comes from the descriptor it was created through.
                  const manifestPlaced = await keep(() =>
                    createSkillChildFile(
                      reserved.handle,
                      SKILL_FILE_NAME,
                      encode(rewritten),
                    ),
                  );
                  const placement = [...undoable];
                  undoable.push({
                    kind: "file",
                    name: SKILL_FILE_NAME,
                    identity: manifestPlaced.identity,
                    // Written here, not moved: these bytes are the expectation.
                    content: { kind: "bytes", bytes: encode(rewritten) },
                  });
                  // Every placed name, by its own exact path: the destination
                  // folder is not staged as a whole, so nothing a hand author
                  // put beside the placement can ride into this commit. The
                  // placement is MOVED content, proved by what the repository
                  // committed at the old path; the manifest is not moved at all
                  // — it is rewritten here, so it is proved by its bytes.
                  claimPlacedFiles(ctx, newName, target.folder, placement);
                  ctx.created(`${newName}/${SKILL_FILE_NAME}`, {
                    bytes: encode(rewritten),
                  });
                  // Everything is at the new name — but is the new name still
                  // this reservation? If a hand edit replaced it, the content
                  // above went into a directory nothing can reach any more, and
                  // removing the source would be deleting the only copy left.
                  if (
                    !(await skillChildStillIs(
                      rootHandle,
                      newName,
                      reserved.identity,
                    ))
                  ) {
                    throw changedSinceScan(
                      newName,
                      "was taken over by another entry while the skill was being renamed",
                    );
                  }
                  // What the SOURCE must still hold before it may be removed
                  // as a whole — by CONTENT, not by inode. The manifest is the
                  // one entry the rename reads and does not carry across, and a
                  // hand author editing it in place after that read keeps its
                  // inode: identity alone would let the tree, and their edit,
                  // be deleted while the commit describes the version this
                  // mutation read.
                  const sourceManifest = await ctx.committedObject(target.path);
                  expectedSource.push(
                    {
                      kind: "file",
                      name: SKILL_FILE_NAME,
                      identity: pinned.manifest,
                      content:
                        sourceManifest === undefined
                          ? { kind: "unproven" }
                          : { kind: "committed", object: sourceManifest },
                    },
                    ...placement,
                  );
                },
              );
              // The old folder goes as a whole, under a private name: moved
              // out of reach first, identified there, and checked against what
              // was just placed, so a file a hand edit wrote into it stops the
              // rename instead of disappearing with it. Nothing below it is
              // ever removed through a name anything else can rebind.
              const sourceProof = cancellableExpectation(async (tree) => {
                const contents = await treeHoldsExactly(
                  tree,
                  expectedSource,
                  ctx.blobId,
                );
                // The next thing this removal does is empty the tree, so this
                // is where the rename stops being something to interrupt.
                if (contents.holds) ctx.beyondCancellation();
                return contents;
              });
              const removal = await removeVerifiedSkillTree(
                rootHandle,
                target.folder,
                sourcePins!.folder,
                sourceProof.expectation,
              );
              sourceProof.rethrow();
              if (removal !== "removed") {
                if (removal === "partial") {
                  // Part of the old folder is already gone, so this is not a
                  // refusal over an untouched tree: the committed files are the
                  // only intact copy and rollback has to put them back.
                  ctx.damaged(target.folder);
                }
                throw changedSinceScan(
                  target.folder,
                  removal === "unexpected-content"
                    ? "gained content while the skill was being renamed"
                    : removal === "partial"
                      ? "could only be partly removed"
                      : "is no longer the folder that was scanned",
                );
              }
              // Only NOW is the old name this mutation's to restore: until the
              // removal succeeded, the rename had read the folder and linked
              // out of it without changing it, and reverting it to HEAD would
              // have reverted a hand edit rather than this mutation. And it
              // stays restorable only while the name is still EMPTY of anything
              // else — a folder standing there again belongs to somebody else.
              ctx.removed(target.folder);
              // The new name must go away again too, but NOT through the
              // generic `git clean`: by the time a refused commit rolls back, a
              // hand author may have added a file under it, and cleaning the
              // name would delete that too. This mutation knows exactly what it
              // assembled, so it removes exactly that — and only while the tree
              // still holds nothing else.
              ctx.onRollback(() =>
                withLibraryRoot(ctx.root, (undoRoot) =>
                  removeAssembledSkill(
                    undoRoot,
                    newName,
                    destination.identity,
                    undoable,
                    ctx.blobId,
                  ),
                ),
              );
            } catch (error) {
              // This block UNDOES, and an undo is never interruptible — not
              // even by the stop that caused it. The removal below checks each
              // placed file's content through the same hashing the proof used,
              // and a cancellation still live here would abandon that check and
              // leave the assembled destination standing.
              ctx.beyondCancellation();
              const stillOurs = await skillChildStillIs(
                rootHandle,
                newName,
                destination.identity,
              );
              // Takes back only what this call placed, and only while the
              // destination is still the reservation: anything a hand author
              // added under it stays, and stays reachable.
              if (stillOurs) {
                await removeAssembledSkill(
                  rootHandle,
                  newName,
                  destination.identity,
                  undoable,
                  ctx.blobId,
                );
              }
              if (!stillOurs) {
                // The name belongs to somebody else now, so it is not this
                // mutation's to remove, and the raw errno from writing into an
                // unlinked directory explains none of that.
                throw changedSinceScan(
                  newName,
                  "was taken over by another entry while the skill was being renamed",
                );
              }
              if (error instanceof SkillNameTakenError) {
                // A create-or-fail call refused: something already holds a name
                // the rename needed. That is the contract working, so it should
                // read as a refusal and not as a raw filesystem error.
                throw new SkillValidationError(
                  `Renaming "${name}" to "${newName}" would have had to overwrite something that already exists there (${error.message}); nothing was changed. Resolve it by hand in the library and retry.`,
                );
              }
              throw error;
            }
            return true;
          },
        );
        if (performed === null) {
          throw new SkillValidationError(
            `The library already contains a top-level entry named "${newName}"; a rename may not overwrite it.`,
          );
        }
      });
      return {
        before,
        name: newName,
        folder: newName,
        extra: { previousName: name },
      };
    },
    options,
  );
  return { ...outcome, previousName: outcome.extra.previousName };
}

/** Delete one whole skill folder resolved from its current declared name. */
export async function deleteSkill(
  input: { name: string },
  meta: SkillCommitMeta,
  library: SkillLibraryStore = skillLibraryStore,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome> {
  const name = assertSafeSkillName(input.name);
  return runMutation(
    library,
    { ...meta, skillNames: [name] },
    async (ctx) => {
      // The pre-write scan reads every folder in the library, so it takes
      // the checkpoint too: nothing has happened yet, and a caller who
      // stopped should not have to wait out somebody's thousand folders.
      const before = await scanSkillLibrary(ctx.root, {
        checkpoint: ctx.checkpoint,
      });
      const target = resolveSkill(before, name);
      const identity = scannedIdentity(before, target);
      ctx.touch(target.folder);
      await withLibraryRoot(ctx.root, async (rootHandle) => {
        // Deleting under the PUBLIC name would unlink each child by a name that
        // is re-resolved after the listing, so a file a hand edit wrote in that
        // instant would be removed instead of the one that was seen. The one
        // removal primitive moves the folder out of reach first and identifies it
        // there, so everything below happens under a name nothing else addresses.
        //
        // What it identifies the folder AS is pinned, not remembered: the scan's
        // numbers would also fit a folder a hand author removed and recreated
        // here, and deleting that would destroy a skill this tool never read.
        const source = await withVerifiedSkillFolder(
          rootHandle,
          target,
          identity,
          (folder) => pinSkillSource(ctx, folder, target),
        );
        // One Git call for the whole expectation, not one per file, and a folder
        // bigger than this tool removes in a commit is refused BEFORE anything is
        // detached: the same ceiling a rename places under.
        const committed = await ctx.committedFiles(
          target.folder,
          maxPlacedEntries,
        );
        if (committed === undefined) {
          throw new SkillValidationError(
            `"${target.folder}" holds more than ${maxPlacedEntries} committed files, which is more than this tool removes in one commit. Remove the folder by hand, or split the skill.`,
          );
        }
        // Nothing has moved yet, so a stop here is free; the call below detaches
        // the folder.
        ctx.checkpoint();
        // The tree that goes must still hold the very manifest that was read,
        // which no recreated folder can — and every other file in it must be one
        // the repository has COMMITTED, with the content it committed. A delete
        // is a request to remove a skill, not licence to remove whatever else has
        // appeared in its folder since.
        const proof = cancellableExpectation(async (tree) => {
          if (
            !sameFileIdentity(
              (await skillChildIdentity(tree, SKILL_FILE_NAME)) ??
                MISSING_ENTRY,
              source.manifest,
            )
          ) {
            return { holds: false };
          }
          const contents = await treeHoldsCommitted(tree, ctx, committed, {
            entries: maxPlacedEntries,
            depth: MAX_REMOVED_DEPTH,
          });
          // Hashing every committed file is the long part of a delete and it is
          // cancellable throughout; the emptying that follows this answer is not.
          if (contents.holds) ctx.beyondCancellation();
          return contents;
        });
        const removal = await removeVerifiedSkillTree(
          rootHandle,
          target.folder,
          source.folder,
          proof.expectation,
        );
        proof.rethrow();
        if (removal !== "removed") {
          if (removal === "partial") ctx.damaged(target.folder);
          throw changedSinceScan(
            target.folder,
            removal === "partial"
              ? "could only be partly removed"
              : "was replaced while it was being deleted",
          );
        }
        // The folder is gone, so a later staging or commit failure has to be able
        // to bring it back from HEAD — while nothing else has taken the name.
        ctx.removed(target.folder);
      });
      return { before, name: undefined, folder: target.folder };
    },
    options,
  );
}

interface MutationPlan<E extends Record<string, unknown>> {
  before: SkillLibraryScan;
  /** The declared name that must be valid afterwards; absent for a deletion. */
  name: string | undefined;
  folder: string;
  extra?: E;
}

/**
 * Run one mutation under the store's repository lock and publish the library
 * exactly once after a successful commit.
 *
 * The post-write scan is the acceptance test: the target must be valid (or, for
 * a deletion, gone) and no diagnostic may appear that the pre-write scan did
 * not already report. Pre-existing unrelated problems stay visible and
 * uncommitted — this mutation neither repairs nor inherits them.
 */
async function runMutation<E extends Record<string, unknown>>(
  library: SkillLibraryStore,
  meta: SkillCommitMeta,
  apply: (ctx: SkillMutationContext) => Promise<MutationPlan<E>>,
  options: SkillMutationOptions = {},
): Promise<SkillMutationOutcome & { extra: E }> {
  const { value, commit, status } = await library.commitMutation(
    meta,
    async (ctx) => {
      const plan = await apply(ctx);
      const after = await scanSkillLibrary(ctx.root);
      assertNoNewDiagnostics(plan.before, after, plan.folder);
      const summary =
        plan.name === undefined
          ? undefined
          : after.skills.find((skill) => skill.name === plan.name);
      if (plan.name !== undefined && !summary) {
        throw new SkillValidationError(
          `After writing, the library does not report "${plan.name}" as a valid skill; the change was rolled back.`,
        );
      }
      if (plan.name === undefined) {
        const lingering = after.skills.find(
          (skill) => skill.path.split("/")[0] === plan.folder,
        );
        if (lingering) {
          throw new SkillValidationError(
            `Folder "${plan.folder}" is still present after the deletion; the change was rolled back.`,
          );
        }
      }
      return {
        summary,
        folder: plan.folder,
        extra: (plan.extra ?? {}) as E,
      };
    },
    {
      // The publish rescans, so it runs while the repository lock is STILL
      // held: released first, it could scan the NEXT serialized mutation's
      // half-written files and broadcast that as this mutation's result. Its
      // own failure is not this mutation's — the commit is already made.
      afterCommit: () => publishSkillLibrary(library),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return {
    ...(value.summary ? { skill: value.summary } : {}),
    folder: value.folder,
    commit,
    status,
    extra: value.extra,
  };
}

function targetOf(summary: SkillSummary): ResolvedSkill {
  return {
    name: summary.name,
    description: summary.description,
    folder: summary.path.split("/")[0]!,
    path: summary.path,
  };
}

/** Resolve a declared name against a scan, or explain why it cannot be used. */
function resolveSkill(scan: SkillLibraryScan, name: string): ResolvedSkill {
  const summary = scan.skills.find((skill) => skill.name === name);
  if (summary) return targetOf(summary);
  const diagnostic = scan.diagnostics.find(
    (entry) => entry.declaredName === name,
  );
  if (diagnostic) {
    throw new SkillValidationError(
      `Skill "${name}" is not currently valid, so it cannot be changed: ${diagnostic.error} Fix the folder in the library first.`,
    );
  }
  throw new SkillValidationError(
    `No valid skill declares the name "${name}". List the library to see the declared names it currently has.`,
  );
}

function assertNameIsFree(scan: SkillLibraryScan, name: string): void {
  const declared =
    scan.skills.some((skill) => skill.name === name) ||
    scan.diagnostics.some((entry) => entry.declaredName === name);
  if (declared) {
    throw new SkillValidationError(
      `The library already declares the name "${name}"; two folders declaring one name make both ambiguous.`,
    );
  }
}

function assertNoNewDiagnostics(
  before: SkillLibraryScan,
  after: SkillLibraryScan,
  folder: string,
): void {
  const known = new Set(before.diagnostics.map(diagnosticKey));
  const added = after.diagnostics.filter(
    (diagnostic) => !known.has(diagnosticKey(diagnostic)),
  );
  if (added.length === 0) return;
  throw new SkillValidationError(
    `The change would introduce ${added.length} new library problem(s) beyond folder "${folder}", so it was rolled back: ${added
      .map((diagnostic) => `${diagnostic.path}: ${diagnostic.error}`)
      .join(" ")}`,
  );
}

function diagnosticKey(diagnostic: SkillDiagnostic): string {
  return `${diagnostic.code} ${diagnostic.path}`;
}

/**
 * One validated operation, ready to apply.
 *
 * An `edit` is the one shape that carries no bytes: what it will write exists
 * only once the file it patches has been read, under the repository lock.
 */
type PlannedFileOperation =
  | {
      op: "write" | "import" | "delete";
      path: string;
      bytes: Uint8Array;
      attachmentId?: string;
    }
  | { op: "edit"; path: string; edits: { oldText: string; newText: string }[] };

async function planFileOperations(
  operations: SkillFileOperation[],
): Promise<PlannedFileOperation[]> {
  if (operations.length === 0)
    throw new SkillValidationError("At least one file operation is required.");
  if (operations.length > MAX_SKILL_FILE_OPERATIONS) {
    throw new SkillValidationError(
      `At most ${MAX_SKILL_FILE_OPERATIONS} file operations may share one batch; split the change.`,
    );
  }
  const planned: PlannedFileOperation[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const operation of operations) {
    const path = normalizeSupportingFilePath(operation.path);
    if (seen.has(path))
      throw new SkillValidationError(
        `Path "${path}" appears twice in one batch.`,
      );
    seen.add(path);
    if (operation.op === "delete") {
      planned.push({ op: "delete", path, bytes: new Uint8Array() });
      continue;
    }
    if (operation.op === "edit") {
      if (operation.edits.length === 0) {
        throw new SkillValidationError(
          `Operation "edit" on "${path}" needs at least one edit.`,
        );
      }
      // No byte budget is spent here: an edit's result is only known once the
      // file has been read, and the read itself is bounded per file at
      // MAX_SKILL_TEXT_FILE_BYTES, which caps a whole batch of them well below
      // MAX_SKILL_BATCH_BYTES.
      planned.push({ op: "edit", path, edits: operation.edits });
      continue;
    }
    const limit =
      operation.op === "write"
        ? MAX_SKILL_TEXT_FILE_BYTES
        : MAX_SKILL_IMPORT_BYTES;
    // The size is known before the bytes are, for an import, so BOTH budgets
    // are spent on the recorded size first. Reading twenty valid attachments
    // and then refusing their total is how a batch that can never be applied
    // still costs the process every one of their bytes.
    const declared =
      operation.op === "write"
        ? Buffer.byteLength(operation.content, "utf8")
        : operation.size;
    if (declared > limit) {
      throw new SkillValidationError(
        `"${path}" is ${declared} bytes, above the ${limit}-byte limit for this operation.`,
      );
    }
    if (totalBytes + declared > MAX_SKILL_BATCH_BYTES) {
      throw new SkillValidationError(
        `One batch may write at most ${MAX_SKILL_BATCH_BYTES} bytes in total.`,
      );
    }
    const bytes =
      operation.op === "write"
        ? encode(operation.content)
        : // Bounded at the limit even now: the file may have grown since it was
          // recorded, and a read that ignored that would undo the check above.
          await operation.read(limit);
    if (bytes.byteLength > limit) {
      throw new SkillValidationError(
        `"${path}" is larger than the ${limit}-byte limit for this operation.`,
      );
    }
    if (operation.op === "import" && bytes.byteLength !== declared) {
      // The budgets above were spent on the RECORDED size, so anything else
      // arriving means the attachment changed after it was resolved. Importing
      // it anyway would commit a prefix of a file nobody asked for.
      throw new SkillValidationError(
        `Attachment "${operation.attachmentId}" changed while it was being imported to "${path}" (${declared} bytes recorded, ${bytes.byteLength} read). Retry the import.`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SKILL_BATCH_BYTES) {
      throw new SkillValidationError(
        `One batch may write at most ${MAX_SKILL_BATCH_BYTES} bytes in total.`,
      );
    }
    planned.push({
      op: operation.op,
      path,
      bytes,
      ...(operation.op === "import"
        ? { attachmentId: operation.attachmentId }
        : {}),
    });
  }
  return planned;
}

/**
 * The one strict skill-relative path rule for authoring: no absolute or drive
 * path, no traversal or empty component, no backslash or NUL, bounded length —
 * and never `SKILL.md`, which has its own create/edit tools and its own
 * validation.
 */
function normalizeSupportingFilePath(input: string): string {
  if (
    !input ||
    input !== input.trim() ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    /^[a-zA-Z]:/.test(input) ||
    Buffer.byteLength(input, "utf8") > MAX_SKILL_RELATIVE_PATH_BYTES
  ) {
    throw new SkillValidationError(`Invalid skill-relative path: "${input}".`);
  }
  const components = input.split("/");
  if (
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        component.toLowerCase() === ".git",
    )
  ) {
    throw new SkillValidationError(`Invalid skill-relative path: "${input}".`);
  }
  const path = components.join("/");
  if (path === SKILL_FILE_NAME) {
    throw new SkillValidationError(
      `${SKILL_FILE_NAME} is the skill manifest; create or edit it with the skill create/edit tools instead.`,
    );
  }
  return path;
}

/** Library-relative scope for a history or diff read; never resolved or opened. */
export function normalizeLibraryPath(input: string): string {
  if (
    !input ||
    input !== input.trim() ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    /^[a-zA-Z]:/.test(input) ||
    Buffer.byteLength(input, "utf8") > MAX_SKILL_RELATIVE_PATH_BYTES
  ) {
    throw new SkillValidationError(
      `Invalid library-relative path: "${input}".`,
    );
  }
  const components = input.split("/");
  if (
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        component.startsWith("."),
    )
  ) {
    throw new SkillValidationError(
      `Invalid library-relative path: "${input}".`,
    );
  }
  return components.join("/");
}

/** Exact, unique, non-overlapping replacements against source already read. */
function applyExactReplacements(
  content: string,
  edits: { oldText: string; newText: string }[],
  path: string,
): { content: string; replacements: number } {
  const regions: { start: number; end: number; newText: string }[] = [];
  for (const edit of edits) {
    if (!edit.oldText)
      throw new SkillValidationError("Every edit needs a non-empty oldText.");
    const first = content.indexOf(edit.oldText);
    if (first < 0)
      throw new SkillValidationError(
        `oldText not found in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}. Read the skill again and copy the exact current text.`,
      );
    const second = content.indexOf(edit.oldText, first + edit.oldText.length);
    if (second >= 0)
      throw new SkillValidationError(
        `oldText is not unique in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}. Include more surrounding text.`,
      );
    regions.push({
      start: first,
      end: first + edit.oldText.length,
      newText: edit.newText,
    });
  }
  regions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index++) {
    if (regions[index]!.start < regions[index - 1]!.end)
      throw new SkillValidationError("Edits must not overlap.");
  }
  let next = "";
  let cursor = 0;
  for (const region of regions) {
    next += content.slice(cursor, region.start) + region.newText;
    cursor = region.end;
  }
  next += content.slice(cursor);
  if (next === content)
    throw new SkillValidationError(
      `The edits leave ${path} unchanged; there is nothing to commit.`,
    );
  return { content: next, replacements: regions.length };
}

/**
 * One entry a rename placed at the new name, and how to recognise it again.
 *
 * A file (or symlink) is recorded by INODE, which a hard link makes exact: the
 * name at the destination and the name at the source are the same object, so
 * "is this still mine?" is answered by comparison rather than by trust. A
 * directory is recorded by its children, because an empty directory can only be
 * removed with `rmdir`, which refuses to take anything with content in it.
 */
type PlacedEntry =
  | {
      kind: "file";
      name: string;
      identity: { dev: number; ino: number };
      /** What must still be there for an undo to take this entry back. */
      content: PlacedContent;
    }
  | {
      kind: "directory";
      name: string;
      /** The directory at the OLD name, which the source cleanup removes. */
      sourceIdentity: { dev: number; ino: number };
      /** The directory this call created at the NEW name, which an undo removes. */
      destinationIdentity: { dev: number; ino: number };
      children: PlacedEntry[];
    };

/**
 * Take a pin this mutation just made and keep it for the whole commit attempt.
 *
 * Everything a mutation creates is pinned, and every pin outlives the
 * mutation's own scope, because the undo that may have to recognise it runs
 * after the commit was refused. The store closes them all once the attempt has
 * settled; nothing here closes one early, and nothing records an identity it
 * has not pinned.
 */
async function pin(
  ctx: SkillMutationContext,
  pending: Promise<SkillPin>,
): Promise<SkillPin> {
  const taken = await pending;
  ctx.hold(taken.handle);
  return taken;
}

type PinKeeper = (create: () => Promise<SkillPin>) => Promise<SkillPin>;

/**
 * How many entries one rename may place.
 *
 * Each placed entry costs one held descriptor until the commit settles, and a
 * mutation that could exhaust the process's descriptors to move a folder would
 * be a worse failure than the refusal. The alternative — placing entries this
 * mutation cannot pin — is not on the table: an unpinned identity is exactly
 * what makes an undo delete somebody else's file.
 */
const MAX_PLACED_ENTRIES = 512;
let maxPlacedEntries = MAX_PLACED_ENTRIES;

/** Test seam: a smaller ceiling, so a test need not build a 512-entry folder. */
export function setMaxPlacedEntriesForTests(value: number | null): void {
  maxPlacedEntries = value ?? MAX_PLACED_ENTRIES;
}

/** A keeper that refuses to place more than a rename can hold pinned. */
function pinKeeper(ctx: SkillMutationContext, folder: string): PinKeeper {
  let held = 0;
  return async (create) => {
    if (held >= maxPlacedEntries) {
      // Refused BEFORE the create-or-fail call runs, so nothing is placed that
      // this mutation could not take back again.
      throw new SkillValidationError(
        `"${folder}" holds more than ${maxPlacedEntries} files and directories, which is more than this tool renames in one commit. Move the folder by hand, or split the skill.`,
      );
    }
    held += 1;
    return pin(ctx, create());
  };
}

/**
 * Copy one skill folder's children to another open directory using only
 * create-or-fail calls: `mkdir` for a directory, `link` for everything else.
 * `SKILL.md` is deliberately skipped — a rename rewrites it.
 */
async function placeSkillChildren(
  source: FileHandle,
  destination: FileHandle,
  placed: PlacedEntry[],
  keep: PinKeeper,
  /** Where these children come FROM, so each one's committed object is known. */
  sourcePrefix: string,
  committedObject: (path: string) => Promise<string | undefined>,
): Promise<void> {
  // Lazily, because the ceiling below is a bound on this READ as much as on the
  // descriptors: a hand-authored folder with a million siblings must not be
  // built into an array before the refusal at entry 513.
  for await (const entry of iterateSkillDirectory(source)) {
    const name = entry.name;
    if (name === SKILL_FILE_NAME) continue;
    if (entry.isDirectory()) {
      // The created directory is pinned by the call that creates it, so the
      // undo can tell it apart from a directory recreated at the same name.
      const created = await keep(() =>
        createSkillChildDirectory(destination, name),
      );
      const children: PlacedEntry[] = [];
      // Both inodes are recorded, because the two removals that follow are of
      // two different directories: the source cleanup removes the old one, an
      // undo removes the one this call just created.
      await withSkillChild(source, name, async (sourceChild) => {
        placed.push({
          kind: "directory",
          name,
          sourceIdentity: await skillHandleIdentity(sourceChild.handle),
          destinationIdentity: created.identity,
          children,
        });
        await withSkillChild(destination, name, (destinationChild) =>
          placeSkillChildren(
            sourceChild.handle,
            destinationChild.handle,
            children,
            keep,
            `${sourcePrefix}/${name}`,
            committedObject,
          ),
        );
      });
      continue;
    }
    const identity = await skillChildIdentity(source, name);
    if (!identity) {
      throw changedSinceScan(name, "disappeared while the skill was copied");
    }
    // The link makes the new name the same inode, and the pin keeps that inode
    // from ever being handed to anything else — which is what an undo, running
    // long after the source link is gone, has to be able to rely on. The
    // recorded identity is the PIN's, so everything downstream compares against
    // an inode this call holds rather than one it once looked at.
    const linked = await keep(() => linkSkillChild(source, name, destination));
    // A symlink's target cannot change without the inode changing with it, so
    // only a regular file needs its content state remembered.
    placed.push({
      kind: "file",
      name,
      identity: linked.identity,
      // What HEAD has at the old path is what this link holds: the tree was
      // clean when the mutation started, which is what makes those the same
      // bytes, and it is fixed before anything could rewrite them.
      content: await placedContent(
        entry,
        `${sourcePrefix}/${name}`,
        committedObject,
      ),
    });
  }
}

/**
 * Whether an open tree holds EXACTLY the entries recorded, and nothing else.
 *
 * The file comparison is by inode, which is conclusive here because every one
 * of them is pinned by its hard link at the other name. An extra entry — a file
 * a hand edit added while the rename ran — makes this false, which is what
 * turns "remove the old folder" into a refusal rather than a loss.
 */
async function treeHoldsExactly(
  tree: FileHandle,
  expected: PlacedEntry[],
  blobId: BlobId,
  /** Where each proof lands, by path relative to the tree being checked. */
  provedAt: Map<string, bigint> = new Map(),
  prefix = "",
): Promise<SkillTreeContents> {
  // Read lazily and stopped at the first surprise, so a tree somebody has piled
  // entries into costs this check a bounded read rather than all of them.
  const present: Dirent[] = [];
  for await (const child of iterateSkillDirectory(tree)) {
    if (present.length === expected.length) return { holds: false };
    present.push(child);
  }
  if (present.length !== expected.length) return { holds: false };
  const byName = new Map(expected.map((entry) => [entry.name, entry]));
  for (const child of present) {
    const entry = byName.get(child.name);
    if (!entry) return { holds: false };
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (entry.kind === "file") {
      const identity = await skillChildIdentity(tree, child.name);
      if (
        !identity ||
        identity.dev !== entry.identity.dev ||
        identity.ino !== entry.identity.ino
      ) {
        return { holds: false };
      }
      // And the CONTENT, because this answer decides whether a tree is deleted:
      // an inode survives a rewrite through it, so a hand author's edit made
      // after this mutation read the file matches every identity here and would
      // go with the tree. The tree is already detached under a private name by
      // the time this runs, so what is read here is what would be removed —
      // and the `ctime` the proof came with is carried out, because this walk
      // and the one that removes are not the same walk.
      const proof = await holdsPlacedContent(
        tree,
        child.name,
        entry.content,
        blobId,
      );
      if (proof === undefined) return { holds: false };
      provedAt.set(relative, proof);
      continue;
    }
    if (!child.isDirectory()) return { holds: false };
    const matches = await withSkillChild(tree, child.name, async (handle) => {
      if (!handle.directory) return false;
      const identity = await skillHandleIdentity(handle.handle);
      if (
        identity.dev !== entry.sourceIdentity.dev ||
        identity.ino !== entry.sourceIdentity.ino
      ) {
        // The destination copy is the other side of the same record.
        if (
          identity.dev !== entry.destinationIdentity.dev ||
          identity.ino !== entry.destinationIdentity.ino
        ) {
          return false;
        }
      }
      const nested = await treeHoldsExactly(
        handle.handle,
        entry.children,
        blobId,
        provedAt,
        relative,
      );
      return nested.holds;
    }).catch(notCancelled(false));
    if (!matches) return { holds: false };
  }
  // The directory's own reading, taken AFTER its children were proved, so it
  // covers anything appearing in it from here on: creating an entry moves a
  // directory's `ctime`, and a hand author holding this directory open from
  // before it was detached can still create in it. Recorded for the removal
  // walk, which reads it again before it lists anything.
  const changed = await directoryChangedAt(tree);
  if (changed === undefined) return { holds: false };
  provedAt.set(prefix, changed);
  return { holds: true, provedAt };
}

/**
 * Take back exactly what a mutation assembled under a top-level name.
 *
 * Entry by entry rather than tree by tree, because by the time an undo runs a
 * hand author may have added a file under the assembled name, and that file is
 * not this mutation's to delete. The folder is moved to a private name first,
 * so every removal below happens inside a tree nothing else can address by
 * name; a file goes only while it is still the inode this call linked, a
 * directory only once it is empty. If anything is left over the folder is
 * reassembled at its public name, now holding only what that author wrote —
 * which the next scan reports instead of the undo having destroyed it.
 */
async function removeAssembledSkill(
  rootHandle: FileHandle,
  folder: string,
  folderIdentity: { dev: number; ino: number },
  assembled: PlacedEntry[],
  blobId: BlobId,
): Promise<void> {
  await removeVerifiedSkillTree(
    rootHandle,
    folder,
    folderIdentity,
    async (tree) => {
      // Each entry here was already taken back one at a time, each with its own
      // content check next to its own unlink, so what is left to say is only
      // whether anything remains.
      await removeAssembledEntries(tree, assembled, blobId);
      return { holds: await treeIsEmpty(tree) };
    },
  );
}

/**
 * Let a removal's expectation be CANCELLED without stranding the tree.
 *
 * A removal detaches the folder to a private name before it proves anything, so
 * the proof — the one part of a delete or a rename that can hash gigabytes of
 * somebody's supporting files — runs while the skill is reachable under no
 * public name at all. Throwing out of it would skip the reassembly that puts the
 * folder back. So a cancellation is turned into the answer the removal already
 * knows how to handle ("this tree does not hold what you expected"), which
 * restores it at its public name, and is re-thrown afterwards as the mutation's
 * failure — the caller's stop, not a phantom conflict.
 */
/**
 * Swallow a failed check, but never a CANCELLATION.
 *
 * The walks below turn every error into "this is not what I expected" on
 * purpose: an entry that cannot be opened or read is exactly an entry this
 * mutation may not remove. A stop is not that. Reported as an unmet expectation
 * it would surface as a phantom conflict — "the folder gained content" — over a
 * folder nobody touched, and worse, it would be reported to the caller as the
 * reason their skill was not deleted. So it passes straight through.
 */
function notCancelled<T>(fallback: T): (error: unknown) => T {
  return (error: unknown) => {
    if (error instanceof SkillMutationCancelledError) throw error;
    return fallback;
  };
}

function cancellableExpectation(
  expectation: (tree: FileHandle) => Promise<SkillTreeContents>,
): {
  expectation: (tree: FileHandle) => Promise<SkillTreeContents>;
  /** Throws the cancellation, if one was taken, after the tree is back. */
  rethrow: () => void;
} {
  let cancelled: SkillMutationCancelledError | undefined;
  return {
    expectation: async (tree) => {
      try {
        return await expectation(tree);
      } catch (error) {
        if (!(error instanceof SkillMutationCancelledError)) throw error;
        cancelled = error;
        return { holds: false };
      }
    },
    rethrow: () => {
      if (cancelled) throw cancelled;
    },
  };
}

/**
 * Whether every file in a detached tree is one the repository has COMMITTED,
 * with the content it committed — and what each of them read at the moment that
 * was proved.
 *
 * The expectation a delete removes against. It has no placement to compare with
 * (nothing was moved anywhere), so the repository's own record is the only
 * account of what belonged to the skill, and the clean-tree precondition is
 * what makes it the account of what is on disk. Anything else present — a file
 * a hand author added, or one whose bytes they changed — is not this delete's
 * to take, and refuses it.
 */
async function treeHoldsCommitted(
  tree: FileHandle,
  ctx: SkillMutationContext,
  /** What the repository committed under the folder, read once. */
  committed: ReadonlyMap<string, SkillCommittedEntry>,
  /** What is left of the walk's budget, shared by every level. */
  budget: { entries: number; depth: number },
  provedAt: Map<string, bigint> = new Map(),
  prefix = "",
): Promise<SkillTreeContents> {
  if (budget.depth <= 0) return { holds: false };
  // Lazily, and against a shared budget: a delete may not be made unbounded by
  // the size of the folder it is asked to remove, and a walk that would exceed
  // what this tool removes in one commit refuses instead of running on.
  for await (const child of iterateSkillDirectory(tree)) {
    if (budget.entries <= 0) return { holds: false };
    budget.entries -= 1;
    // Per entry as well as per chunk: a folder of many small files is as long a
    // wait as one large file, and neither has to be sat through.
    ctx.checkpoint();
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) {
      // A path the repository committed as a FILE is not a directory, whatever
      // stands there now: something replaced it, and replacing is a change this
      // delete did not make.
      if (committed.has(relative)) return { holds: false };
      budget.depth -= 1;
      const nested = await withSkillChild(tree, child.name, async (handle) =>
        handle.directory
          ? (
              await treeHoldsCommitted(
                handle.handle,
                ctx,
                committed,
                budget,
                provedAt,
                relative,
              )
            ).holds
          : false,
      ).catch(notCancelled(false));
      budget.depth += 1;
      if (!nested) return { holds: false };
      continue;
    }
    const entry = committed.get(relative);
    if (entry === undefined) return { holds: false };
    const proof = await holdsCommittedEntry(tree, child, entry, ctx);
    if (proof === undefined) return { holds: false };
    provedAt.set(relative, proof);
  }
  const changed = await directoryChangedAt(tree);
  if (changed === undefined) return { holds: false };
  provedAt.set(prefix, changed);
  return { holds: true, provedAt };
}

/** How deep a delete's proof will descend before it refuses. */
const MAX_REMOVED_DEPTH = 32;

/** The Git mode of a symlink, whose object is the blob of its TARGET. */
const SYMLINK_MODE = "120000";

/**
 * Whether what stands at a committed path is still the WHOLE entry the
 * repository committed there — and the reading that was true while it was
 * proved.
 *
 * A delete has no placement to compare against, so the committed entry is the
 * entire account of what belonged to the skill, and an entry is a mode and an
 * object. Checking only the object accepts three different changes as if they
 * were none: a symlink put where a file was committed (an object id says
 * nothing about what KIND of thing holds it), a committed symlink repointed at
 * something else (its target is its content, and a fresh symlink is a fresh
 * inode), and a `chmod +x` on a committed file (a change Git records, and one
 * this mutation did not make). Each of those is somebody's work standing in the
 * folder, and this returns nothing rather than let it be removed.
 */
async function holdsCommittedEntry(
  directory: FileHandle,
  child: Dirent,
  entry: SkillCommittedEntry,
  ctx: SkillMutationContext,
): Promise<bigint | undefined> {
  if (entry.mode === SYMLINK_MODE) {
    // Committed as a symlink, so it must still BE one, and point where the
    // repository says. A symlink cannot be opened or written through; it can
    // only be replaced, which the bracketed read below is what catches.
    if (!child.isSymbolicLink()) return undefined;
    const link = await readSkillChildLink(directory, child.name);
    if (link === undefined) return undefined;
    return (await ctx.blobId(link.target)) === entry.object
      ? link.changed
      : undefined;
  }
  // Anything else Git can hold at a path — a gitlink, say — is something this
  // tool has no way to prove and therefore no business removing.
  if (entry.mode !== "100644" && entry.mode !== "100755") return undefined;
  // Committed as a regular file: a symlink at the same name is a REPLACEMENT,
  // and following it would read something outside the folder entirely.
  if (child.isSymbolicLink() || child.isDirectory()) return undefined;
  return withSkillChild(directory, child.name, async (file) => {
    if (file.directory) return undefined;
    // One bracket around the whole proof — mode and content alike. Reading the
    // mode outside it would let a `chmod` land between the two and still be
    // recorded as the proved reading, which is exactly what the later recheck
    // would then pass over.
    const before = await file.handle.stat({ bigint: true });
    if (!(await ctx.modeStillCommitted(entry.mode, Number(before.mode)))) {
      return undefined;
    }
    if ((await ctx.blobId(file.handle)) !== entry.object) return undefined;
    const after = await file.handle.stat({ bigint: true });
    return after.ctimeNs === before.ctimeNs ? after.ctimeNs : undefined;
  }).catch(notCancelled(undefined));
}

/** Whether a detached tree holds nothing at all. */
async function treeIsEmpty(tree: FileHandle): Promise<boolean> {
  return (await readSkillDirectory(tree)).length === 0;
}

/**
 * Whether the file at `name` still holds the content a placement recorded.
 *
 * A symlink answers yes on its identity alone — its target cannot change while
 * its inode does not — and an entry with nothing recorded answers NO, because
 * "I cannot prove what this is" may never come out as "so remove it".
 */
async function holdsPlacedContent(
  directory: FileHandle,
  name: string,
  content: PlacedContent,
  blobId: BlobId,
): Promise<bigint | undefined> {
  // A symlink's target cannot change while its inode does not, so its identity
  // is its content; there is nothing for a later recheck to compare, and its
  // `ctime` at this moment is the honest answer.
  if (content.kind === "unproven") return undefined;
  // A symlink is never opened — `O_NOFOLLOW` refuses it and following it would
  // read something else entirely — so its reading comes from `lstat`.
  if (content.kind === "symlink") {
    return skillChildChangedAt(directory, name);
  }
  const expected =
    content.kind === "bytes" ? await blobId(content.bytes) : content.object;
  return withSkillChild(directory, name, async (child) => {
    if (child.directory) return undefined;
    // Bracketed, so the `ctime` handed on is one that held for the whole proof:
    // a write between the hash and the reading would otherwise be recorded as
    // the proved state and let the later recheck pass over it.
    const before = await child.handle.stat({ bigint: true });
    if ((await blobId(child.handle)) !== expected) return undefined;
    const after = await child.handle.stat({ bigint: true });
    return after.ctimeNs === before.ctimeNs ? after.ctimeNs : undefined;
  }).catch(notCancelled(undefined));
}

/**
 * How to check one placed file before taking it back, or `leave-it` when this
 * mutation cannot prove what is there is its own — in which case nothing is
 * removed and the leftover is reported by the post-rollback status check.
 */
function contentCheck(
  content: PlacedContent,
  blobId: BlobId,
): ((handle: FileHandle) => Promise<boolean>) | undefined | "leave-it" {
  switch (content.kind) {
    case "bytes":
      return async (handle) =>
        (await blobId(handle)) === (await blobId(content.bytes));
    case "committed":
      return async (handle) => (await blobId(handle)) === content.object;
    case "symlink":
      // Its target IS its content, and neither can change while the inode does
      // not, so the identity comparison already answers for it.
      return undefined;
    case "unproven":
      return "leave-it";
  }
}

async function removeAssembledEntries(
  directory: FileHandle,
  entries: PlacedEntry[],
  blobId: BlobId,
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "file") {
      // Content, not metadata, and never an inode on its own: the entry goes
      // only while it still holds what this mutation put there. A rewrite
      // through the same inode — even one that keeps the size and puts the
      // mtime back — is then somebody else's file, and stays.
      const holds = contentCheck(entry.content, blobId);
      if (holds !== "leave-it") {
        await unlinkSkillChildIfSame(
          directory,
          entry.name,
          entry.identity,
          holds,
        ).catch(() => false);
      }
      continue;
    }
    const emptied = await withSkillChild(
      directory,
      entry.name,
      async (child) => {
        if (!child.directory) return false;
        const identity = await skillHandleIdentity(child.handle);
        if (
          identity.dev !== entry.destinationIdentity.dev ||
          identity.ino !== entry.destinationIdentity.ino
        ) {
          // Something replaced the directory this call made; it is not ours.
          return false;
        }
        await removeAssembledEntries(child.handle, entry.children, blobId);
        return true;
      },
    ).catch(() => false);
    if (emptied) {
      await rmdirSkillChild(directory, entry.name).catch(() => undefined);
    }
  }
}

/**
 * What the undo will need to recognise one placed entry again.
 *
 * A symlink says so explicitly: its target cannot change without the inode
 * changing with it, so the pinned identity already answers for its content. A
 * regular file gets the object the repository has committed for it, which is
 * the only thing an in-place rewrite cannot leave intact — and if there is no
 * committed object (which a clean tree makes impossible) it is UNPROVEN, so the
 * undo leaves it alone instead of falling back to trusting an inode.
 */
async function placedContent(
  entry: Dirent,
  sourcePath: string,
  committedObject: (path: string) => Promise<string | undefined>,
): Promise<PlacedContent> {
  if (entry.isSymbolicLink()) return { kind: "symlink" };
  const object = await committedObject(sourcePath);
  return object === undefined
    ? { kind: "unproven" }
    : { kind: "committed", object };
}

/** Claim each file a placement made, by its full library-relative path. */
function claimPlacedFiles(
  ctx: SkillMutationContext,
  prefix: string,
  source: string,
  entries: PlacedEntry[],
): void {
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    const from = `${source}/${entry.name}`;
    if (entry.kind === "file") {
      // By CONTENT, not by the inode it was linked from: a hard link keeps its
      // inode number through a truncate-and-rewrite, so an identity says only
      // that the name still resolves to the same file — never that the file
      // still holds what this rename moved. What was committed at the old path
      // is what the new one has to hold, and the clean-tree precondition is
      // what makes those the same thing.
      ctx.created(path, { movedFrom: from });
      continue;
    }
    claimPlacedFiles(ctx, path, from, entry.children);
  }
}

/**
 * How one placed file's CONTENT is recognised again when an undo comes for it.
 *
 * An inode number is not an answer: it survives a truncate-and-rewrite, so
 * "still the entry I placed" says nothing about what is inside it. Every
 * variant here therefore says what the bytes must be, or says explicitly why no
 * comparison is needed — which is exactly the distinction a single optional
 * field could not make, and the reason a freshly written manifest was taken
 * back on the strength of its inode alone.
 */
/** Hashing one content as a Git blob, in this repository's own algorithm. */
type BlobId = (content: Uint8Array | FileHandle) => Promise<string>;

type PlacedContent =
  /** Written by this mutation: it must still hash to these bytes. */
  | { kind: "bytes"; bytes: Uint8Array }
  /** Moved by this mutation: it must still be what HEAD has at the old path. */
  | { kind: "committed"; object: string }
  /** A symlink: its target cannot change without the inode changing with it. */
  | { kind: "symlink" }
  /** Nothing to compare against, so nothing may be removed either. */
  | { kind: "unproven" };

/** What a batch brought into existence, and therefore how it is taken back. */
type CreatedKind = "file" | "directory";

/** The scanned source, held open, with the identities a removal may trust. */
interface PinnedSkillSource {
  folder: { dev: number; ino: number };
  manifest: { dev: number; ino: number };
  /** The manifest source read through the pinned handle. */
  text: string;
}

/**
 * PIN the source a destructive step is about to act on, and prove through those
 * pins that it is still the skill the caller named.
 *
 * A scan's `dev`/`ino` is a number written down and let go of. By the time a
 * delete or a rename removes the folder, an inode number the scan recorded fits
 * a folder somebody removed and recreated exactly as well as the one that was
 * scanned — the kernel hands a freed number straight back. So the destruction
 * is bound to descriptors this call holds instead: the folder it opened, and
 * the `SKILL.md` inside it, whose bytes it also READ through that same handle
 * and which must still declare the skill the caller asked for. A folder that
 * was swapped for something else therefore fails the manifest check whatever
 * the numbers say, and the one case that passes — a folder recreated as the
 * same skill — is the skill the caller named.
 */
async function pinSkillSource(
  ctx: SkillMutationContext,
  folder: FileHandle,
  target: ResolvedSkill,
): Promise<PinnedSkillSource> {
  const pinnedFolder = await pin(ctx, pinSkillHandle(folder));
  return withSkillChild(folder, SKILL_FILE_NAME, async (child) => {
    if (child.directory) {
      throw new SkillValidationError(`${target.path} is not a regular file.`);
    }
    const read = await readManifestHandle(child.handle, child.size);
    if (read.truncated) {
      throw new SkillValidationError(
        `${target.path} is larger than ${MAX_SKILL_SOURCE_BYTES} bytes, so it cannot be rewritten through this tool.`,
      );
    }
    const manifest = assertSkillManifest(read.source, target.path);
    if (manifest.name !== target.name) {
      throw changedSinceScan(
        target.path,
        `no longer declares "${target.name}"`,
      );
    }
    const pinnedManifest = await pin(ctx, pinSkillHandle(child.handle));
    return {
      folder: pinnedFolder.identity,
      manifest: pinnedManifest.identity,
      text: read.source,
    };
  });
}

/**
 * Remove one entry a batch created, and only while it is still the one it made.
 *
 * Reached through the verified skill folder, so it cannot descend into a folder
 * that replaced the scanned one, and `rmdir` refuses anything with content —
 * which is the whole guarantee: an undo may take back the scaffolding this
 * mutation put up, never something somebody else put inside it.
 */
async function removeCreatedEntry(
  rootHandle: FileHandle,
  target: ResolvedSkill,
  identity: SkillSourceIdentity,
  skillRelativePath: string,
  kind: CreatedKind,
  created: { dev: number; ino: number },
  /** Whether what stands there still holds the content this batch wrote. */
  holdsWritten?: (handle: FileHandle) => Promise<boolean>,
): Promise<void> {
  const components = skillRelativePath.split("/");
  await withVerifiedSkillFolder(
    rootHandle,
    target,
    identity,
    async (folder) => {
      const descend = async (
        directory: FileHandle,
        at: number,
      ): Promise<void> => {
        const name = components[at]!;
        if (at === components.length - 1) {
          if (kind === "file") {
            // Moved aside, identified AND read there before it is unlinked: the
            // file that goes is the one written here, with the bytes written
            // here. An inode survives a rewrite through it, so identity alone
            // would take back a hand author's edit as if it were this batch's.
            await unlinkSkillChildIfSame(
              directory,
              name,
              created,
              holdsWritten,
            );
            return;
          }
          // Detached before it is inspected, and only while the name still
          // resolves to the PINNED directory this batch made: a directory
          // somebody else created here in the meantime keeps the name, and one
          // that has anything in it is put back rather than removed.
          await removeVerifiedSkillTree(
            directory,
            name,
            created,
            // Emptiness is the whole expectation here: this directory was
            // created by the batch, so anything in it was put there by
            // somebody else and keeps it.
            async (tree) => ({ holds: await treeIsEmpty(tree) }),
          );
          return;
        }
        await withSkillChild(directory, name, async (child) => {
          if (!child.directory) return;
          await descend(child.handle, at + 1);
        });
      };
      await descend(folder, 0);
    },
  ).catch(() => undefined);
}

/** Open one skill folder below the library root, refusing links and non-folders. */
async function withSkillFolderHandle<T>(
  rootHandle: FileHandle,
  folder: string,
  use: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  return withSkillChild(rootHandle, folder, async (child) => {
    if (!child.directory)
      throw new SkillValidationError(
        `"${folder}" is not a skill source folder.`,
      );
    return use(child.handle);
  });
}

/**
 * Open the skill folder the SCAN selected, by inode, and hold it for the whole
 * operation.
 *
 * Every write, unlink and recursive removal a mutation performs goes through
 * this handle. The repository lock serializes the app against itself, but the
 * user hand-authors the same working tree, so "a directory is present at this
 * name" is not the same claim as "this is the directory the scan resolved" —
 * only the `dev`/`ino` the scan recorded makes it one.
 */
async function withVerifiedSkillFolder<T>(
  rootHandle: FileHandle,
  target: ResolvedSkill,
  identity: SkillSourceIdentity,
  use: (folder: FileHandle) => Promise<T>,
): Promise<T> {
  return withSkillFolderHandle(rootHandle, target.folder, async (folder) => {
    if (!sameFileIdentity(await skillHandleIdentity(folder), identity.folder)) {
      throw changedSinceScan(
        target.folder,
        "is no longer the folder that was scanned",
      );
    }
    return use(folder);
  });
}

/** The identity a scan recorded for a resolvable skill; never absent for one. */
function scannedIdentity(
  scan: SkillLibraryScan,
  target: ResolvedSkill,
): SkillSourceIdentity {
  const identity = skillSourceIdentity(scan, target.path);
  if (!identity) {
    throw changedSinceScan(target.path, "has no stable source identity");
  }
  return identity;
}

/** An identity nothing can match, for "there is nothing at that name". */
const MISSING_ENTRY = { dev: -1, ino: -1 };

function sameFileIdentity(
  actual: { dev: number; ino: number },
  expected: { dev: number; ino: number },
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function changedSinceScan(path: string, detail: string): SkillValidationError {
  return new SkillValidationError(
    `${path} ${detail} since it was scanned; read the skill again before editing it.`,
  );
}

async function writeRelativeFile(
  folder: FileHandle,
  path: string,
  content: Uint8Array,
  folderName: string,
  onCreated: (
    skillRelativePath: string,
    kind: CreatedKind,
    pinned: SkillPin,
  ) => void,
  onTruncated: () => void,
): Promise<void> {
  const components = path.split("/");
  const descend = async (
    directory: FileHandle,
    at: number,
    prefix: string,
  ): Promise<void> => {
    const name = components[at]!;
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (at === components.length - 1) {
      // A file this batch CREATED is not in HEAD, so no generic restore can
      // take it back: it is undone here or not at all — and only while it is
      // still the inode created, never by name.
      const created = await writeSkillChildFile(
        directory,
        name,
        content,
        onTruncated,
      );
      if (created) onCreated(childPath, "file", created);
      return;
    }
    // `mkdir` distinguishes "I created this" from "it was already here", so the
    // report is a fact rather than a probe that could race, and it comes with
    // the pin that keeps the fact true until the undo may need it.
    const created = await ensureSkillChildDirectory(directory, name);
    if (created) onCreated(childPath, "directory", created);
    await withSkillChild(directory, name, async (child) => {
      if (!child.directory)
        throw new SkillValidationError(`"${name}" is not a directory.`);
      await descend(child.handle, at + 1, childPath);
    });
  };
  try {
    await descend(folder, 0, "");
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    // A symlink or irregular entry standing in the path is the interesting
    // case, and the raw errno would explain none of it.
    throw new SkillValidationError(
      `Cannot write "${folderName}/${path}": the path is not a plain file this tool may create beneath the skill folder (${errorText(error)}).`,
    );
  }
}

/**
 * Rewrite one EXISTING supporting file through exact text replacements.
 *
 * Read and rewrite share one open description, as a `SKILL.md` edit does: the
 * text a replacement matched and the bytes it overwrites then belong to the
 * same inode, not merely to the same name. Nothing here creates a file or a
 * directory — an edit addresses content that is already committed.
 */
async function editRelativeFile(
  folder: FileHandle,
  path: string,
  edits: { oldText: string; newText: string }[],
  folderName: string,
  onTruncated: () => void,
): Promise<{ bytes: Uint8Array; replacements: number }> {
  const fullPath = `${folderName}/${path}`;
  const components = path.split("/");
  const descend = async (
    directory: FileHandle,
    at: number,
  ): Promise<{ bytes: Uint8Array; replacements: number }> => {
    const name = components[at]!;
    if (at < components.length - 1) {
      return withSkillChild(directory, name, async (child) => {
        if (!child.directory)
          throw new SkillValidationError(`"${name}" is not a directory.`);
        return descend(child.handle, at + 1);
      });
    }
    return withSkillChildForUpdate(directory, name, async (file) => {
      if (file.size > MAX_SKILL_TEXT_FILE_BYTES) {
        throw new SkillValidationError(
          `"${fullPath}" is ${file.size} bytes, above the ${MAX_SKILL_TEXT_FILE_BYTES}-byte limit for an edit through this tool; rewrite it with a write operation or edit it by hand in the library.`,
        );
      }
      const current = await readFileBytes(file.handle, file.size);
      if (current.byteLength !== file.size) {
        throw new SkillValidationError(
          `"${fullPath}" changed while it was read; nothing was written.`,
        );
      }
      const source = decodeEditableText(current, fullPath);
      const applied = applyExactReplacements(source, edits, fullPath);
      const written = encode(applied.content);
      if (written.byteLength > MAX_SKILL_TEXT_FILE_BYTES) {
        throw new SkillValidationError(
          `"${fullPath}" would be ${written.byteLength} bytes, above the ${MAX_SKILL_TEXT_FILE_BYTES}-byte limit for one supporting file.`,
        );
      }
      // From here the committed bytes are the only intact copy.
      onTruncated();
      await file.replace(written);
      return { bytes: written, replacements: applied.replacements };
    });
  };
  try {
    return await descend(folder, 0);
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    throw new SkillValidationError(
      `Cannot edit "${fullPath}": it is not a plain existing file beneath the skill folder that this tool may rewrite (${errorText(error)}).`,
    );
  }
}

/** Exactly `size` bytes of an open file, or as many as it still holds. */
async function readFileBytes(
  handle: FileHandle,
  size: number,
): Promise<Uint8Array> {
  const content = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(
      content,
      position,
      size - position,
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  return content.subarray(0, position);
}

/**
 * Decode a file an edit is about to rewrite, refusing anything that is not
 * valid UTF-8.
 *
 * A lossy decode would put replacement characters where bytes an edit never
 * matched used to be, and writing the result back commits them: a text edit on
 * a binary or mis-encoded file has to be refused, not repaired.
 *
 * `ignoreBOM` is what keeps a replacement replacing only what it matched. The
 * default decoder EATS a leading U+FEFF, and the edited string is re-encoded
 * whole, so a BOM-prefixed file would silently lose those three bytes — a
 * change outside every requested region.
 */
function decodeEditableText(content: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      content,
    );
  } catch {
    throw new SkillValidationError(
      `"${path}" is not valid UTF-8 text, so it cannot be edited as text. Replace it with a write operation instead.`,
    );
  }
}

async function deleteRelativeFile(
  folder: FileHandle,
  path: string,
  folderName: string,
): Promise<void> {
  const components = path.split("/");
  const descend = async (directory: FileHandle, at: number): Promise<void> => {
    const name = components[at]!;
    if (at === components.length - 1) {
      await removeSkillChildFile(directory, name);
      return;
    }
    await withSkillChild(directory, name, async (child) => {
      if (!child.directory)
        throw new SkillValidationError(`"${name}" is not a directory.`);
      await descend(child.handle, at + 1);
    });
  };
  try {
    await descend(folder, 0);
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    throw new SkillValidationError(
      `Cannot delete "${folderName}/${path}": it is not a regular file that this tool may remove (${errorText(error)}).`,
    );
  }
}

function assertSourceSize(source: string, path: string): void {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_SKILL_SOURCE_BYTES) {
    throw new SkillValidationError(
      `${path} would be ${bytes} bytes, above the ${MAX_SKILL_SOURCE_BYTES}-byte limit for a skill manifest. Move detail into supporting files.`,
    );
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
