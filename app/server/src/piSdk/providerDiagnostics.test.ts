import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  providerTransportDetails,
  unexpectedProviderAbortError,
} from "./providerDiagnostics.ts";

describe("pi provider terminal diagnostics", () => {
  it("retains a provider abort error unless the runtime explicitly stopped it", () => {
    const message = {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    };
    assert.equal(
      unexpectedProviderAbortError(message, false),
      "Request was aborted",
    );
    assert.equal(unexpectedProviderAbortError(message, true), undefined);
  });

  it("uses a durable fallback when pi aborts without an error message", () => {
    assert.equal(
      unexpectedProviderAbortError(
        { role: "assistant", stopReason: "aborted" },
        false,
      ),
      "Provider request was aborted unexpectedly.",
    );
  });

  it("extracts the transport failure facts attached to pi's failed message", () => {
    assert.deepEqual(
      providerTransportDetails({
        diagnostics: [
          { type: "other_diagnostic", details: { phase: "ignored" } },
          {
            type: "provider_transport_failure",
            details: {
              phase: "after_message_stream_start",
              requestBytes: 618_782,
            },
          },
        ],
      }),
      { phase: "after_message_stream_start", requestBytes: 618_782 },
    );
  });
});
