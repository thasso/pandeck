/**
 * A periodic memory line in the service log, so growth is visible over days:
 * `rss` is what the host pays, `heapUsed` what JavaScript holds, and the gap
 * between them is native memory (allocator arenas, addons, buffers). A steady
 * climb is a leak; a plateau well above the heap is retained native memory.
 *
 * The line names its `runtime`: Bun in production, Node in development. The
 * heap figures are the engine's own, JavaScriptCore's under Bun and V8's under
 * Node, which count and report their heaps differently. Only `rss` compares
 * across the two runtimes.
 */
const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)}MB`;
}

const RUNTIME = process.versions.bun
  ? `bun-${process.versions.bun}`
  : `node-${process.versions.node}`;

export function memoryLogLine(usage = process.memoryUsage()): string {
  return `[memory] runtime=${RUNTIME} rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)} heapTotal=${mb(usage.heapTotal)} external=${mb(usage.external)} arrayBuffers=${mb(usage.arrayBuffers)}`;
}

export function startMemoryLog(): void {
  const timer = setInterval(
    () => console.info(memoryLogLine()),
    MEMORY_LOG_INTERVAL_MS,
  );
  timer.unref();
}
