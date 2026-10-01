import assert from "node:assert/strict";
import { test } from "vitest";
import {
  backgroundCompletionDisposition,
  type BackgroundDeliveryEvidence,
} from "./deliveryPolicy.ts";

function evidence(
  overrides: Partial<BackgroundDeliveryEvidence> = {},
): BackgroundDeliveryEvidence {
  return {
    backend: "claude-query",
    stopRequested: false,
    ownerTurnRunning: false,
    ...overrides,
  };
}

test("work that settles while nothing is running wakes the session", () => {
  // The parked case: the agent yielded for a monitor or job and nothing else
  // will ever start a turn to collect it.
  assert.deepEqual(backgroundCompletionDisposition(evidence()), {
    disposition: "wake",
    reason: "awaited",
  });
  assert.deepEqual(
    backgroundCompletionDisposition(evidence({ backend: "host-process" })),
    { disposition: "wake", reason: "awaited" },
  );
});

test("a Claude task that settles inside a live turn defers instead of waking", () => {
  // A turn was live to receive whatever the CLI injected for itself, so PA
  // starting its OWN turn is redundant. It defers rather than dropping: the
  // injection is not guaranteed on every terminal path, and a fact the model
  // never learns is worse than a bounded block on the next turn.
  assert.deepEqual(
    backgroundCompletionDisposition(evidence({ ownerTurnRunning: true })),
    { disposition: "defer", reason: "already-in-turn" },
  );
});

test("a pi process that settles inside a live turn still wakes", () => {
  // PA is the ONLY channel for host-process work, and a wake is satisfied by
  // steering into the running turn rather than starting another one.
  assert.deepEqual(
    backgroundCompletionDisposition(
      evidence({ backend: "host-process", ownerTurnRunning: true }),
    ),
    { disposition: "wake", reason: "awaited" },
  );
});

test("a requested Stop never wakes, whoever asked", () => {
  // The agent holds the terminal row its own stop call returned, the human is
  // looking at the UI they clicked, and a frozen-deadline Stop spends a budget
  // the agent set. Deferred rather than dropped: two of the three leave nothing
  // in the agent's transcript, and the policy does not distinguish them.
  for (const backend of ["claude-query", "host-process"] as const)
    for (const ownerTurnRunning of [false, true])
      for (const stopOrigin of [undefined, "requester"] as const)
        assert.deepEqual(
          backgroundCompletionDisposition(
            evidence({
              backend,
              ownerTurnRunning,
              stopRequested: true,
              ...(stopOrigin ? { stopOrigin } : {}),
            }),
          ),
          { disposition: "defer", reason: "stop-requested" },
        );
});

test("a Stop nobody asked for wakes, even inside a live Claude turn", () => {
  // PA killed a monitor the owner believes is still watching. Every other stop
  // has a requester holding the answer; this one has none, so staying silent
  // would leave the agent waiting on a watcher that no longer exists.
  for (const backend of ["claude-query", "host-process"] as const)
    for (const ownerTurnRunning of [false, true])
      assert.deepEqual(
        backgroundCompletionDisposition(
          evidence({
            backend,
            ownerTurnRunning,
            stopRequested: true,
            stopOrigin: "system",
          }),
        ),
        { disposition: "wake", reason: "unrequested-stop" },
      );
});

test("no disposition ever discards a terminal fact", () => {
  // The policy's whole domain: every combination reaches the model somehow.
  // A `drop` outcome would need PROOF the fact is already in the transcript,
  // which this evidence cannot carry — see the module header.
  for (const backend of ["claude-query", "host-process"] as const)
    for (const stopRequested of [false, true])
      for (const ownerTurnRunning of [false, true])
        for (const stopOrigin of ["requester", "system"] as const) {
          const { disposition } = backgroundCompletionDisposition(
            evidence({ backend, stopRequested, ownerTurnRunning, stopOrigin }),
          );
          assert.ok(
            disposition === "wake" || disposition === "defer",
            `${backend}/${stopRequested}/${ownerTurnRunning}/${stopOrigin} must still reach the model`,
          );
        }
});
