/**
 * The dev server's "Sign in with Atlassian" (Task-1411) and "Sign in with
 * Slack" (Task-1453) stay on localhost: the serve-only plugin replaces
 * `navigate.ts`, and that replacement turns each start answer (which the
 * shared decoder still pins to its provider) into this server's callback for
 * that provider, which finishes a fake sign-in. No network, no browser.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  decodeGatewayUiAtlassianConnectStart,
  decodeGatewayUiSlack,
  decodeGatewayUiSlackConnectStart,
} from "@assistant/shared/gatewayUi";
import { afterEach, expect, test, vi } from "vitest";
import { DEV_NAVIGATE, gatewayDevApi } from "../../gatewayDevApi.ts";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

const NAVIGATE = fileURLToPath(new URL("./navigate.ts", import.meta.url));

function devServer() {
  const plugin = gatewayDevApi();
  let handler!: Handler;
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: { use: (fn: Handler) => (handler = fn) },
  });
  return { plugin, handler };
}

/** One request through the dev middleware; answers status, headers and body. */
function request(handler: Handler, method: string, url: string) {
  return new Promise<{
    status: number;
    location?: string | undefined;
    body?: unknown;
  }>((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method, url });
    const headers = new Map<string, string>();
    const res = {
      statusCode: 200,
      setHeader: (name: string, value: string) => headers.set(name, value),
      end(raw?: string) {
        resolve({
          status: this.statusCode,
          location: headers.get("location"),
          body: raw ? JSON.parse(raw) : undefined,
        });
      },
    };
    handler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      () => reject(new Error(`not handled: ${url}`)),
    );
    if (method === "POST") {
      req.emit("data", "{}");
      req.emit("end");
    }
  });
}

/** The dev `goTo`, run against a stand-in window; answers where it went. */
async function devGoTo(url: string): Promise<string[]> {
  const went: string[] = [];
  vi.stubGlobal("window", {
    location: { assign: (to: string) => went.push(to) },
  });
  const source = Buffer.from(DEV_NAVIGATE).toString("base64");
  const { goTo } = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${source}`
  )) as { goTo: (url: string) => void };
  goTo(url);
  return went;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the plugin serves only and replaces navigate.ts alone", () => {
  const { plugin } = devServer();
  expect(plugin.apply).toBe("serve");
  const load = plugin.load as (id: string) => string | null;
  expect(load(NAVIGATE)).toBe(DEV_NAVIGATE);
  expect(load(`${NAVIGATE}?t=1`)).toBe(DEV_NAVIGATE);
  expect(load(NAVIGATE.replace("navigate.ts", "gatewayApi.ts"))).toBeNull();
});

test("Sign in with Atlassian on the dev page ends on the dev callback, signed in", async () => {
  vi.stubEnv("GATEWAY_DEV_GENERIC", "");
  const { handler } = devServer();
  const start = await request(
    handler,
    "POST",
    "/api/integrations/atlassian/connect",
  );
  // The page's own decoder still accepts the answer.
  const decoded = decodeGatewayUiAtlassianConnectStart(start.body);
  expect(decoded).toBeDefined();

  const went = await devGoTo(decoded!.authorizeUrl);
  expect(went).toHaveLength(1);
  const target = new URL(went[0]!, "http://localhost:5180");
  // A path on this server: the browser never leaves localhost.
  expect(went[0]!.startsWith("/")).toBe(true);
  expect(target.origin).toBe("http://localhost:5180");
  expect(target.pathname).toBe("/auth/atlassian/callback");
  expect(target.searchParams.get("state")).toBe("FAKE_DEV_STATE");

  const back = await request(
    handler,
    "GET",
    `${target.pathname}${target.search}`,
  );
  expect(back).toMatchObject({ status: 303, location: "/" });
  const status = await request(handler, "GET", "/api/integrations/atlassian");
  expect(status.body).toMatchObject({
    connected: true,
    kind: "oauth",
    connectWith: "oauth",
  });
});

test("Sign in with Slack on the dev page ends on the Slack dev callback, connected", async () => {
  vi.stubEnv("GATEWAY_DEV_NO_SLACK", "");
  const { handler } = devServer();
  const before = await request(handler, "GET", "/api/integrations/slack");
  expect(decodeGatewayUiSlack(before.body)).toEqual({
    offered: true,
    connected: false,
  });
  const start = await request(
    handler,
    "POST",
    "/api/integrations/slack/connect",
  );
  const decoded = decodeGatewayUiSlackConnectStart(start.body);
  expect(decoded).toBeDefined();

  const went = await devGoTo(decoded!.authorizeUrl);
  expect(went).toHaveLength(1);
  expect(went[0]!.startsWith("/")).toBe(true);
  const target = new URL(went[0]!, "http://localhost:5180");
  expect(target.pathname).toBe("/auth/slack/callback");
  expect(target.searchParams.get("state")).toBe("FAKE_DEV_STATE");

  const back = await request(
    handler,
    "GET",
    `${target.pathname}${target.search}`,
  );
  expect(back).toMatchObject({ status: 303, location: "/" });
  const status = await request(handler, "GET", "/api/integrations/slack");
  expect(decodeGatewayUiSlack(status.body)).toMatchObject({
    offered: true,
    connected: true,
  });
  // Atlassian's record is untouched by the Slack sign-in.
  const atlassian = await request(
    handler,
    "GET",
    "/api/integrations/atlassian",
  );
  expect(atlassian.body).toMatchObject({ kind: "token" });
});

test("each provider's authorize URL goes to its own dev callback", async () => {
  const [atlassian] = await devGoTo(
    "https://auth.atlassian.com/authorize?state=A_STATE",
  );
  const [slack] = await devGoTo(
    "https://slack.com/oauth/v2/authorize?state=S_STATE",
  );
  expect(new URL(atlassian!, "http://dev").pathname).toBe(
    "/auth/atlassian/callback",
  );
  expect(new URL(slack!, "http://dev").pathname).toBe("/auth/slack/callback");
  expect(new URL(slack!, "http://dev").searchParams.get("state")).toBe(
    "S_STATE",
  );
});

test("a dev callback's ?slack= code replays a failure; GATEWAY_DEV_NO_SLACK hides Slack", async () => {
  const { handler } = devServer();
  expect(
    await request(handler, "GET", "/auth/slack/callback?slack=team_mismatch"),
  ).toMatchObject({ status: 303, location: "/?slack=team_mismatch" });
  vi.stubEnv("GATEWAY_DEV_NO_SLACK", "1");
  const status = await request(handler, "GET", "/api/integrations/slack");
  expect(status.body).toEqual({ offered: false, connected: false });
  expect(
    await request(handler, "POST", "/api/integrations/slack/connect"),
  ).toMatchObject({ status: 404 });
});
