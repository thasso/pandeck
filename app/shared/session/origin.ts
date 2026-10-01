/**
 * How a turn reached the session. Prompted turns carry this on their `user`
 * entry; a provider-initiated turn has no user entry and carries it on the
 * resulting `assistant` entry. The native session cannot express this, so we
 * attach it ourselves and preserve it into the client projection.
 *
 * `kind` is `human` (not `user`) to avoid colliding with an entry's `role`.
 */
interface BackgroundWorkPromptUpdate {
  taskId: string;
  label: string;
  /** The agent's description of the job, when it gave one. */
  description?: string;
  /** The bounded command line, as the registry row carries it. */
  command?: string;
  commandTruncated?: boolean;
  status: "activity" | "completed" | "failed" | "stopped" | "lost";
  humanLink: string;
  exitCode?: number;
  /**
   * How it ended, in the server's bounded words. The card's one line says only
   * WHICH way it ended; this is what the reader opens the card to learn, and
   * for `claude-query` work — which never carries an exit code — it is the only
   * account of the outcome there is. Never an output body or a host path.
   */
  outcomeSummary?: string;
  output?: {
    url: string;
    capturedBytes?: number;
    originalBytes?: number;
    truncated?: boolean;
  };
}

/** A compact browser projection for an automatic background-work turn. */
export interface BackgroundWorkPromptPresentation {
  kind: "background-work";
  updates: BackgroundWorkPromptUpdate[];
  omittedCount?: number;
}

type SystemPromptPresentation = BackgroundWorkPromptPresentation;

export type PromptOrigin =
  | { kind: "human" } // the real end-user typed it
  | { kind: "agent"; agentId: string } // a real agent — always identified
  | {
      kind: "system";
      source?: string;
      /** Browser-only summary; model-only detail travels through contextBlock. */
      presentation?: SystemPromptPresentation;
    }; // automation (cron, relay, command seed); optional label
