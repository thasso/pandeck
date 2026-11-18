import { useCallback, useEffect, useState } from "react";
import {
  decodeGatewayUiMe,
  GATEWAY_UI_ATLASSIAN_CONNECT_CODES,
  GATEWAY_UI_CSRF_HEADER,
  GATEWAY_UI_SIGNIN_CODES,
  type GatewayUiAtlassianConnectCode,
  type GatewayUiAtlassianSetRequest,
  type GatewayUiMe,
  type GatewayUiSigninCode,
} from "@assistant/shared/gatewayUi";
import { useFetchState } from "../hooks/useFetchState.ts";
import {
  clearAtlassian,
  createEnrollmentCode,
  decideEnrollment,
  fetchAccounts,
  fetchAtlassian,
  fetchClients,
  fetchRequests,
  lookupEnrollment,
  mintMcpToken,
  removeAccount,
  revokeClient,
  revokeMcpToken,
  setAtlassian,
  startAtlassianConnect,
} from "./gatewayApi.ts";
import {
  GatewayEnrollApproval,
  takeEnrollmentCode,
} from "./GatewayEnrollApproval.tsx";
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

/**
 * The Atlassian callback's `?atlassian=` code (Task-1411). Only a fixed code
 * is kept; any other value is dropped unread, never shown.
 */
function atlassianCode(
  search: string,
): GatewayUiAtlassianConnectCode | undefined {
  const code = new URLSearchParams(search).get("atlassian");
  return code !== null &&
    (GATEWAY_UI_ATLASSIAN_CONNECT_CODES as readonly string[]).includes(code)
    ? (code as GatewayUiAtlassianConnectCode)
    : undefined;
}

export function GatewayApp({
  reload = () => window.location.reload(),
}: {
  /** After sign-out; tests observe it. */
  reload?: () => void;
}) {
  // A machine's `#enroll=` code leaves the address before the first fetch.
  const [enrollCode, setEnrollCode] = useState(takeEnrollmentCode);
  useEffect(() => {
    const onHashChange = () => {
      const code = takeEnrollmentCode();
      if (code) setEnrollCode(code);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  // The callback's code is read once and leaves the address; the kept code
  // outlives the `/api/me` load that decides where it shows.
  const [connectCode] = useState(() => atlassianCode(window.location.search));
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const query = new URLSearchParams(search);
    if (!query.has("atlassian")) return;
    query.delete("atlassian");
    const rest = query.toString();
    window.history.replaceState(
      window.history.state,
      "",
      pathname + (rest ? `?${rest}` : "") + hash,
    );
  }, []);
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

  const closeEnrollment = useCallback(
    (approved: boolean) => {
      setEnrollCode(null);
      if (approved) reloadClients();
    },
    [reloadClients],
  );

  const signin = signinCode(window.location.search);
  const page: GatewayPageState =
    state.status === "error"
      ? { kind: "unavailable" }
      : state.status === "ready" || state.status === "refreshing"
        ? state.data
          ? { kind: "signedIn", me: state.data }
          : {
              kind: "signedOut",
              ...(signin ? { signin } : {}),
              ...(connectCode === "signed_out"
                ? { atlassianSignedOut: true }
                : {}),
              ...(enrollCode ? { enrollmentWaiting: true } : {}),
            }
        : { kind: "loading" };

  return (
    <>
      <GatewayPage
        state={page}
        onSignOut={signOut}
        signingOut={signingOut}
        accounts={{ accounts, login, remove }}
        atlassian={{
          status: atlassian,
          save: saveAtlassian,
          clear: removeAtlassian,
          connect: startAtlassianConnect,
          callback: connectCode,
        }}
        clients={clientsProps}
        requests={{ fetchRequests }}
      />
      {page.kind === "signedIn" && enrollCode ? (
        <GatewayEnrollApproval
          key={enrollCode}
          userCode={enrollCode}
          email={page.me.email}
          lookup={lookupEnrollment}
          decide={decideEnrollment}
          onClose={closeEnrollment}
        />
      ) : null}
    </>
  );
}
