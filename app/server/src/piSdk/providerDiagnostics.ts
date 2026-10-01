/** Provider diagnostics that pi attaches to terminal assistant messages. */
export function unexpectedProviderAbortError(
  message: unknown,
  explicitAbortRequested: boolean,
): string | undefined {
  if (explicitAbortRequested) return undefined;
  const errorMessage = (message as { errorMessage?: unknown } | null)
    ?.errorMessage;
  return typeof errorMessage === "string" && errorMessage.trim()
    ? errorMessage
    : "Provider request was aborted unexpectedly.";
}

/** Extract the transport facts that explain a retry from pi's failed message. */
export function providerTransportDetails(message: unknown): {
  phase?: string;
  requestBytes?: number;
} {
  const diagnostics = (message as { diagnostics?: unknown } | null)
    ?.diagnostics;
  if (!Array.isArray(diagnostics)) return {};
  for (const diagnostic of diagnostics) {
    const d = diagnostic as {
      kind?: unknown;
      type?: unknown;
      title?: unknown;
      details?: unknown;
    };
    if (
      d.kind !== "provider_transport_failure" &&
      d.type !== "provider_transport_failure" &&
      d.title !== "provider_transport_failure"
    )
      continue;
    const details = d.details as { phase?: unknown; requestBytes?: unknown };
    return {
      ...(typeof details?.phase === "string" ? { phase: details.phase } : {}),
      ...(typeof details?.requestBytes === "number"
        ? { requestBytes: details.requestBytes }
        : {}),
    };
  }
  return {};
}
