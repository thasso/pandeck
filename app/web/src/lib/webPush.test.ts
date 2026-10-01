import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationServerKeyBytes,
  serializeWebPushSubscription,
  webPushBrowserSupport,
} from "./webPush.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Declarative Web Push browser helpers", () => {
  it("decodes URL-safe VAPID public keys", () => {
    vi.stubGlobal("window", { atob });
    expect([...applicationServerKeyBytes("AQID-_8")]).toEqual([
      1, 2, 3, 251, 255,
    ]);
  });

  it("serializes only the server-required subscription capability fields", () => {
    const subscription = {
      endpoint: "https://push.example.test/one",
      toJSON: () => ({
        endpoint: "https://push.example.test/one",
        expirationTime: null,
        keys: { p256dh: "public-key", auth: "auth-key" },
      }),
    } as unknown as PushSubscription;

    expect(serializeWebPushSubscription(subscription)).toEqual({
      endpoint: "https://push.example.test/one",
      keys: { p256dh: "public-key", auth: "auth-key" },
    });
  });

  it("requires the window-level Declarative PushManager", () => {
    vi.stubGlobal("window", {
      isSecureContext: true,
      Notification: {},
      pushManager: { getSubscription: vi.fn() },
    });
    expect(webPushBrowserSupport().supported).toBe(true);

    vi.stubGlobal("window", { isSecureContext: true, Notification: {} });
    const unsupported = webPushBrowserSupport();
    expect(unsupported.supported).toBe(false);
    if (!unsupported.supported)
      expect(unsupported.reason).toMatch(/Home Screen/);
  });
});
