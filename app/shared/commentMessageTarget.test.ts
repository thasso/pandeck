import { describe, expect, it } from "vitest";
import { type CommentTarget, messageTargetForComment } from "./protocol.ts";
import { PA_OBJECT_TYPES } from "./objectLinks.ts";

/**
 * A comment failure names the object the thread is ON (`docs/messaging.md`).
 *
 * A comment is not an object the user navigates to: it is drawn by whatever
 * renders the entry, diff or transcript it hangs off, so that host is the
 * only surface that can report the failure in place. Naming the thread instead
 * would produce a target no client could route.
 */
describe("the object a comment failure names", () => {
  it("is the thread's host, for every comment target there is", () => {
    const cases: Array<[CommentTarget, { type: string; id: string }]> = [
      [
        {
          kind: "worktree",
          worktreeId: "w1",
          path: "src/a.ts",
          side: "new",
          revision: "HEAD",
        },
        { type: "worktree", id: "w1" },
      ],
      [
        { kind: "session", sessionId: "s1", entryId: "e9", blockIndex: 2 },
        { type: "session", id: "s1" },
      ],
    ];
    for (const [target, expected] of cases)
      expect(messageTargetForComment(target)).toEqual(expected);
  });

  // The type has to be one a client can route and open; an invented one is a
  // failure that reaches the user as neither a home nor a name.
  it("only ever names a known object type", () => {
    const targets: CommentTarget[] = [
      { kind: "session", sessionId: "s", entryId: "e", blockIndex: 0 },
      {
        kind: "worktree",
        worktreeId: "w",
        path: "p",
        side: "old",
        revision: "r",
      },
    ];
    for (const target of targets)
      expect(PA_OBJECT_TYPES).toContain(messageTargetForComment(target).type);
  });
});
