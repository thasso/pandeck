/**
 * Storage seam for the user-owned skills library.
 *
 * Phase 1 made Pandeck a pure reader. It is now a reader AND the one
 * place a `skill_*` tool mutation reaches the repository
 * ([Task-633](pa://task/633), `docs/skills.md`): bootstrap still never authors
 * anything, the user still owns branches, remotes and history, and every scan
 * still reads the working tree — but a deliberate tool call commits here rather
 * than opening a second Git path of its own.
 *
 * The rule that keeps the two owners apart is CLEANLINESS. A mutation refuses
 * to run while the repository holds any tracked, staged or untracked change,
 * so a commit this module makes can only contain what its own tool wrote; the
 * user's in-progress hand edits are never absorbed, described or committed by
 * an agent.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SKILLS_LIBRARY_DIR } from "../config.ts";
import {
  git,
  gitBoundedStdout,
  gitOptional,
  gitOptionalExit,
  repoLockKey,
  withRepoLock,
} from "../gitExec.ts";

const bootstrapLocks = new Map<string, Promise<unknown>>();

/** Compact per-commit metadata; deliberately smaller than `git log` output. */
export interface SkillHistoryEntry {
  commit: string;
  shortCommit: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  trailers: Record<string, string>;
}

/** Who a tool mutation is attributed to; drives author identity and trailers. */
interface SkillCommitActor {
  /** Stable local id, e.g. `claude:developer:<sessionId>`. */
  id: string;
  name: string;
}

/** Provenance recorded on every tool-made commit. */
export interface SkillCommitMeta {
  actor: SkillCommitActor;
  /** Short imperative reason; becomes the commit subject. */
  reason: string;
  sessionId: string;
  taskId?: string;
  /** Declared skill names the mutation touched. */
  skillNames?: string[];
}

/**
 * One bounded history read. `truncated` says the stream or commit-count cap was
 * reached, so OLDER commits than the ones returned exist — a compact read that
 * silently returned fewer commits than asked for would be indistinguishable
 * from a short history.
 */
export interface SkillHistory {
  entries: SkillHistoryEntry[];
  truncated: boolean;
}

export interface SkillCommitResult {
  commit: string;
  shortCommit: string;
  /** Library-relative paths the commit actually changed. */
  changedPaths: string[];
}

/** One uncommitted change standing between the user and a tool mutation. */
interface SkillRepoChange {
  /** Two-letter porcelain status, e.g. ` M`, `??`, `A `. */
  status: string;
  path: string;
}

/** Compact repository state shown beside every list and refusal. */
export interface SkillRepoStatus {
  clean: boolean;
  changeCount: number;
  /** Bounded sample of the changes; the count is authoritative. */
  changes: SkillRepoChange[];
  branch?: string;
  head?: { commit: string; shortCommit: string; subject: string };
}

/** What a mutation may do while it holds the repository lock. */
export interface SkillMutationContext {
  root: string;
  /**
   * Register every library-relative path the mutation may touch, BEFORE
   * touching it. Staging and rollback both use exactly this set, so a path
   * written without being registered would neither be committed nor undone.
   */
  touch(...paths: string[]): void;
  /**
   * Register a path this mutation brought into EXISTENCE, with the proof of
   * what it put there. It is staged, and it is never handed to `git checkout` —
   * HEAD has nothing to restore it to — because taking it back is the
   * mutation's own job through `onRollback`.
   */
  created(path: string, proof: ClaimProof): void;
  /**
   * Register that this mutation is about to TRUNCATE a tracked path: from here
   * on the committed content is the only intact copy, so rollback restores it
   * unconditionally. Followed by {@link wrote} once the new bytes are there.
   */
  damaged(path: string): void;
  /**
   * Register the exact bytes this mutation left at a tracked path.
   *
   * Staging and restoring are not the same claim, and neither is "I wrote here"
   * the same as "what is here is mine". `git checkout HEAD -- <path>` reverts
   * whatever differs from the commit no matter WHO wrote it, so it may only run
   * while the path still holds exactly what this mutation put there. A hook or
   * a hand author who rewrote it afterwards owns those bytes now; reverting
   * them would be a second accident, and the post-rollback status check reports
   * the path instead.
   */
  wrote(path: string, content: Uint8Array): void;
  /**
   * Register that this mutation REMOVED everything at a path. Rollback restores
   * it from HEAD only while the path is still absent: something standing there
   * again was put there by somebody else, and is not this mutation's to revert.
   */
  removed(path: string): void;
  /**
   * Register work that undoes what this mutation CREATED, for a failure that
   * lands after `run` has returned — a refused `git add`, a rejecting
   * `pre-commit` hook.
   *
   * The generic undo cannot do this job. `git clean -fd <path>` removes
   * everything under a name, and by the time it runs that name may also hold
   * something a hand author added; deleting it to tidy up after a failed commit
   * would destroy content this mutation never made. Only the mutation knows
   * what it assembled and can remove exactly that, so it registers the removal
   * here, and the store runs it after the generic path restore has emptied out
   * whatever it can revert.
   */
  onRollback(undo: () => Promise<void>): void;
  /**
   * The object id the repository has COMMITTED at `path`, if it has one.
   *
   * The proof a later undo compares against, and deliberately taken from HEAD
   * rather than from the file: HEAD is fixed before the mutation starts, so
   * nothing that happens while it runs can move it. A mutation runs only on a
   * clean tree, which is what makes the committed object the content its own
   * links point at.
   */
  committedObject(path: string): Promise<string | undefined>;
  /**
   * Every file the repository has COMMITTED under `prefix`, by path relative to
   * it, in ONE Git call — or `undefined` when there are more than `limit`.
   *
   * A whole-tree expectation asked file by file is one process per file, which
   * a directly authored library can make as large as it likes. Asking once
   * bounds the processes at one and the memory at the caller's own limit, and a
   * tree past that limit is refused rather than walked.
   *
   * WHOLE entries, not object ids. A Git entry is a mode and an object, and the
   * mode is what says whether the path is a regular file, an executable one, or
   * a symlink whose object is its TARGET. Keeping only the object throws away
   * everything needed to tell those apart, and an expectation that cannot tell
   * them apart accepts a symlink standing where a file was committed.
   */
  committedFiles(
    prefix: string,
    limit: number,
  ): Promise<ReadonlyMap<string, SkillCommittedEntry> | undefined>;
  /**
   * Whether a file on disk still carries the mode the repository committed for
   * it — asked in GIT's terms, not the kernel's.
   *
   * Git records one bit of a file's mode, owner-execute, and only where the
   * repository tracks modes at all: with `core.fileMode` false a `chmod` is not
   * a change Git can see, `git status` stays clean through one, and refusing
   * over it would refuse every delete in such a repository. Where it IS tracked,
   * a `chmod` after the clean check is a change this mutation did not make, and
   * removing the file would take it along with everything it means.
   */
  modeStillCommitted(committed: string, current: number): Promise<boolean>;
  /**
   * The object id Git would give this content as a blob in this repository —
   * for bytes in hand, or for whatever an open descriptor holds. The one way to
   * ask "is this still the same CONTENT?" in the same terms the index answers.
   */
  blobId(content: Uint8Array | FileHandle): Promise<string>;
  /**
   * Keep one open descriptor alive until the commit attempt has SETTLED, then
   * close it. The store closes every held descriptor after any `onRollback`
   * undo has run and before it re-reads the repository status.
   *
   * This is what makes an undo's ownership claims true. An undo runs long after
   * the mutation's own scope has closed, and an inode number it merely recorded
   * is worthless by then: the kernel hands a freed number straight back to the
   * next entry created, so an entry a hand author put at the same name compares
   * EQUAL to the one this mutation made. While a descriptor is held, the inode
   * cannot be freed and no replacement can be given its number — so a mutation
   * holds a pin on everything it creates, for exactly as long as its undo might
   * need to recognise it.
   */
  hold(handle: { close: () => Promise<unknown> }): void;
  /**
   * Give up a path this mutation registered: it turned out not to be the entry
   * this mutation created, so neither staging nor rollback may act on it. The
   * caller has proven that with an identity it PINNED (an open descriptor), not
   * with a bare `stat`, whose inode number a recreated directory reuses.
   */
  disown(path: string): void;
  /**
   * Stop HERE if the caller cancelled, while stopping is still something this
   * mutation can do.
   *
   * A mutation is not a read: the caller may stop caring at any moment, but the
   * repository may not be left half-changed because they did. So cancellation
   * is not tested at whatever `await` happens to be running — it is tested at
   * points that name themselves, each one either before the first write or
   * inside read-only verification whose failure the caller already handles by
   * putting everything back. Throwing here therefore takes the same path as any
   * other refusal: the tree is restored, nothing is committed.
   *
   * Past {@link beyondCancellation} this does nothing at all, which is the
   * point — an interrupted removal is worse than a slow one.
   */
  checkpoint(): void;
  /**
   * The mutation is now beyond stopping: from here it either completes or is
   * rolled back, and a cancellation is ignored rather than left to land in the
   * middle of a removal. Called immediately before the first act that cannot be
   * abandoned where it stands.
   */
  beyondCancellation(): void;
  /** The scan-time state of the repository, for messages and results. */
  status: SkillRepoStatus;
}

