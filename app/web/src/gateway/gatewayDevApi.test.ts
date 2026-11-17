/**
 * The dev server's "Sign in with Atlassian" (Task-1411) stays on localhost:
 * the serve-only plugin replaces `navigate.ts`, and that replacement turns the
 * start answer (which the shared decoder still pins to Atlassian) into this
 * server's callback, which finishes a fake sign-in. No network, no browser.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { decodeGatewayUiAtlassianConnectStart } from "@assistant/shared/gatewayUi";
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
    location?: string;
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
function devGoTo(url: string): string[] {
  const went: string[] = [];
  const window = { location: { assign: (to: string) => went.push(to) } };
  const goTo = new Function(
    "window",
    `${DEV_NAVIGATE.replace("export const goTo =", "return")}`,
  )(window) as (url: string) => void;
  goTo(url);
  return went;
}

afterEach(() => vi.unstubAllEnvs());

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

  const went = devGoTo(decoded!.authorizeUrl);
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
