/**
 * Structural equality for JSON wire values; Task summaries contain no cycles.
 *
 * A property whose value is `undefined` counts as ABSENT, because that is what
 * it is on the wire: `JSON.stringify` drops it. Optimistic projections are built
 * with spreads that leave such keys behind (`completedAt: undefined` when a Task
 * leaves `done`), and treating them as a difference would make the authoritative
 * echo of an unchanged row replace it — the one thing this comparison exists to
 * prevent.
 */
export function wireValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null) return false;
  if (typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => wireValueEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = definedKeys(leftRecord);
  return (
    keys.length === definedKeys(rightRecord).length &&
    keys.every((key) => wireValueEqual(leftRecord[key], rightRecord[key]))
  );
}

function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined);
}
