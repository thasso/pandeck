import type {
  CommentTarget,
  CommentThread,
  SelectorBundle,
} from "@assistant/shared";

interface CommentMutation {
  target: CommentTarget;
  threadIds: string[];
}

/**
 * The deliberately small persistence seam shared by git-JSONL and SQLite
 * comment domains. Session prompting and domain-specific anchor resolution stay
 * outside this interface.
 */
export interface CommentStore {
  list(target: CommentTarget): Promise<CommentThread[]>;
  add(input: {
    target: CommentTarget;
    body: string;
    selectors?: SelectorBundle;
  }): Promise<CommentMutation>;
  reply(input: {
    target: CommentTarget;
    threadId: string;
    body: string;
    parentId?: string;
  }): Promise<CommentMutation>;
  resolve(input: {
    target: CommentTarget;
    threadId: string;
    resolved: boolean;
  }): Promise<CommentMutation>;
  edit(input: {
    target: CommentTarget;
    threadId: string;
    commentId: string;
    body: string;
  }): Promise<CommentMutation>;
  delete(input: {
    target: CommentTarget;
    threadId: string;
    commentId?: string;
  }): Promise<CommentMutation>;
  attach(input: {
    target: CommentTarget;
    threadIds: string[];
    sessionId: string;
  }): Promise<CommentMutation>;
}

export function unsupportedCommentMutation(
  target: CommentTarget,
  operation: string,
): never {
  throw new Error(`${operation} is not supported for ${target.kind} comments.`);
}
