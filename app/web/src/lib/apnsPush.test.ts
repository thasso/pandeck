// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  apnsDeliveryActive,
  setApnsDeliveryActive,
  shouldRaiseAppNotification,
} from "./apnsPush.ts";

/**
 * The one decision worth a test here: which runtime acts on a socket-delivered
 * alert. Getting it wrong is not a crash — it is either a finished turn that
 * notifies twice, or one that notifies not at all, and neither shows up anywhere
 * but on the user's phone.
 */
describe("shouldRaiseAppNotification", () => {
  beforeEach(() => setApnsDeliveryActive(false));
  afterEach(() => {
    document.documentElement.removeAttribute("data-native-shell");
    setApnsDeliveryActive(false);
  });

  test("is nobody's job in a browser, which has its own Web Push subscription", () => {
    expect(shouldRaiseAppNotification()).toBe(false);
  });

  test("is the macOS shell's job, which has no push route at all", () => {
    document.documentElement.setAttribute("data-native-shell", "macos");
    expect(shouldRaiseAppNotification()).toBe(true);
  });

  test("is the iOS shell's job only until its APNs registration takes", () => {
    document.documentElement.setAttribute("data-native-shell", "ios");
    expect(shouldRaiseAppNotification()).toBe(true);
    setApnsDeliveryActive(true);
    // Apple now delivers the same alert; raising the socket copy too is what
    // makes every finished turn buzz twice.
    expect(shouldRaiseAppNotification()).toBe(false);
    expect(apnsDeliveryActive()).toBe(true);
  });
});
