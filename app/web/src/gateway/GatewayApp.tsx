import { useCallback, useState } from "react";
import {
  decodeGatewayUiMe,
  GATEWAY_UI_CSRF_HEADER,
  GATEWAY_UI_SIGNIN_CODES,
  type GatewayUiAtlassianSetRequest,
  type GatewayUiMe,
  type GatewayUiSigninCode,
} from "@assistant/shared/gatewayUi";
import { useFetchState } from "../hooks/useFetchState.ts";
import {
  clearAtlassian,
  createEnrollmentCode,
  fetchAccounts,
  fetchAtlassian,
  fetchClients,
  mintMcpToken,
  removeAccount,
  revokeClient,
  revokeMcpToken,
  setAtlassian,
} from "./gatewayApi.ts";
import { GatewayPage, type GatewayPageState } from "./GatewayPage.tsx";
import { useGatewayLogin } from "./useGatewayLogin.ts";

/**
 * The signed-in user, or null when signed out. The page talks only to its own
 * origin with its session cookie: it has no Pandeck token and no
 * `serverOrigin`.
 */
async function fetchMe(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiMe | null> {
  const response = await fetch("/api/me", {
    credentials: "same-origin",
    signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("unavailable");
  const me = decodeGatewayUiMe(await response.json());
  if (!me) throw new Error("unavailable");
  return me;
}

/** The callback's `?signin=` code; an unknown one reads as `failed`. */
function signinCode(search: string): GatewayUiSigninCode | undefined {
  const code = new URLSearchParams(search).get("signin");
  if (code === null) return undefined;
  return (GATEWAY_UI_SIGNIN_CODES as readonly string[]).includes(code)
    ? (code as GatewayUiSigninCode)
    : "failed";
}

export function GatewayApp({
  reload = () => window.location.reload(),
}: {
  /** After sign-out; tests observe it. */
  reload?: () => void;
}) {
  const { state } = useFetchState("me", fetchMe);
  const [signingOut, setSigningOut] = useState(false);
  const signedIn =
    (state.status === "ready" || state.status === "refreshing") &&
    state.data !== null;
  const { state: accounts, reload: reloadAccounts } = useFetchState(
    signedIn ? "accounts" : null,
    fetchAccounts,
  );
  const { state: atlassian, reload: reloadAtlassian } = useFetchState(
    signedIn ? "atlassian" : null,
    fetchAtlassian,
  );
  const { state: clients, reload: reloadClients } = useFetchState(
    signedIn ? "clients" : null,
    fetchClients,
  );
  const login = useGatewayLogin(reloadAccounts);
  const saveAtlassian = useCallback(
    async (request: GatewayUiAtlassianSetRequest) => {
      const answer = await setAtlassian(request);
      reloadAtlassian();
      return answer;
    },
    [reloadAtlassian],
  );
  const removeAtlassian = useCallback(async () => {
    await clearAtlassian();
    reloadAtlassian();
  }, [reloadAtlassian]);
  /** A client mutation, then the list again, whether or not it was done. */
  const thenReload = useCallback(
    <T,>(run: Promise<T>): Promise<T> => run.finally(reloadClients),
    [reloadClients],
  );
  const clientsProps = {
    clients,
    createCode: createEnrollmentCode,
    revoke: (clientId: string) => thenReload(revokeClient(clientId)),
    mintMcpToken: (clientId: string) => thenReload(mintMcpToken(clientId)),
    revokeMcpToken: (clientId: string) => thenReload(revokeMcpToken(clientId)),
    reload: reloadClients,
  };
  const remove = useCallback(
    async (accountId: string) => {
      await removeAccount(accountId);
      reloadAccounts();
    },
    [reloadAccounts],
  );

  const signOut = useCallback(() => {
    setSigningOut(true);
    void fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { [GATEWAY_UI_CSRF_HEADER]: "1" },
    })
      .catch(() => undefined)
      .then(reload);
  }, [reload]);

  const signin = signinCode(window.location.search);
  const page: GatewayPageState =
    state.status === "error"
      ? { kind: "unavailable" }
      : state.status === "ready" || state.status === "refreshing"
        ? state.data
          ? { kind: "signedIn", me: state.data }
          : { kind: "signedOut", ...(signin ? { signin } : {}) }
        : { kind: "loading" };

  return (
    <GatewayPage
      state={page}
      onSignOut={signOut}
      signingOut={signingOut}
      accounts={{ accounts, login, remove }}
      atlassian={{
        status: atlassian,
        save: saveAtlassian,
        clear: removeAtlassian,
      }}
      clients={clientsProps}
    />
  );
}
