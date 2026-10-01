/**
 * One boot recovery step. Boot runs a long list of independent recoveries
 * (peer prompts, handoffs, auto-approvals, queues…); one that throws — an
 * unavailable card store, a corrupt row — must not skip every step after it,
 * and its log line must name the step that failed, not the one before it.
 */
import { errorText } from "./errors.ts";

/** Run `run`; a throw is logged under `label` and boot goes on. */
export function bootStep(label: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    console.warn(`[assistant] boot: ${label} failed:`, errorText(err));
  }
}
