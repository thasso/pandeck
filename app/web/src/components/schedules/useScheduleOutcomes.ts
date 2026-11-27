import { useCallback, useEffect, useMemo, useState } from "react";
import { errorOf, isPending, type LoadState } from "../../lib/loadState.ts";

/**
 * The Schedule write outcomes one mounted surface owns, among the control
 * keys it renders (`docs/schedules.md`, Web; `docs/messaging.md`, control
 * claims). A key is owned once this surface sent its write, or once it saw
 * that write pending, at mount included: a surface reopened while a write is
 * in flight adopts its outcome. A refusal that landed before this surface
 * mounted is not owned, so it is never shown again here; it was already shown
 * or announced.
 *
 * `claims` is exactly what the surface would render: the owned keys and the
 * pending ones it is about to adopt. Claiming a key it cannot render would
 * leave a refusal neither shown nor announced.
 */
export function useScheduleOutcomes(
  candidates: readonly string[],
  mutations: Record<string, LoadState<true>>,
) {
  const joined = candidates.join("\n");
  const [owned, setOwned] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter((key) => pendingIn(mutations, key))),
  );
  useEffect(() => {
    const adopt = (joined ? joined.split("\n") : []).filter(
      (key) => pendingIn(mutations, key) && !owned.has(key),
    );
    if (adopt.length > 0) setOwned(new Set([...owned, ...adopt]));
  }, [joined, mutations, owned]);

  const own = useCallback((key: string) => {
    setOwned((current) =>
      current.has(key) ? current : new Set([...current, key]),
    );
  }, []);

  const claims = useMemo(
    () =>
      (joined ? joined.split("\n") : []).filter(
        (key) => owned.has(key) || pendingIn(mutations, key),
      ),
    [joined, mutations, owned],
  );

  const errorFor = useCallback(
    (key: string): string | undefined => {
      const mutation = mutations[key];
      if (!owned.has(key) || !mutation || isPending(mutation)) return undefined;
      return errorOf(mutation);
    },
    [mutations, owned],
  );

  return { claims, own, owns: owned, errorFor };
}

function pendingIn(
  mutations: Record<string, LoadState<true>>,
  key: string,
): boolean {
  const mutation = mutations[key];
  return mutation !== undefined && isPending(mutation);
}