/**
 * How a mutation proves that what Git staged at a path is what IT made.
 *
 * `git add` reads a pathname, and the repository lock does not cover the person
 * editing the same working tree, so "I claimed this path" is not the same claim
 * as "the bytes in the index are mine". Every claimed path carries one of these
 * and is checked against it before the commit is allowed:
 *
 * - `bytes` — the exact content this mutation wrote. The index entry's object
 *   id must equal the id those bytes hash to, which no replacement can match.
 * - `movedFrom` — for content this process did not write itself but MOVED: the
 *   path it came from. The index entry must be exactly what the repository has
 *   committed there, mode and object alike.
 *
 * Both are claims about CONTENT, and deliberately so. An earlier version proved
 * a moved entry by the inode it had placed and pinned, which says which entry
 * the name resolves to and nothing whatever about what is inside it: a direct
 * author can truncate and rewrite that very inode, keeping its number, and the
 * check would pass over their bytes. An identity is an answer to "is this still
 * the same file?", never to "is this still the same content?".
 */
export type ClaimProof = { bytes: Uint8Array } | { movedFrom: string };

/**
 * One entry as the repository has it: the Git file mode (`100644`, `100755`,
 * `120000` for a symlink, `160000` for a gitlink) and the object at it.
 *
 * Both halves, because either one alone is a different question. The object
 * answers "is this the same content?" and the mode answers "is this the same
 * KIND of thing, with the same bit set?" — and for a symlink the object is the
 * blob of its TARGET, which is only meaningful once the mode says so.
 */
export interface SkillCommittedEntry {
  mode: string;
  object: string;
}

/** A refusal that names what the caller has to do about it. */
class SkillRepositoryError extends Error {}

/**
 * A mutation the caller stopped, at a point where stopping changed nothing.
 *
 * Its own class because it is not a failure of the library or of the request:
 * everything it touched has been put back by the time it surfaces, and a caller
 * that wants to distinguish "you asked me to stop" from "this could not be
 * done" needs more than a message to do it on.
 */
export class SkillMutationCancelledError extends Error {}

/**
 * What a mutation registered about one path, and what rollback may do with it.
 *
 * `staged` is the pathspec: only a path a mutation actually made is handed to
 * `git add`, because `add -A` on a broad name stages whatever occupies it — a
 * file a hand author queued under a folder this mutation created would ride
 * into the commit. `restore` is the separate, stronger claim: the working tree
 * may be reverted to HEAD at this path, and only while what stands there is
 * still what this mutation left.
 */
interface ExpectedCommitIdentity {
  message: string;
  authorName: string;
  authorEmail: string;
}

interface TouchedPath {
  /** Whether this path may be handed to `git add`. */
  staged: boolean;
  /** What the index entry at this path must turn out to be. */
  proof?: ClaimProof;
  /** What rollback is allowed to do here. */
  restore:
    | { kind: "none" }
    /** Truncated but not yet rewritten: only HEAD still has it intact. */
    | { kind: "always" }
    /** Restore while the file still holds exactly these bytes. */
    | { kind: "unchanged"; digest: string }
    /** Restore while nothing stands at the path again. */
    | { kind: "absent" };
}

/** Git's empty tree, which every repository has: "nothing was here before". */
const EMPTY_TREE_REF = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const HISTORY_LIMIT_DEFAULT = 20;
const MAX_STATUS_CHANGES = 20;
/** Bound on ONE retained subject or trailer value from a commit message. */
const MAX_HISTORY_FIELD_CHARS = 400;
/** Bound on the whole `git log` stream a history read retains. */
const MAX_HISTORY_STREAM_CHARS = 256 * 1024;
/** Bounds on provenance a caller supplies for a commit message. */
export const MAX_COMMIT_REASON_CHARS = 200;
export const MAX_COMMIT_TASK_ID_CHARS = 64;
const MAX_COMMIT_ACTOR_CHARS = 120;
/**
 * Subject and trailers only, with the subject truncated BY GIT.
 *
 * `%B` pulled every complete commit message through the executor, so one
 * hand-authored megabyte-long message could overflow its buffer and be reported
 * as an empty history. These are the only two fields this module parses, and
 * `%<(N,trunc)` means even a single enormous subject line never reaches the
 * stream at full length.
 */
