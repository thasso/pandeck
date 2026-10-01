/**
 * `pnpm run check:apns` — is the stored Apple Push credential usable?
 *
 * Run on the machine that will do the pushing, BEFORE any device has registered,
 * because that is when the answer is least discoverable: with no device the
 * settings page's test has nothing to push to, and every way of getting the
 * credential wrong comes back from Apple as one opaque string.
 *
 * It reads the credential exactly as the server does — same file resolution, same
 * validation, same JWT — so a pass here means the server will authenticate. The
 * network probe pushes to a device token that belongs to nobody: Apple checks the
 * provider token first, so being told the DEVICE is bad is the success case.
 */
import { createPrivateKey } from "node:crypto";
import { APNS_CREDENTIAL_PATH } from "./config.ts";
import { probeApnsCredential, providerToken } from "./apns.ts";
import { getApnsCredential, type ApnsCredential } from "./apnsStore.ts";
import { listApnsDevices } from "./apnsStore.ts";

function fail(message: string): never {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}

/**
 * Prove the PEM is the elliptic-curve key Apple issues, before asking Apple.
 *
 * A `.p8` that was pasted with mangled newlines, or the JWK download used by
 * mistake, fails here with something readable rather than as `InvalidProviderToken`
 * from a server on the far side of the internet.
 */
function describeKey(credential: ApnsCredential): string {
  let key;
  try {
    key = createPrivateKey({ key: credential.privateKey, format: "pem" });
  } catch (error) {
    fail(
      `privateKey is not a readable PEM private key (${error instanceof Error ? error.message : String(error)}). ` +
        `It must be the CONTENTS of the AuthKey_*.p8 file — newlines included, and not the JWK download.`,
    );
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") {
    fail(
      `privateKey is a ${key.asymmetricKeyType ?? "unknown"} key; APNs auth keys are EC P-256. ` +
        `Check that this is the .p8 Apple issued for Apple Push Notification service.`,
    );
  }
  return "EC P-256";
}

async function main(): Promise<void> {
  console.log(`\nAPNs credential: ${APNS_CREDENTIAL_PATH}`);

  const credential = getApnsCredential();
  if (!credential) {
    fail(
      "no usable credential was found there. Either the file is absent, or it failed " +
        "validation — the server logs the reason as `[apns] ignoring the stored credential`. " +
        "See docs/notifications.md for the expected shape.",
    );
  }

  console.log(`  key id     ${credential.keyId}`);
  console.log(`  team id    ${credential.teamId}`);
  console.log(`  topic      ${credential.bundleId}`);
  console.log(
    `  key scope  ${credential.keyScope}${
      credential.keyScope === "topic"
        ? ' (portal: "Topic Specific" — the token names the topic in `sub`)'
        : ' (portal: "Team Scoped (All Topics)")'
    }`,
  );
  console.log(`  private    ${describeKey(credential)}`);

  // Signing locally separates "the key is unusable" from "Apple said no".
  try {
    providerToken(credential);
  } catch (error) {
    fail(
      `the provider token could not be signed with this key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log("  token      signs as ES256");

  const devices = listApnsDevices();
  console.log(
    `\nRegistered devices: ${devices.length}${
      devices.length === 0
        ? " (expected before the iOS app has run against this server)"
        : ` (${devices.map((device) => device.environment).join(", ")})`
    }`,
  );

  // Which of Apple's hosts this key actually HAS to work against: wherever the
  // registered device tokens live, or development when none has registered yet,
  // since that is what a locally installed build signs. The other host is probed
  // too but cannot fail the check — the portal can restrict a key to one
  // environment, and being refused by the host you never use is correct.
  const required = new Set(
    devices.length > 0
      ? devices.map((device) => device.environment)
      : (["development"] as const),
  );

  let usable = true;
  for (const environment of ["development", "production"] as const) {
    const matters = required.has(environment);
    process.stdout.write(
      `\nAsking Apple (${environment}${matters ? "" : ", not used by this app"})… `,
    );
    try {
      const probe = await probeApnsCredential(credential, environment);
      console.log(
        `${probe.status}${probe.reason ? ` ${probe.reason}` : ""}\n  ${probe.verdict}`,
      );
      if (matters && !probe.authenticated) usable = false;
    } catch (error) {
      console.log(
        `could not reach Apple\n  ${error instanceof Error ? error.message : String(error)}`,
      );
      if (matters) usable = false;
    }
  }

  console.log(
    usable
      ? `\nOK — this server can push to the iOS app on ${[...required].join(" and ")}.\n`
      : "\nNot usable yet. See the verdicts above.\n",
  );
  process.exit(usable ? 0 : 1);
}

await main();
