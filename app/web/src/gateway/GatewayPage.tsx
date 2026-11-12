import type {
  GatewayUiMe,
  GatewayUiSigninCode,
} from "@assistant/shared/gatewayUi";
import { ErrorNote, PaneLoading } from "../components/common/load.tsx";
import { LinkButton } from "../components/common/LinkButton.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import {
  GatewayAccounts,
  type GatewayAccountsProps,
} from "./GatewayAccounts.tsx";
import {
  GatewayAtlassian,
  type GatewayAtlassianProps,
} from "./GatewayAtlassian.tsx";
import { GatewayClients, type GatewayClientsProps } from "./GatewayClients.tsx";

export type GatewayPageState =
  | { kind: "loading" }
  | { kind: "signedOut"; signin?: GatewayUiSigninCode }
  | { kind: "signedIn"; me: GatewayUiMe }
  | { kind: "unavailable" };

/** Fixed text per sign-in code; nothing from the URL is shown. */
const SIGNIN_TEXT: Record<GatewayUiSigninCode, string> = {
  denied: "This account may not use this gateway.",
  expired:
    "The sign-in took too long or was started in another browser. Sign in again.",
  failed: "The sign-in did not complete. Try again.",
  busy: "The gateway has too many sign-ins right now. Try again in a few minutes.",
};

export interface GatewayPageProps {
  state: GatewayPageState;
  onSignOut: () => void;
  signingOut: boolean;
  /** The signed-in user's accounts and logins. */
  accounts?: GatewayAccountsProps | undefined;
  /** The signed-in user's Atlassian credential (Task-1405). */
  atlassian?: GatewayAtlassianProps | undefined;
  /** The signed-in user's clients and MCP tokens (Task-1405). */
  clients?: GatewayClientsProps | undefined;
}

/**
 * The gateway's own page (Task-1402, Task-1405): sign in with the
 * deployment's provider, see who you are, your accounts, your Jira credential
 * and your clients, sign out. Its own entry, served by the
 * edge; no Pandeck store, socket, router or token.
 */
export function GatewayPage({
  state,
  onSignOut,
  signingOut,
  accounts,
  atlassian,
  clients,
}: GatewayPageProps) {
  const signedIn = state.kind === "signedIn";
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4 text-foreground">
      <Card className={signedIn ? "w-full max-w-2xl" : "w-full max-w-md"}>
        <CardHeader>
          <CardTitle>Pandeck gateway</CardTitle>
          <CardDescription>
            Your accounts, logins and clients for Pandeck.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.kind === "loading" ? <PaneLoading /> : null}
          {state.kind === "unavailable" ? (
            <ErrorNote message="The gateway cannot answer right now. Reload the page to try again." />
          ) : null}
          {state.kind === "signedOut" && state.signin ? (
            <ErrorNote message={SIGNIN_TEXT[state.signin]} />
          ) : null}
          {state.kind === "signedOut" ? (
            <p className="text-sm text-muted-foreground">
              Sign in to continue.
            </p>
          ) : null}
          {state.kind === "signedIn" ? (
            <p className="text-sm">
              Signed in as <span className="font-medium">{state.me.email}</span>
            </p>
          ) : null}
          {state.kind === "signedIn" && accounts ? (
            <GatewayAccounts {...accounts} />
          ) : null}
          {state.kind === "signedIn" && atlassian ? (
            <GatewayAtlassian {...atlassian} />
          ) : null}
          {state.kind === "signedIn" && clients ? (
            <GatewayClients {...clients} />
          ) : null}
        </CardContent>
        {state.kind === "signedOut" ? (
          <CardFooter>
            <LinkButton variant="default" size="default" href="/auth/login">
              Sign in
            </LinkButton>
          </CardFooter>
        ) : null}
        {state.kind === "signedIn" ? (
          <CardFooter>
            <Button variant="outline" busy={signingOut} onClick={onSignOut}>
              Sign out
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