const LOG_FIELDS = [
  "%H",
  "%an",
  "%aI",
  `%<(${MAX_HISTORY_FIELD_CHARS},trunc)%s`,
  "%(trailers:only,unfold)",
];
/** How many separated fields a COMPLETE record has, for partial-chunk triage. */
const LOG_FIELD_COUNT = LOG_FIELDS.length;
// Commit messages cannot contain NUL. `-z` terminates the final field with the
// same collision-proof byte, so the stream is a sequence of fixed-size groups.
const LOG_FORMAT = LOG_FIELDS.join("%x00");
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/;

/**
 * Serialize the transition from a plain directory to a repository. The normal
 * repo lock key changes when `.git` first appears, so this stable outer chain
 * closes that one-time boundary; `git init` itself still takes the canonical
 * repository mutation lock.
 */
async function withBootstrapLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = bootstrapLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  bootstrapLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Validate a caller-supplied revision before it reaches `git log`/`git diff` as
 * a positional argument. An option-shaped value such as `--output=<file>` would
 * turn a read into a write, so it is refused here and the commands ALSO pass
 * `--end-of-options`.
 */
function assertGitRevision(value: string, label: string): string {
  const rev = value.trim();
  if (!rev) throw new SkillRepositoryError(`A ${label} revision is required.`);
  if (rev.startsWith("-"))
    throw new SkillRepositoryError(`Invalid ${label} revision: "${value}".`);
  return rev;
}

/** Lazy, idempotent bootstrap plus the committing mutation seam. */
export class SkillLibraryStore {
  readonly root: string;
  private initialized: Promise<void> | undefined;
  /** The repository's hash algorithm, asked once and reused. */
  private objectFormat: Promise<"sha1" | "sha256"> | undefined;
  /** Whether this repository tracks file modes (`core.fileMode`), asked once. */
  private fileModes: Promise<boolean> | undefined;

  constructor(root: string = SKILLS_LIBRARY_DIR) {
    this.root = root;
  }

