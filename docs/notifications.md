# Notifications

How an alert about finished work reaches the user, on every runtime this app
has. This is a contract because the same alert is offered to several clients at
once and exactly one of them may raise it — a mistake in that choice is not an
error anywhere, just a phone that buzzes twice or never.

## The three routes

The server builds one payload — `{ title, body, navigatePath }` — and sends it
by every route it has (`deliverAppNotification` in `app/server/src/webPush.ts`).
What EARNS one is `docs/messaging.md`'s policy: a result the user was waiting
for (an owned turn finishing, CI concluding, a workflow reaching a merge
decision) or an agent that has STOPPED and cannot continue without them (an
approval it proposed, a question it asked). Session alerts use the same
ownership and outcome rule as the Sessions inbox. A coordinator-owned
`session_spawn` child never alerts the user. When a peer report wakes its
parent, a successful parent turn also stays quiet while another
`responseRequested` peer reply remains outstanding; its first run after the
final expected report alerts normally. A direct human turn and a parent failure
remain their own results during orchestration, and a user-aborted turn is not
news. The Sessions inbox follows the same rule: an intermediate parent wake
creates neither an outcome revision nor a new **Done / Unread response** state,
but unread state from before that wake remains. This distinction is structural:
prompt origin and durable peer-request state decide it, never titles or
transcript text.

A blocked agent is pushed once when the block appears. The durable card and the
inbox's `needs-you` tier carry it after that. Coordinator-owned children stay
quiet here too; their parent owns the loop. No single route reaches every
client:

| Route                               | Reaches                                 | When the app is closed |
| ----------------------------------- | --------------------------------------- | ---------------------- |
| Declarative Web Push                | Browsers and installed Home Screen apps | Yes                    |
| APNs (`app/server/src/apns.ts`)     | The native iOS app                      | Yes                    |
| The live socket (`appNotification`) | Whatever is connected right now         | No                     |

The socket copy exists for the runtimes that can have no push subscription at
all: the native shell is a WKWebView, which implements neither `Notification`
nor `PushManager`, so the Declarative Web Push flow Settings offers cannot even
subscribe there. On macOS that is the only route the app has.

## Who acts on the socket copy

The server broadcasts `appNotification` to every connected client and does not
decide — only the client knows what it is capable of.
`shouldRaiseAppNotification` (`app/web/src/lib/apnsPush.ts`) is the single
answer:

- **A browser** ignores it. It has its own Web Push subscription for the same
  alert and would otherwise notify twice.
- **The macOS shell** always raises it. It has no push route.
- **The iOS shell** raises it until its APNs registration takes, then goes
  quiet. Once Apple is delivering, raising the socket copy too is what makes
  every finished turn buzz twice.

Duplicates across several open windows are collapsed by the shell rather than by
electing a window in the page, which would have to survive that window closing
mid-alert.

## Where a tap goes

`navigatePath` is app-relative and every route carries it, so a tap lands in the
same place however the alert arrived. Web Push navigates to it directly; the
shell hands it to `openurl::open_target`, which addresses one window and leaves
the string opaque — the page resolves it (`app/web/src/lib/openTarget.ts`),
because teaching the shell the route table would mean rebuilding the shell
whenever a route moved.

On iOS the target travels under one key, `paTarget`, in both a local
notification's `userInfo` and at the top level of the APNs payload beside `aps`
(`userInfo` for a remote notification IS the whole JSON body). The shell reads
it one way for both. **Renaming it means changing `app/shell/src/ios.rs` and
`app/server/src/apns.ts` together**; a mismatch shows up as a tap that opens the
app and loses the session.

## Setting up APNs

Without a credential the server simply never pushes, and the iOS app falls back
to raising alerts over the live socket while it runs. To turn it on:

