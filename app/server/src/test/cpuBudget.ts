/**
 * CPU-time measurement for the suite's algorithmic-cost guards.
 *
 * Those guards exist to catch a function that went quadratic, and a wall clock
 * cannot tell that apart from a busy machine. The memory selector's 3,000-card
 * fixture takes 16ms of wall clock on an idle box; on a loaded one, three runs
 * of it measured 17ms, 113ms and 188ms — against the 250ms bound it was
 * asserted on. `process.cpuUsage()` counts only the time this process actually
 * spent on a core, and over those same three runs that was 26.5ms, 28.6ms and
 * 31.0ms. That is stable enough to assert on, because the regressions these
 * guards care about are multiples rather than margins.
 *
 * Two things it counts that a stopwatch in the test does not, which is why the
 * CPU figure above is larger than the idle wall clock: kernel time, and every
 * thread in the process — V8's parallel GC included.
 *
 * The narrowing is deliberate in the other direction: waiting on disk, on a
 * child process or on a timer costs no CPU, so measure only CPU-bound work
 * this way, and assert an ordering where the work is not.
 */

function elapsedCpuMs(since: NodeJS.CpuUsage): number {
  const used = process.cpuUsage(since);
  return (used.user + used.system) / 1000;
}

export function measureCpuMs<T>(run: () => T): { value: T; cpuMs: number } {
  const since = process.cpuUsage();
  const value = run();
  return { value, cpuMs: elapsedCpuMs(since) };
}

export async function measureCpuMsAsync<T>(
  run: () => Promise<T>,
): Promise<{ value: T; cpuMs: number }> {
  const since = process.cpuUsage();
  const value = await run();
  return { value, cpuMs: elapsedCpuMs(since) };
}
