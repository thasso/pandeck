/**
 * Keeps this iOS installation's APNs device token registered with the server.
 *
 * Runs once per page load and does nothing anywhere else: a browser has Web Push,
 * the macOS shell has the live socket, and only the iOS shell needs a token
 * handed over. Re-registering on every load rather than once is the point —
 * Apple reissues a device token on reinstall or a restored backup, and the
 * server's copy is only as good as the last one it was given.
 *
 * Nothing here is user-visible. It fails silently by design: the fallback for an
 * unregistered installation is exactly the behaviour of the macOS shell (alerts
 * raised over the live socket while the app runs), and Settings is where the state
 * is reported and can be retried. Surfacing an error over the app's first paint
 * would be louder than the thing that went wrong.
 */
import { useEffect } from "react";
import {
  apnsInstallId,
  fetchApnsConfig,
  registerApnsDevice,
  setApnsDeliveryActive,
} from "../lib/apnsPush.ts";
import {
  nativeShellPlatform,
  onNativeApnsToken,
  pushRegistration,
} from "../lib/nativeShell.ts";

export function useApnsRegistration(): void {
  useEffect(() => {
    if (nativeShellPlatform() !== "ios") return;
    let active = true;

    /**
     * Read the whole registration from the shell and hand it over.
     *
     * The token and the environment it belongs to are read TOGETHER, and the
     * arrival event is treated as nothing but "look again": a token sent to the
     * wrong one of Apple's two hosts is rejected as `BadDeviceToken` and nothing
     * more helpful, and pairing the event's payload with a separately-awaited
     * environment is exactly how the two would drift apart.
     */
    const sync = async () => {
      try {
        const registration = await pushRegistration();
        if (!active || !registration?.deviceToken) return;
        const config = await fetchApnsConfig();
        if (!active) return;
        // No key on the server means no push at all, and claiming a registration
        // would silence the live-socket fallback in exchange for nothing.
        if (!config.configured) {
          setApnsDeliveryActive(false);
          return;
        }
        await registerApnsDevice({
          token: registration.deviceToken,
          environment: registration.apnsEnvironment,
          // Identifies the INSTALL, so a token Apple reissued replaces its
          // predecessor instead of registering a second live phone.
          installId: apnsInstallId(),
          label: deviceLabel(),
        });
      } catch {
        if (active) setApnsDeliveryActive(false);
      }
    };

    // Two triggers for one read, because a token normally beats the first paint:
    // whatever arrived during launch is already held by the shell, and the event
    // covers the slower case of Apple answering while the page is up.
    const stop = onNativeApnsToken(() => void sync());
    void sync();

    return () => {
      active = false;
      stop();
    };
  }, []);
}

/** Something recognisable in Settings when more than one device is registered. */
function deviceLabel(): string {
  const platform = navigator.platform || "iOS";
  return `${platform} · ${new Date().toISOString().slice(0, 10)}`;
}
