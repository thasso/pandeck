import type { RunOutcome } from "./liveSession.ts";

export interface PromptAppend {
  entryId: string;
  runId: string | undefined;
  accepted: boolean;
  joined: boolean;
}

export type PromptDeliveryEvent =
  | { type: "appended"; append: PromptAppend }
  | { type: "provider-called"; runId: string | undefined }
  | { type: "provider-accepted"; runId: string | undefined }
  | { type: "provider-declined" }
  | { type: "run-ended"; outcome: RunOutcome }
  | { type: "settled" };

/**
 * One prompt's runtime evidence. Await/catch retain the prompt's original result;
 * neither that result nor an error implies exposure. Observers run synchronously
 * and replay earlier facts, so subscribing after a synchronous append loses none.
 * Observers must not throw. A continuation or duplicate can settle without append.
 */
export class PromptDeliveryReceipt implements Promise<void> {
  readonly [Symbol.toStringTag] = "PromptDeliveryReceipt";
  private readonly result: Promise<void>;
  private readonly events: PromptDeliveryEvent[] = [];
  private observers = new Set<(event: PromptDeliveryEvent) => void>();
  append: PromptAppend | undefined;
  /** Also set for a continuation, which deliberately appends no user entry. */
  runId: string | undefined;
  provider: "not-called" | "called" | "accepted" | "declined" = "not-called";
  providerRunId: string | undefined;
  outcome: RunOutcome | undefined;
  settled = false;
  refusedBeforeAppend = false;
  duplicate = false;
  private acceptedRunId: string | undefined;

  /** A late acceptance cannot attribute exposure to the run that closed first. */
  get exposure(): "none" | "accepted" | "unknown" {
    if (this.provider === "not-called" || this.provider === "declined")
      return "none";
    if (!this.append) return "unknown";
    if (this.append.accepted)
      return this.append.joined && this.providerRunId !== this.append.runId
        ? "unknown"
        : "accepted";
    return this.provider === "accepted" &&
      this.acceptedRunId !== undefined &&
      this.acceptedRunId === this.append.runId
      ? "accepted"
      : "unknown";
  }

  get boundOutcome(): RunOutcome | undefined {
    return this.exposure === "accepted" ? this.outcome : undefined;
  }

  constructor(run: (receipt: PromptDeliveryReceipt) => Promise<void>) {
    this.result = (async () => {
      try {
        await run(this);
      } catch (error) {
        this.refusedBeforeAppend = this.append === undefined;
        throw error;
      } finally {
        this.settled = true;
        this.emit({ type: "settled" });
        if (!this.runId || this.outcome) this.observers.clear();
      }
    })();
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.result.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<void | TResult> {
    return this.result.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<void> {
    return this.result.finally(onfinally);
  }

  /** `before` is for facade enrichment, preserving its nested append order. */
  observe(
    observer: (event: PromptDeliveryEvent) => void,
    before = false,
  ): () => void {
    for (const event of this.events) observer(event);
    if (!this.settled || (this.runId && !this.outcome))
      this.observers = before
        ? new Set([observer, ...this.observers])
        : this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Runtime writers only. Kept on the receipt so facade enrichment shares it. */
  appended(append: PromptAppend): void {
    this.append = append;
    this.runId = append.runId;
    this.emit({ type: "appended", append });
  }

  providerCalled(runId: string | undefined): void {
    this.provider = "called";
    this.providerRunId = runId;
    this.emit({ type: "provider-called", runId });
  }

  providerAccepted(runId: string | undefined): void {
    this.provider = "accepted";
    this.acceptedRunId = runId;
    this.emit({ type: "provider-accepted", runId });
  }

  providerDeclined(): void {
    this.provider = "declined";
    this.emit({ type: "provider-declined" });
  }

  runEnded(outcome: RunOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.emit({ type: "run-ended", outcome });
    if (this.settled) this.observers.clear();
  }

  private emit(event: PromptDeliveryEvent): void {
    this.events.push(event);
    for (const observer of [...this.observers]) observer(event);
  }
}