1. The App ID must exist with Push Notifications enabled. Building the shell for
   a DEVICE does this for you: `build.rs` puts `aps-environment` in the
   entitlements, so Xcode's automatic signing registers the App ID and issues a
   profile carrying that entitlement. The App ID is the shell's bundle id (this
   document uses `com.example.personal-assistant`) under the development team
   you sign the shell with (`docs/reference/native-shell.md`). To check, look
   for `aps-environment` in
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles/*.mobileprovision`.
2. In that same team's developer portal, create a **Key** with the Apple Push
   Notification service enabled and download the `.p8`. It can only be
   downloaded once. Note its **Key ID**.

   The portal offers two scopes, and both work — but the server has to be told
   which, since a key signed the wrong way is rejected as `InvalidProviderToken`
   and nothing more specific. **Team Scoped (All Topics)** is `keyScope: "team"`
   below (also the default when the field is absent) and can push to every app
   in the team. **Topic Specific**, bound to the bundle id, is
   `keyScope: "topic"` and additionally names that topic in the token's `sub`
   claim. Prefer topic-specific in a shared organization account: it is the same
   amount of setup, and a leaked key then reaches this app instead of all of
   them.

3. Give the server the key as JSON, mode `0600`. It reads
   `$DATA_DIR/apns/credential.json` by default, or whatever
   `APNS_CREDENTIAL_FILE` points at — the nixos module's `apnsCredentialFile`
   sets that, so the key can be a sops-nix secret rather than a file copied onto
   the host by hand. Either way the shape is the same:

   ```json
   {
     "keyId": "SEE_AUTHKEY_FILENAME",
     "teamId": "A1B2C3D4E5",
     "bundleId": "com.example.personal-assistant",
     "keyScope": "topic",
     "privateKey": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
   }
   ```

   `privateKey` is the PEM **contents** of the `.p8`, not a path to it — the JWK
   the portal also offers is rejected. `keyId` is the 10-character id in the
   `AuthKey_<keyId>.p8` filename, NOT a value to invent; a wrong one is refused
   as `InvalidProviderToken` like every other credential mistake. Building the
   file with `jq` gets the PEM's newlines escaped correctly:

   ```bash
   jq -n --rawfile key AuthKey_KEYID12345.p8 \
     '{keyId:"KEYID12345", teamId:"A1B2C3D4E5",
       bundleId:"com.example.personal-assistant", keyScope:"topic", privateKey:$key}'
   ```

4. Check it with `pnpm run check:apns`, which reads the credential exactly as
   the server does and then asks Apple, so it works before any device has
   registered. It pushes to a device token that belongs to nobody — Apple
   authenticates first, so `400 BadDeviceToken` is the PASS. A key the portal
   restricted to one environment answers `403 BadEnvironmentKeyInToken` from the
   other host, which is expected and does not fail the check unless the app's
   device tokens live there.

A malformed file is treated as "push is not configured" rather than failing the
server — a mistyped key must not take the server down — so `check:apns` and
Settings → Notifications are how you find out, not the exit code.

None of this gates a merge or a deploy, and it needs no restart: the credential
is read per notification, so adding it later takes effect on the next one.

The device half needs nothing from the user: the iOS app asks for the
notification permission at launch, registers for push, and hands its token to
`POST /api/apns/device` on every page load (`useApnsRegistration`). Apple
reissues a token on reinstall or a restored backup, which is why it is
re-registered every time rather than once; the server retires a token Apple
reports as `BadDeviceToken`/`Unregistered`.

### Development and production are different hosts

A device token is valid against exactly one of `api.sandbox.push.apple.com` and
`api.push.apple.com`, following the `aps-environment` the app was signed with,
and sending it to the wrong one is rejected as nothing more helpful than
`BadDeviceToken`. So the app reports its own environment rather than the server
guessing: `build.rs` bakes it in, `push_registration` returns it, and it is
stored with the token. A locally installed or ad-hoc build is `development`; set
`APNS_ENVIRONMENT=production` when building for TestFlight or the App Store.

### Verifying it

Settings → Notifications shows the three facts that have to line up (the iOS
permission, a device token, a server key) and its button sends a real push
through `POST /api/apns/test`, reporting Apple's answer. That indirection
matters: a locally raised banner proves the permission and nothing about Apple,
and Apple reports a rejection to the SERVER and never to the device.
