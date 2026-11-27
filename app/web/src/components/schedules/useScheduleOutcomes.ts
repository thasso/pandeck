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
 *
 * `active` is whether the surface is on screen (`useOnScreen`). A surface its
 * frame keeps mounted while hidden is, for ownership, closed: it claims and
 * owns nothing, so a refusal landing then is announced, and revealing it
 * adopts only what is still pending, exactly as a fresh mount would.
 */
export function useScheduleOutcomes(
  candidates: readonly string[],
  mutations: Record<string, LoadState<true>>,
  active = true,
) {
  const joined = candidates.join("\n");
  const [owned, setOwned] = useState<ReadonlySet<string>>(() =>
    active
      ? new Set(candidates.filter((key) => pendingIn(mutations, key)))
      : NOTHING_OWNED,
  );
  useEffect(() => {
    if (!active) {
      if (owned.size > 0) setOwned(NOTHING_OWNED);
      return;
    }
    const adopt = (joined ? joined.split("\n") : []).filter(
      (key) => pendingIn(mutations, key) && !owned.has(key),
    );
    if (adopt.length > 0) setOwned(new Set([...owned, ...adopt]));
  }, [active, joined, mutations, owned]);

  const own = useCallback((key: string) => {
    setOwned((current) =>
      current.has(key) ? current : new Set([...current, key]),
    );
  }, []);

  const claims = useMemo(
    () =>
      active
        ? (joined ? joined.split("\n") : []).filter(
            (key) => owned.has(key) || pendingIn(mutations, key),
          )
        : NO_CLAIMS,
    [active, joined, mutations, owned],
  );

  const errorFor = useCallback(
    (key: string): string | undefined => {
      const mutation = mutations[key];
      if (!active || !owned.has(key) || !mutation || isPending(mutation))
        return undefined;
      return errorOf(mutation);
    },
    [active, mutations, owned],
  );

  return { claims, own, owns: owned, errorFor };
}

const NOTHING_OWNED: ReadonlySet<string> = new Set();
const NO_CLAIMS: readonly string[] = [];

function pendingIn(
  mutations: Record<string, LoadState<true>>,
  key: string,
): boolean {
  const mutation = mutations[key];
  return mutation !== undefined && isPending(mutation);
}