  /** Ensure the library root exists and is a dedicated Git repository. */
  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.doInitialize().catch((error: unknown) => {
        // A transient filesystem or Git failure must not poison this instance.
        this.initialized = undefined;
        throw error;
      });
    }
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await withBootstrapLock(this.lockKey(), async () => {
      await withRepoLock(await repoLockKey(this.root), async () => {
        if (!existsSync(join(this.root, ".git"))) {
          await git(["init", "-b", "main"], this.root);
        }
      });
    });
  }

  private lockKey(): string {
    try {
      return `skills:${realpathSync(this.root)}`;
    } catch {
      return `skills:${resolve(this.root)}`;
    }
  }

  /**
   * Current repository state: cleanliness (including UNTRACKED files, which is
   * what makes a committed skill complete), the branch, and HEAD.
   */
  async status(): Promise<SkillRepoStatus> {
    await this.ensureInitialized();
    return this.readStatus();
  }

  /**
   * Apply one complete mutation as exactly one commit.
   *
   * Everything runs under the canonical repository lock: the cleanliness check,
   * the caller's resolve/apply/validate work, staging, and the commit. A caller
   * therefore never nests another repository lock inside `run`. Any failure
   * restores every touched path and leaves HEAD where it was.
   */
  async commitMutation<T>(
    meta: SkillCommitMeta,
    run: (context: SkillMutationContext) => Promise<T>,
    options: {
      /**
       * Runs after a successful commit while the repository lock is STILL
       * held, so what it observes is the committed state and not the next
       * mutation's half-written files. Its failure never unmakes the commit.
       */
      afterCommit?: () => Promise<void>;
      /**
       * The caller's cancellation. Honoured at the mutation's own checkpoints
       * only, and never once it is beyond stopping — see
       * {@link SkillMutationContext.checkpoint}.
       */
      signal?: AbortSignal;
    } = {},
  ): Promise<{ value: T; commit: SkillCommitResult; status: SkillRepoStatus }> {
    await this.ensureInitialized();
    // Node replaces malformed UTF-16 (for example a lone surrogate left by
    // code-unit clipping) with U+FFFD when it writes or spawns. Canonicalize
    // before the mutation can write anything, so the generated message and the
    // identity proved after Git's UTF-8 round trip are the same strings.
    const canonicalMeta = canonicalCommitMeta(meta);
    const reason = canonicalMeta.reason.trim();
    if (!reason) throw new SkillRepositoryError("A commit reason is required.");

    return withRepoLock(await repoLockKey(this.root), async () => {
      /** Whether stopping is still free. Latched off, never back on. */
      let cancellable = true;
      const checkpoint = (): void => {
        if (!cancellable || options.signal?.aborted !== true) return;
        throw new SkillMutationCancelledError(
          `The skills library mutation "${reason}" was cancelled before it changed anything.`,
        );
      };
      // Before the cleanliness read, so a call cancelled while it waited for
      // the repository lock does no work at all.
      checkpoint();
      const status = await this.readStatus();
      if (!status.clean) throw dirtyRepositoryError(this.root, status);
      await this.assertIndexUsable();

      const touched = new Map<string, TouchedPath>();
      const undos: Array<() => Promise<void>> = [];
      const holds: Array<{ close: () => Promise<unknown> }> = [];
      let released = false;
      /** Closed exactly once, on every path out of the commit attempt. */
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        for (const handle of [...holds].reverse()) {
          await handle.close().catch(() => undefined);
        }
      };
      const claim = (path: string): TouchedPath => {
        const existing = touched.get(path);
        if (existing) return existing;
        const entry: TouchedPath = { staged: false, restore: { kind: "none" } };
        touched.set(path, entry);
        return entry;
      };
      const context: SkillMutationContext = {
        root: this.root,
        status,
        touch: (...paths) => {
          for (const path of paths) {
            if (!touched.has(path)) {
              touched.set(path, { staged: false, restore: { kind: "none" } });
            }
          }
        },
        created: (path, proof) => {
          const entry = claim(path);
          entry.staged = true;
          entry.proof = proof;
        },
        damaged: (path) => {
          const entry = claim(path);
          entry.staged = true;
          entry.restore = { kind: "always" };
          // The committed bytes are now the only intact copy: whatever happens
          // next has to finish or be undone, not be abandoned.
          cancellable = false;
        },
        wrote: (path, content) => {
          const entry = claim(path);
          entry.staged = true;
          entry.proof = { bytes: content };
          entry.restore = { kind: "unchanged", digest: digestOf(content) };
        },
        removed: (path) => {
          const entry = claim(path);
          entry.staged = true;
          cancellable = false;
          // A removal that follows a truncation is still the truncation's
          // problem: HEAD is the only intact copy either way.
          if (entry.restore.kind !== "always") {
            entry.restore = { kind: "absent" };
          }
        },
        disown: (path) => {
          touched.delete(path);
        },
        onRollback: (undo) => {
          undos.push(undo);
        },
        hold: (handle) => {
          holds.push(handle);
        },
        checkpoint,
        beyondCancellation: () => {
          cancellable = false;
        },
        committedObject: async (path) =>
          (await this.committedEntry(path, "HEAD"))?.object,
        committedFiles: (prefix, limit) => this.committedFiles(prefix, limit),
        modeStillCommitted: (committed, current) =>
          this.modeStillCommitted(committed, current),
        // Hashing a hand-authored file is the one unbounded stretch of work a
        // mutation does — the library is the user's, and nothing caps what they
        // put beside a skill — so the checkpoint goes INSIDE the read loop
        // rather than only around it. Past `beyondCancellation` it is inert,
        // which is what lets the same call be used by a removal's own checks.
        blobId: (content) => this.blobId(content, checkpoint),
      };
      let value: T;
      let commit: SkillCommitResult;
      try {
        value = await run(context);
        // The work is done and the Git handoff is next; there is nothing left
        // to save by stopping, and a commit is not a thing to interrupt.
        cancellable = false;
        // Only paths this mutation actually MADE are handed to Git. `add -A` on
        // a broad name stages whatever occupies it, and the lock says nothing
        // about a hand author: a file queued under a folder this mutation
        // created would otherwise ride into its commit.
        const paths = [...touched]
          .filter(([, info]) => info.staged)
          .map(([path]) => path)
          .sort();
        if (paths.length === 0) {
          throw new SkillRepositoryError(
            "The mutation registered no paths to commit.",
          );
        }
        await git(["add", "-A", "--", ...paths], this.root);
        await this.assertStagedExactly(touched);
        // What HEAD was before, so what the commit CONTAINS can be checked
        // against the claims afterwards and undone if it does not match. The
        // index proof above is taken before `git commit` runs, and a successful
        // `pre-commit` hook can stage more between the two.
        const parent = await gitOptional(["rev-parse", "HEAD"], this.root);
        const committed = await this.commitStaged({
          ...canonicalMeta,
          reason,
        });
        commit = committed.result;
        await this.assertCommittedExactly(
          touched,
          parent.code === 0 ? parent.stdout.trim() : undefined,
          committed.identity,
        );
      } catch (error) {
        // Undoing is not optional work, so it is never cut short: the undos run
        // through the same `blobId` the mutation used, and a cancelled caller
        // must not stop a restore halfway.
        cancellable = false;
        throw await this.rollbackPaths(touched, undos, release, error);
      } finally {
        await release();
      }
      const after = await this.readStatus();
      if (options.afterCommit) {
        try {
          await options.afterCommit();
        } catch {
          // The commit is made and reported; a failed refresh of an open
          // browser must not present a successful mutation as a failure.
        }
      }
      return { value, commit, status: after };
    });
  }

  /**
   * Refuse before writing anything when Git cannot take the index lock.
   *
   * A stale `.git/index.lock` coexists with a clean status, and it fails BOTH
   * the staging of a mutation and the `reset`/`checkout` that would undo it —
   * the one combination that could leave a tool's write in the working tree.
   * Detecting it up front turns that into an ordinary pre-flight refusal.
   */
  private async assertIndexUsable(): Promise<void> {
    const gitDir = await gitOptional(
      ["rev-parse", "--absolute-git-dir"],
      this.root,
    );
    const directory = gitDir.code === 0 ? gitDir.stdout.trim() : "";
    if (!directory || !existsSync(join(directory, "index.lock"))) return;
    throw new SkillRepositoryError(
      `The skills repository at ${this.root} has a Git index lock (${join(directory, "index.lock")}), so no skill mutation can run: another Git process is using it, or a previous one left it behind. Wait for that process or remove the stale lock, then retry. Reads, history, and diffs remain available meanwhile.`,
    );
  }

  /**
   * Compact history for the whole library or one library-relative path.
   *
   * An UNBORN repository is the one empty answer: it genuinely has no commits.
   * Every other Git failure throws, because reporting a read that did not
   * happen as "no history" is the same lie an empty library would be.
   */
  async history(
    options: { path?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<SkillHistory> {
    await this.ensureInitialized();
    if (await this.isUnborn()) return { entries: [], truncated: false };
    const limit = options.limit ?? HISTORY_LIMIT_DEFAULT;
    // Read one extra record so hitting the caller's commit-count bound can be
    // distinguished from a history that genuinely contains exactly `limit`
    // commits. The character-stream cap remains the outer safety bound.
    const args = [
      "-c",
      "i18n.logOutputEncoding=utf-8",
      "log",
      "-z",
      `--max-count=${limit + 1}`,
      `--format=${LOG_FORMAT}`,
    ];
    if (options.path) args.push("--", options.path);
    const { patch, truncated } = await gitBoundedStdout(
      args,
      this.root,
      MAX_HISTORY_STREAM_CHARS,
      options.signal,
    );
    const fields = patch.split("\0");
    const parsedEntries: SkillHistoryEntry[] = [];
    // A stream cut inside the trailer still has all five fields and identifies
    // a real commit; a cut in any earlier field does not. With complete output
    // the record terminator supplies the fifth delimiter. No commit message can
    // forge either a field or a record because Git rejects NUL in messages.
    for (
      let at = 0;
      at + LOG_FIELD_COUNT <= fields.length;
      at += LOG_FIELD_COUNT
    ) {
      const record = fields.slice(at, at + LOG_FIELD_COUNT);
      if (record[0]) parsedEntries.push(parseHistoryRecord(record));
    }
    const commitLimitReached = parsedEntries.length > limit;
    return {
      entries: parsedEntries.slice(0, limit),
      truncated: truncated || commitLimitReached,
    };
  }

  /** Unified diff between validated revisions, optionally scoped to a path. */
  async diff(options: {
    from: string;
    to?: string;
    path?: string;
    maxChars: number;
    signal?: AbortSignal;
  }): Promise<{ patch: string; totalChars: number; truncated: boolean }> {
    await this.ensureInitialized();
    const args = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      assertGitRevision(options.from, "diff from"),
    ];
    if (options.to) args.push(assertGitRevision(options.to, "diff to"));
    if (options.path) args.push("--", options.path);
    return gitBoundedStdout(args, this.root, options.maxChars, options.signal);
  }

  /**
   * Whether the repository genuinely has no commits yet.
   *
   * Two failures had to be told apart from that, because both used to answer
   * "this library has no past" for a library that has one. A git that cannot
   * RUN is caught by `gitOptionalExit`, which returns only the result of a
   * process that actually ran. A git that ran and FAILED is caught by the exit
   * code: with `--quiet`, `rev-parse` exits 1 for the one thing that means
   * unborn — HEAD names a branch that has no commit — and 128 for a fatal
   * error such as a corrupt `.git/HEAD`. Only the first is an empty history;
   * the second throws, carrying git's own message.
   */
  private async isUnborn(): Promise<boolean> {
    const result = await gitOptionalExit(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      this.root,
    );
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new SkillRepositoryError(
      `The skills repository at ${this.root} could not be read (git rev-parse exited ${result.code}): ${
        result.stderr.trim() || "no error output"
      }. This is a repository problem, not an empty history.`,
    );
  }

  private async readStatus(): Promise<SkillRepoStatus> {
    const porcelain = await git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      this.root,
    );
    const changes = parsePorcelain(porcelain.stdout);
    const branch = await gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      this.root,
    );
    // Git's pretty-format width truncation counts terminal columns, not bytes
    // or code points: zero-width combining marks can therefore make `%<(...`
    // emit an arbitrarily large subject. Retain only the hash, separator, one
    // bounded subject, and Git's final newline while still consuming stdout.
    const head = (await this.isUnborn())
      ? undefined
      : await gitBoundedStdout(
          [
            "-c",
            "i18n.logOutputEncoding=utf-8",
            "log",
            "-1",
            "--format=%H%x00%s",
          ],
          this.root,
          // SHA-256 repositories use 64-character object ids.
          64 + 1 + MAX_HISTORY_FIELD_CHARS + 1,
        );
    const [rawCommit = "", rawSubject = ""] = head?.patch.split("\0") ?? [];
    const commit = rawCommit.trim();
    const subject = boundField(rawSubject);
    return {
      clean: changes.length === 0,
      changeCount: changes.length,
      changes: changes.slice(0, MAX_STATUS_CHANGES),
      ...(branch.code === 0 && branch.stdout.trim()
        ? { branch: branch.stdout.trim() }
        : {}),
      ...(commit
        ? { head: { commit, shortCommit: commit.slice(0, 12), subject } }
        : {}),
    };
  }

  /**
   * Commit what the mutation staged. Signing and background GC are disabled per
   * invocation rather than written into the user's repository config: the
   * commit must not depend on machine-global Git settings, and it must not
   * detach a maintenance process that would outlive this lock.
   */
  private async commitStaged(
    meta: SkillCommitMeta & { reason: string },
  ): Promise<{
    result: SkillCommitResult;
    identity: ExpectedCommitIdentity;
  }> {
    const staged = await git(
      [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
      ],
      this.root,
    );
    const changedPaths = staged.stdout
      .split("\0")
      .filter((path) => path !== "");
    if (changedPaths.length === 0) {
      throw new SkillRepositoryError(
        "Nothing changed, so there is nothing to commit; the requested content already matches the library.",
      );
    }
    const identity: ExpectedCommitIdentity = {
      message: buildCommitMessage(meta, changedPaths),
      authorName: trailerValue(meta.actor.name) || "skill agent",
      authorEmail: actorEmail(meta.actor),
    };
    const directory = await mkdtemp(join(tmpdir(), "skills-commit-"));
    const file = join(directory, "message.txt");
    try {
      await writeFile(file, identity.message, "utf8");
      await git(
        [
          "-c",
          // Sanitized for the same reason the trailers are: a session title is
          // outside data, and a newline in a config value is not a name.
          `user.name=${identity.authorName}`,
          "-c",
          `user.email=${identity.authorEmail}`,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "i18n.commitEncoding=utf-8",
          "-c",
          "gc.autoDetach=false",
          "commit",
          "--quiet",
          "--cleanup=verbatim",
          "-F",
          file,
        ],
        this.root,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const head = (await git(["rev-parse", "HEAD"], this.root)).stdout.trim();
    return {
      result: { commit: head, shortCommit: head.slice(0, 12), changedPaths },
      identity,
    };
  }

  /**
   * Restore every path a failed mutation touched, in the index and the working
   * tree alike, and PROVE it worked. A library with no commits yet has nothing
   * to check out, so the staged entries are dropped instead and `clean` removes
   * what was created.
   *
   * Returns the error to throw. Each restore command is best-effort on its own
   * — a path that was never in HEAD makes `checkout` fail, which is normal —
   * so the only trustworthy check is the repository's own status afterwards. If
   * the tree is not clean again, the caller is told BOTH what failed and what
   * is left behind rather than being handed the original error over a working
   * tree that still holds the tool's write.
   */
  private async rollbackPaths(
    paths: Map<string, TouchedPath>,
    undos: Array<() => Promise<void>>,
    release: () => Promise<void>,
    cause: unknown,
  ): Promise<unknown> {
    if (paths.size === 0 && undos.length === 0) {
      await release();
      return cause;
    }
    // Best-effort, and deliberately not allowed to end the rollback: the Git
    // restore can fail as a whole (its own `rev-parse` needs a process, and
    // under descriptor pressure spawning one can fail), and if that skipped the
    // mutation's own undos it would strand exactly the created files and
    // directories Git could never have restored anyway.
    const restoreFailure = await this.restorePaths(paths).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Then the mutation's own undos, last registered first. They run AFTER the
    // generic restore because that is what clears the files out of a directory
    // this mutation created, and because each of them is conditional: a tree is
    // removed only while it holds nothing but what this mutation assembled, a
    // created directory only while it is empty. Anything a hand author added
    // therefore stops its own removal and is reported below rather than being
    // cleaned away.
    for (const undo of [...undos].reverse()) {
      await undo().catch(() => undefined);
    }
    // The undos were the last thing that needed the mutation's pins, so the
    // descriptors go now — before the status read that decides what is left, so
    // nothing this rollback still held can be mistaken for a leftover.
    await release();
    const after = await this.readStatus().catch(() => undefined);
    if (after?.clean && !restoreFailure) return cause;
    if (!after) {
      return new SkillRepositoryError(
        `The mutation failed AND the skills repository at ${this.root} could not be read afterwards, so what is left in it is unknown. Check it by hand before retrying. The original failure was: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (after.clean) {
      // Nothing is left behind, but part of the undo did not run, so say so
      // rather than presenting a clean tree as a complete rollback.
      return new SkillRepositoryError(
        `The mutation failed and its Git restore could not run (${
          restoreFailure instanceof Error
            ? restoreFailure.message
            : String(restoreFailure)
        }); the skills repository at ${this.root} is clean again. The original failure was: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    return new SkillRepositoryError(
      `The mutation failed AND its changes could not be undone, so the skills repository at ${this.root} now holds ${after.changeCount} uncommitted change(s): ${after.changes
        .map((change) => `${change.status.trim() || "??"} ${change.path}`)
        .join(
          ", ",
        )}. Restore or commit them by hand in that repository before retrying. The original failure was: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  /**
   * Prove the index holds exactly what this mutation made, and nothing else.
   *
   * Two different things can go wrong at the Git handoff, because `add` takes a
   * pathname and the lock does not cover a hand author. A path nobody claimed
   * can appear — a removal's pathspec is a whole folder, so a tracked file
   * recreated under a name this mutation emptied would be staged as its work.
   * And a path that WAS claimed can hold somebody else's bytes by the time
   * `add` reads it, which no check of names and statuses would notice.
   *
   * So the index is read back and every entry has to answer for itself: an
   * addition or modification must be a claimed path whose PROOF holds — the
   * object id the claimed bytes hash to, or the inode this mutation pinned —
   * and a deletion must fall below a path it removed. Anything else refuses the
   * commit, which hands the tree to a rollback that will not touch a hand
   * author's file either.
   */
  private async assertStagedExactly(
    paths: Map<string, TouchedPath>,
  ): Promise<void> {
    const staged = await git(
      ["diff", "--cached", "--name-status", "-z", "--no-renames"],
      this.root,
    );
    const unexpected = await this.unclaimedChanges(
      staged.stdout,
      paths,
      "HEAD",
    );
    if (unexpected.length === 0) return;
    throw new SkillRepositoryError(
      `The commit would have contained ${unexpected.length} change(s) this mutation did not make: ${unexpected
        .slice(0, MAX_STATUS_CHANGES)
        .join(
          ", ",
        )}. Something else wrote in the skills repository at ${this.root} while the mutation ran, so nothing was committed. Resolve those changes by hand, then retry.`,
    );
  }

  /** Whether the index entry staged at `path` is the one the claim proves. */
  private async provenStaged(
    path: string,
    proof: ClaimProof,
    before: string,
  ): Promise<boolean> {
    const staged = await this.stagedEntry(path);
    if (!staged) return false;
    if ("movedFrom" in proof) {
      // Content this mutation carried across rather than wrote: what the
      // repository COMMITTED at the old path is what the new one must hold.
      // The tree was clean when the mutation started — that is the precondition
      // every mutation runs under — so the committed entry is exactly what the
      // link it placed pointed at, and any rewrite of it since, in place or
      // not, shows up here as a different object.
      const committed = await this.committedEntry(proof.movedFrom, before);
      return (
        committed !== undefined &&
        committed.object === staged.object &&
        committed.mode === staged.mode
      );
    }
    // The bytes prove the CONTENT; the mode is the other half of an index entry
    // and just as much a change somebody else could have made. Nothing here
    // ever changes a mode, so the one that must still be there is the one the
    // repository already had — or, for a path it created, the 0644 every write
    // in this module makes. A concurrent `chmod +x` is then a change this
    // mutation did not make, and refuses the commit like any other.
    const committed = await this.committedEntry(path, before);
    return (
      staged.mode === (committed?.mode ?? "100644") &&
      staged.object === (await this.blobId(proof.bytes))
    );
  }

  /** One `ls-tree -r` for a whole folder, refused when it is bigger than asked. */
  private async committedFiles(
    prefix: string,
    limit: number,
  ): Promise<ReadonlyMap<string, SkillCommittedEntry> | undefined> {
    const listed = await gitOptional(
      ["ls-tree", "-r", "-z", "HEAD", "--", prefix],
      this.root,
    );
    if (listed.code !== 0) return new Map();
    const files = new Map<string, SkillCommittedEntry>();
    for (const record of listed.stdout.split("\0")) {
      if (record === "") continue;
      // `<mode> <type> <object>\t<path>`
      const [meta, path] = record.split("\t");
      const [mode, , object] = meta?.split(" ") ?? [];
      if (mode === undefined || object === undefined || path === undefined) {
        continue;
      }
      if (files.size >= limit) return undefined;
      files.set(path.slice(prefix.length + 1), { mode, object });
    }
    return files;
  }

  /** Whether a working-tree mode still matches a committed one, Git's way. */
  private async modeStillCommitted(
    committed: string,
    current: number,
  ): Promise<boolean> {
    if (committed !== "100644" && committed !== "100755") return false;
    // `--get` exits 1 when the setting is absent, which on Linux means the
    // default: modes ARE tracked. Ask Git to normalize its boolean spellings
    // (`false`, `off`, `no`, `0`, and case variants) rather than parsing one.
    this.fileModes ??= gitOptional(
      ["config", "--bool", "--get", "core.fileMode"],
      this.root,
    ).then((result) => result.code !== 0 || result.stdout.trim() !== "false");
    if (!(await this.fileModes)) return true;
    // Git records exactly one bit of a file's mode: owner-execute.
    return ((current & 0o100) !== 0) === (committed === "100755");
  }

  /** What the repository has COMMITTED at `path`, mode and object. */
  private async committedEntry(
    path: string,
    ref: string,
  ): Promise<{ mode: string; object: string } | undefined> {
    const committed = await gitOptional(
      ["ls-tree", "-z", ref, "--", path],
      this.root,
    );
    if (committed.code !== 0) return undefined;
    // `<mode> <type> <object>\t<path>`
    const record = committed.stdout.split("\0").find((line) => line !== "");
    const [meta] = record?.split("\t") ?? [];
    const [mode, , object] = meta?.split(" ") ?? [];
    if (mode === undefined || object === undefined) return undefined;
    return { mode, object };
  }

  /**
   * Which of the changes in one `--name-status -z` listing this mutation cannot
   * account for: a path it never claimed, a deletion outside anything it
   * removed, or a claimed path whose recorded content proof no longer holds.
   *
   * The same question of the index before the commit and of the commit after
   * it, because the index a commit is made from is the tree it writes.
   */
  private async unclaimedChanges(
    nameStatus: string,
    paths: Map<string, TouchedPath>,
    /**
     * What the repository held BEFORE this mutation, for the proofs that
     * compare against it. `HEAD` while the commit is still ahead; its parent
     * once the commit is made, because by then `HEAD` is this mutation's own
     * work and a moved path no longer exists there at all.
     */
    before: string,
  ): Promise<string[]> {
    const fields = nameStatus.split("\0").filter((field) => field !== "");
    const removedRoots = [...paths]
      .filter(([, info]) => info.restore.kind === "absent")
      .map(([path]) => path);
    const changed: string[] = [];
    const unexpected: string[] = [];
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const status = fields[at]!;
      const path = fields[at + 1]!;
      if (status.startsWith("D")) {
        if (
          paths.get(path)?.staged ||
          removedRoots.some((root) => path.startsWith(`${root}/`))
        ) {
          continue;
        }
        unexpected.push(`${status} ${path}`);
        continue;
      }
      if (!paths.get(path)?.proof) {
        unexpected.push(`${status} ${path}`);
        continue;
      }
      changed.push(path);
    }
    for (const path of changed) {
      const held = await this.provenStaged(
        path,
        paths.get(path)!.proof!,
        before,
      );
      if (!held) unexpected.push(`M ${path} (not what this mutation made)`);
    }
    return unexpected;
  }

  /**
   * Prove the COMMIT holds exactly what this mutation made, and undo it if not.
   *
   * The index proof happens before `git commit`, and a `pre-commit` hook runs
   * between them — with the index in its hands. A hook that stages a file of
   * its own therefore lands content in the commit that no claim covers, while
   * the result this returns names only what the mutation did: the repository
   * absorbs somebody's work and the provenance says otherwise.
   *
   * So the commit is read back the same way the index was. When it holds
   * anything unclaimed the ref is moved back to where it was and the index
   * reset with it — the working tree is left alone, so nothing anybody wrote is
   * destroyed — and the refusal names what was in it.
   */
  private async assertCommittedExactly(
    paths: Map<string, TouchedPath>,
    parent: string | undefined,
    expected: ExpectedCommitIdentity,
  ): Promise<void> {
    const ancestry = (
      await git(["rev-list", "--parents", "-n", "1", "HEAD"], this.root)
    ).stdout
      .trim()
      .split(/\s+/);
    const actualParents = ancestry.slice(1);
    const expectedParents = parent ? [parent] : [];
    if (
      actualParents.length !== expectedParents.length ||
      actualParents.some((value, index) => value !== expectedParents[index])
    ) {
      await this.undoCommit(parent);
      throw new SkillRepositoryError(
        `The commit did not leave exactly one new commit on the skills repository, so it was undone. Something else — most likely a \`post-commit\` hook in ${this.root} — moved HEAD while the commit was being made. Resolve that hook or repository automation, then retry.`,
      );
    }
    // A same-parent amend evades the ancestry proof: it replaces the commit
    // rather than adding one. Read back the provenance identity too, bounded by
    // the exact message this mutation generated, so an amended or pathological
    // hook message cannot overflow the ordinary Git executor.
    const identityLimit =
      expected.message.length +
      expected.authorName.length +
      expected.authorEmail.length +
      4;
    const actual = await gitBoundedStdout(
      [
        "-c",
        "i18n.logOutputEncoding=utf-8",
        "log",
        "-1",
        "--format=%B%x00%an%x00%ae",
        "HEAD",
      ],
      this.root,
      identityLimit,
    );
    const [message = "", authorName = "", authorEmail = ""] =
      actual.patch.split("\0");
    if (
      actual.truncated ||
      message !== expected.message ||
      authorName !== expected.authorName ||
      authorEmail.trimEnd() !== expected.authorEmail
    ) {
      await this.undoCommit(parent);
      throw new SkillRepositoryError(
        `The skills commit's generated message or author was replaced, so it was undone. Something else — most likely a \`post-commit\` hook in ${this.root} — amended HEAD while the commit was being made. Resolve that hook or repository automation, then retry.`,
      );
    }
    const committed = await git(
      parent
        ? ["diff", "--name-status", "-z", "--no-renames", parent, "HEAD"]
        : ["show", "--name-status", "-z", "--no-renames", "--format=", "HEAD"],
      this.root,
    );
    const unexpected = await this.unclaimedChanges(
      committed.stdout,
      paths,
      parent ?? EMPTY_TREE_REF,
    );
    if (unexpected.length === 0) return;
    // Back to where the ref was. `reset` without `--hard` leaves every file on
    // disk: a hook's own file stays, untracked and reported, rather than being
    // destroyed to undo its staging.
    await this.undoCommit(parent);
    throw new SkillRepositoryError(
      `The commit was made with ${unexpected.length} change(s) this mutation did not make, so it was undone: ${unexpected
        .slice(0, MAX_STATUS_CHANGES)
        .join(
          ", ",
        )}. Something else — most likely a \`pre-commit\` hook in the skills repository at ${this.root} — staged content while the commit was being made. Resolve those changes by hand, then retry.`,
    );
  }

  /** Move the current branch back to the mutation's captured parent. */
  private async undoCommit(parent: string | undefined): Promise<void> {
    await gitOptional(
      parent ? ["reset", "--quiet", parent] : ["update-ref", "-d", "HEAD"],
      this.root,
    );
  }

  /** The index entry a commit would take at `path`, mode and object. */
  private async stagedEntry(
    path: string,
  ): Promise<{ mode: string; object: string } | undefined> {
    const listed = await git(
      ["ls-files", "--stage", "-z", "--", path],
      this.root,
    );
    // `<mode> <object> <stage>\t<path>`
    const entry = listed.stdout.split("\0").find((line) => line !== "");
    const [mode, object] = entry?.split(" ") ?? [];
    if (mode === undefined || object === undefined) return undefined;
    return { mode, object };
  }

  /** The object id Git gives this content as a blob, in this repository. */
  private async blobId(
    content: Uint8Array | FileHandle,
    /** Consulted between chunks; throws to abandon a read nobody wants. */
    checkpoint?: () => void,
  ): Promise<string> {
    this.objectFormat ??= git(["rev-parse", "--show-object-format"], this.root)
      .then((result) => (result.stdout.trim() === "sha256" ? "sha256" : "sha1"))
      .catch(() => "sha1" as const);
    const algorithm = await this.objectFormat;
    const hash = createHash(algorithm);
    if (content instanceof Uint8Array) {
      return hash
        .update(`blob ${content.byteLength}\0`)
        .update(content)
        .digest("hex");
    }
    // An open descriptor: hashed in chunks, because a supporting file is
    // whatever a hand author put there and reading it whole to check it would
    // undo the bounds everything else in this module keeps.
    //
    // A read is many syscalls and is NOT atomic against a writer who already
    // holds this inode open: detaching the entry to a private name stops new
    // opens by name, not writes through a descriptor taken before that. So the
    // hash is bracketed. Anything that moved while it ran makes the answer
    // unusable rather than a prefix that happens to match — an empty string,
    // which no object id equals, so every caller reads it as "not proven".
    const before = await content.stat({ bigint: true });
    const size = Number(before.size);
    hash.update(`blob ${size}\0`);
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      // Between chunks and not inside one: the file is only being READ, so the
      // hash can be abandoned wherever it has got to without leaving anything
      // behind — and a multi-gigabyte file a hand author put beside a skill
      // does not have to be hashed to the end before a stop is noticed.
      checkpoint?.();
      const { bytesRead } = await content.read(
        buffer,
        0,
        Math.min(buffer.byteLength, size - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== size) return "";
    // One byte PAST what was hashed: an append during the read leaves the
    // prefix matching, and only looking beyond it says so.
    const beyond = await content.read(buffer, 0, 1, size);
    if (beyond.bytesRead !== 0) return "";
    // And the inode's own account of itself. Any write moves `ctime`, which
    // — unlike `mtime` — no unprivileged caller can set back: `utimes` moves it
    // forward again (measured). So a modification anywhere in the file, before
    // or after the part already read, is visible here even when the size is
    // unchanged.
    const after = await content.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return "";
    }
    return hash.digest("hex");
  }

  /** Whether the working tree still holds what this mutation left at `path`. */
  private async mayRestore(path: string, info: TouchedPath): Promise<boolean> {
    const full = join(this.root, path);
    switch (info.restore.kind) {
      case "none":
        return false;
      case "always":
        // Truncated and then not rewritten: whatever is there is a fragment of
        // this mutation's own doing, and HEAD is the only intact copy.
        return true;
      case "absent":
        return !existsSync(full);
      case "unchanged": {
        const current = await readFile(full).catch(() => undefined);
        return (
          current !== undefined && digestOf(current) === info.restore.digest
        );
      }
    }
  }

  private async restorePaths(paths: Map<string, TouchedPath>): Promise<void> {
    const hasHead = !(await this.isUnborn());
    // One path at a time: a path that never existed in HEAD makes `checkout`
    // fail on its whole pathspec, which would silently skip the restore of
    // every OTHER path in the same failed batch.
    for (const [path, info] of paths) {
      if (hasHead) {
        // Unstaging is always safe: it touches the index, not the tree.
        await gitOptional(["reset", "--quiet", "--", path], this.root);
        // Restoring content is not. `checkout HEAD -- <path>` reverts whatever
        // differs from the commit no matter WHO wrote it, so it runs only while
        // the path still holds what this mutation left there — the bytes it
        // wrote, or nothing where it removed. A hook or a hand author who
        // rewrote the path afterwards owns it now, and the post-rollback status
        // check reports it rather than this reverting their work.
        if (await this.mayRestore(path, info)) {
          await gitOptional(["checkout", "HEAD", "--", path], this.root);
        }
      } else {
        await gitOptional(
          ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", path],
          this.root,
        );
      }
    }
    // There is deliberately no `git clean` here. It removes whatever holds a
    // NAME, and a path this mutation created is precisely a path Git cannot
    // restore, so by the time rollback runs the name may hold a file a hand
    // author wrote in its place — cleaning it to tidy up would destroy content
    // this mutation never made. Everything a mutation brings into existence is
    // therefore taken back by the mutation itself through `onRollback`, against
    // an inode it PINNED at creation. Git undoes only what Git can prove: the
    // index, and content it has committed.
  }
}

/** What a mutation left at a path, in a form rollback can compare against. */
function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The one refusal every mutation shares, carrying what the user must resolve. */
function dirtyRepositoryError(
  root: string,
  status: SkillRepoStatus,
): SkillRepositoryError {
  const sample = status.changes
    .map((change) => `${change.status.trim() || "??"} ${change.path}`)
    .join(", ");
  return new SkillRepositoryError(
    `The skills repository at ${root} has ${status.changeCount} uncommitted change(s), so no skill mutation can run: ${sample}${
      status.changeCount > status.changes.length ? ", …" : ""
    }. Commit or discard them in that repository (it is the user's own Git working tree), then retry. Reads, history, and diffs remain available meanwhile.`,
  );
}

function parsePorcelain(stdout: string): SkillRepoChange[] {
  const changes: SkillRepoChange[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // A rename record is followed by its origin path as a separate NUL record.
    if (status.startsWith("R") || status.startsWith("C")) index++;
    changes.push({ status, path });
  }
  return changes;
}

function canonicalUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("utf8");
}

function canonicalCommitMeta(meta: SkillCommitMeta): SkillCommitMeta {
  return {
    ...meta,
    reason: canonicalUtf8(meta.reason),
    actor: {
      id: canonicalUtf8(meta.actor.id),
      name: canonicalUtf8(meta.actor.name),
    },
    sessionId: canonicalUtf8(meta.sessionId),
    ...(meta.taskId === undefined
      ? {}
      : { taskId: canonicalUtf8(meta.taskId) }),
    ...(meta.skillNames === undefined
      ? {}
      : { skillNames: meta.skillNames.map(canonicalUtf8) }),
  };
}

function actorEmail(actor: SkillCommitActor): string {
  const slug =
    actor.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  return `${slug}@skills.local`;
}

/**
 * One provenance value as a trailer may carry it: a single bounded line.
 *
 * A trailer block is line-structured, so a newline anywhere in a value forges
 * or truncates the trailers around it — and the session title and Task id both
 * arrive from outside this module. Sanitizing HERE means no caller can emit a
 * commit message this module would not be able to parse back.
 */
function trailerValue(
  value: string,
  maxChars = MAX_COMMIT_ACTOR_CHARS,
): string {
  const single = value
    // oxlint-disable-next-line no-control-regex -- stripping control characters IS the sanitising step.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return single.length > maxChars
    ? `${single.slice(0, maxChars - 1)}…`
    : single;
}

function buildCommitMessage(
  meta: SkillCommitMeta & { reason: string },
  paths: string[],
): string {
  const subject =
    trailerValue(meta.reason, MAX_COMMIT_REASON_CHARS) || "Update skill";
  const lines = [subject, ""];
  const actor = trailerValue(meta.actor.id);
  const name = trailerValue(meta.actor.name);
  lines.push(`Skill-Actor: ${actor}${name ? ` (${name})` : ""}`);
  lines.push(`Skill-Session: ${trailerValue(meta.sessionId)}`);
  const taskId = meta.taskId
    ? trailerValue(meta.taskId, MAX_COMMIT_TASK_ID_CHARS)
    : "";
  if (taskId) lines.push(`Skill-Task: ${taskId}`);
  if (meta.skillNames?.length)
    lines.push(`Skill-Names: ${meta.skillNames.join(", ")}`);
  // A Git path may contain commas, quotes, trailing spaces, or any byte except
  // NUL and slash. JSON keeps the one-line trailer machine-decodable without
  // changing those paths (control bytes are escaped rather than collapsed).
  lines.push(`Skill-Paths: ${JSON.stringify(paths)}`);
  return lines.join("\n") + "\n";
}

/**
 * One `git log` record. Every retained field is bounded: the library is
 * hand-authored, so a commit subject or trailer is arbitrary user text and a
 * compact history must not become the largest thing in a tool result.
 */
function parseHistoryRecord(fields: string[]): SkillHistoryEntry {
  const [commit = "", author = "", date = "", subject = "", block = ""] =
    fields;
  const trailers: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = TRAILER_RE.exec(line.trim());
    if (!match) continue;
    const [, key, value = ""] = match;
    if (key) trailers[key] = boundField(value);
  }
  return {
    commit: commit.trim(),
    shortCommit: commit.trim().slice(0, 12),
    author: boundField(author),
    date: boundField(date),
    subject: boundField(subject),
    trailers,
  };
}

function boundField(value: string): string {
  const text = value.trim();
  return text.length > MAX_HISTORY_FIELD_CHARS
    ? `${text.slice(0, MAX_HISTORY_FIELD_CHARS - 1)}…`
    : text;
}

/**
 * The process-wide library store. Every read path — the `skills` topic, the
 * bounded HTTP detail read, and the agent tools — goes through this one
 * instance so they share a single bootstrap and one mutation lock chain.
 */
export const skillLibraryStore = new SkillLibraryStore();
