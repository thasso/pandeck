import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * DEV ONLY: a fake gateway `/api` and `/auth` for `pnpm dev:gateway`, so the
 * page renders with sample data without Google sign-in or a vault. State is
 * in memory and resets on restart. Never part of a build.
 */
export function gatewayDevApi(): Plugin {
  let signedIn = true;
  let accounts = [
    { id: "a1", provider: "claude", name: "Claude Max", needsLogin: false },
    {
      id: "a2",
      provider: "openai-codex",
      name: "ChatGPT Pro",
      needsLogin: true,
    },
  ];
  // The Castlabs deployment fixes site and email; GATEWAY_DEV_GENERIC=1 shows
  // the generic gateway, where the user enters both.
  const presetOf = () =>
    process.env.GATEWAY_DEV_GENERIC === "1"
      ? {}
      : {
          preset: {
            site: "castlabs.atlassian.net",
            email: "thasso.griebel@castlabs.com",
          },
        };
  let atlassian: Record<string, unknown> = {
    connected: true,
    site: "castlabs.atlassian.net",
    email: "thasso.griebel@castlabs.com",
    displayName: "Thasso Griebel",
  };
  let clients = [
    {
      id: "c_1",
      label: "Laptop",
      createdAt: Date.now() - 86400e3 * 3,
      mcpToken: true,
    },
    {
      id: "c_2",
      label: "pandeck-pilot",
      createdAt: Date.now() - 3600e3,
      mcpToken: false,
    },
  ];
  // One pending machine: open `/#enroll=BCDF-GHJK` to approve or deny it.
  let enrollment: { decided: boolean; createdAt: number } = {
    decided: false,
    createdAt: Date.now(),
  };
  const DEV_USER_CODE = "BCDFGHJK";
  const devCode = (value: unknown) =>
    typeof value === "string" &&
    value.replace(/[-\s]/g, "").toUpperCase() === DEV_USER_CODE;
  const logins = new Map<
    string,
    { kind: string; reads: number; input: boolean; cancelled: boolean }
  >();
  let n = 0;

  const json = (res: ServerResponse, status: number, body?: unknown): void => {
    res.statusCode = status;
    if (body === undefined) {
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const bodyOf = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });

  return {
    name: "gateway-dev-api",
    apply: "serve",
    configureServer(server) {
      const handle = async (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void,
      ): Promise<void> => {
        const url = new URL(req.url ?? "/", "http://dev");
        const path = url.pathname;
        if (path === "/") {
          req.url = "/gateway.html" + url.search;
          return next();
        }
        if (path === "/auth/login") {
          signedIn = true;
          res.statusCode = 303;
          res.setHeader("location", "/");
          res.end();
          return;
        }
        if (path === "/auth/logout") {
          signedIn = false;
          return json(res, 204);
        }
        if (!path.startsWith("/api/")) return next();
        if (!signedIn) return json(res, 401, { error: "unauthorized" });
        const body = req.method === "POST" ? await bodyOf(req) : {};
        // Small delay so loading states are visible.
        await new Promise((r) => setTimeout(r, 250));

        switch (path) {
          case "/api/me":
            return json(res, 200, {
              userId: "thasso",
              email: "thasso.griebel@castlabs.com",
              label: "thasso",
            });
          case "/api/accounts":
            return json(res, 200, { accounts });
          case "/api/accounts/remove":
            accounts = accounts.filter((a) => a.id !== body.accountId);
            return json(res, 204);
          case "/api/logins/start": {
            const loginId = `L${++n}`;
            let accountId = body.accountId as string | undefined;
            if (!accountId) {
              accountId = `a${100 + n}`;
              accounts.push({
                id: accountId,
                provider: body.kind as string,
                name: (body.name as string) || `New ${String(body.kind)}`,
                needsLogin: true,
              });
            }
            logins.set(loginId, {
              kind: body.kind as string,
              reads: 0,
              input: false,
              cancelled: false,
            });
            setTimeout(() => {
              const a = accounts.find((x) => x.id === accountId);
              if (a) a.needsLogin = false;
            }, 8000);
            return json(res, 200, { loginId, accountId });
          }
          case "/api/logins/read": {
            const l = logins.get(url.searchParams.get("login") ?? "");
            const cursor = Number(url.searchParams.get("cursor") ?? 0);
            if (!l) return json(res, 404, { error: "not_found" });
            l.reads++;
            if (l.cancelled)
              return json(res, 200, { state: "cancelled", output: "", cursor });
            if (l.kind === "openai-codex") {
              const done = l.reads > 12;
              return json(res, 200, {
                state: done ? "ready" : "running",
                output: "",
                cursor,
                device: {
                  verificationUri: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-1234",
                },
              });
            }
            const text =
              cursor === 0
                ? "Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=dev\n\nPaste code here if prompted > "
                : "";
            return json(res, 200, {
              state: l.input ? "ready" : "running",
              output: text,
              cursor: cursor + text.length,
            });
          }
          case "/api/logins/input": {
            const l = logins.get(body.loginId as string);
            if (l) l.input = true;
            return json(res, 204);
          }
          case "/api/logins/cancel": {
            const l = logins.get(body.loginId as string);
            if (l) l.cancelled = true;
            return json(res, 204);
          }
          case "/api/integrations/atlassian":
            return json(res, 200, { ...atlassian, ...presetOf() });
          case "/api/integrations/atlassian/set":
            atlassian = {
              connected: true,
              site: body.site,
              email: body.email,
              displayName: "Dev User",
            };
            return json(res, 200, { ...atlassian, ...presetOf() });
          case "/api/integrations/atlassian/clear":
            atlassian = { connected: false };
            return json(res, 204);
          case "/api/clients":
            return json(res, 200, { clients });
          case "/api/clients/code":
            clients.push({
              id: `c_${++n}`,
              label: (body.label as string) || "New client",
              createdAt: Date.now(),
              mcpToken: false,
            });
            return json(res, 200, {
              code: "DEV-ENROLL-CODE-0000",
              validForSeconds: 600,
            });
          case "/api/clients/revoke":
            clients = clients.filter((c) => c.id !== body.clientId);
            return json(res, 204);
          case "/api/clients/mcp-token": {
            const c = clients.find((x) => x.id === body.clientId);
            if (c) c.mcpToken = true;
            return json(res, 200, { token: "dev-mcp-token-not-real" });
          }
          case "/api/clients/mcp-token/revoke": {
            const c = clients.find((x) => x.id === body.clientId);
            if (c) c.mcpToken = false;
            return json(res, 204);
          }
          case "/api/enrollments/lookup":
            // A fresh request every 10 minutes, so the dialog can be tried again.
            if (Date.now() - enrollment.createdAt > 600e3)
              enrollment = { decided: false, createdAt: Date.now() };
            if (!devCode(body.userCode) || enrollment.decided)
              return json(res, 404, { error: "unknown_request" });
            return json(res, 200, {
              name: "devbox-thasso",
              kind: "devbox",
              from: "100.64.0.7",
              createdAt: enrollment.createdAt,
              expiresAt: enrollment.createdAt + 600e3,
            });
          case "/api/enrollments/decide":
            if (!devCode(body.userCode) || enrollment.decided)
              return json(res, 404, { error: "unknown_request" });
            enrollment.decided = true;
            if (body.approve === true)
              clients.push({
                id: `c_${++n}`,
                label: "devbox-thasso",
                createdAt: Date.now(),
                mcpToken: true,
              });
            return json(res, 204);
          default:
            return json(res, 404, { error: "not_found" });
        }
      };
      server.middlewares.use((req, res, next) => {
        void handle(req, res, next);
      });
    },
  };
}
