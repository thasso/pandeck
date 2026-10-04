import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { apiPathSkipsAuth } from "./apiAuthPolicy.ts";
import { handleGoogleOAuthPrepare } from "./googleOAuthApi.ts";

const createUrl = vi.hoisted(() => vi.fn());
vi.mock("./googleSettings.ts", () => ({
  createGoogleOAuthStartUrl: createUrl,
}));
afterEach(() => createUrl.mockReset());

function request(method: string) {
  const writeHead = vi.fn();
  const end = vi.fn();
  handleGoogleOAuthPrepare(
    { method } as IncomingMessage,
    { writeHead, end } as unknown as ServerResponse,
    { "content-type": "application/json" },
    "https://assistant.example",
  );
  return { writeHead, end };
}

test("native preparation is not exempt from token or origin checks", () => {
  expect(apiPathSkipsAuth("/api/google/oauth/prepare")).toBe(false);
});

test("POST uses the server's public origin and prevents caching state", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture";
  createUrl.mockReturnValue(url);
  const res = request("POST");
  expect(createUrl).toHaveBeenCalledExactlyOnceWith(
    "https://assistant.example",
  );
  expect(res.writeHead).toHaveBeenCalledWith(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  expect(JSON.parse(res.end.mock.calls[0]![0] as string)).toEqual({ url });
});

test("GET cannot replace the pending OAuth state", () => {
  const res = request("GET");
  expect(res.writeHead).toHaveBeenCalledWith(
    405,
    expect.objectContaining({ allow: "POST" }),
  );
  expect(createUrl).not.toHaveBeenCalled();
});

test("preparation errors expose no private details", () => {
  createUrl.mockImplementation(() => {
    throw new Error("private details");
  });
  const res = request("POST");
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  expect(res.end).toHaveBeenCalledWith(
    JSON.stringify({ error: "Could not start Google sign-in." }),
  );
});
