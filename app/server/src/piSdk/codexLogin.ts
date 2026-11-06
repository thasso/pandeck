/**
 * pi's `openai-codex` device-code login (plan Task-1385, M11): the
 * interaction the server's own profile login uses (`models.ts`), and the
 * gateway's Codex login driver, which runs that login on a runtime whose
 * `auth.json` lies in the login's fresh directory. The gateway moves the
 * credential from there into the account's token file
 * (`gateway/vaultLogins.ts`).
 *
 * This module never imports `models.ts`, whose load refreshes the model
 * catalog.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryModelsStore,
  type AuthInteraction,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { join } from "node:path";

let flowsRegistered = false;

/**
 * pi's login interaction for a remote UI: it picks the device-code flow and
 * hands the verification URL and one-time code to `onDeviceCode`. Neither is
 * a credential, but both stay out of logs and persistent metadata.
 */
export function deviceCodeInteraction(
  onDeviceCode: (verificationUri: string, userCode: string) => void,
  signal?: AbortSignal,
): AuthInteraction {
  return {
    ...(signal ? { signal } : {}),
    notify(event) {
      if (event.type === "device_code")
        onDeviceCode(event.verificationUri, event.userCode);
    },
    async prompt(prompt) {
      // The provider asks once to choose browser vs device code; a remote UI
      // takes its documented headless option.
      if (
        prompt.type === "select" &&
        prompt.options.some((option) => option.id === "device_code")
      )
        return "device_code";
      throw new Error("This OpenAI login requires the device-code flow.");
    },
  };
}

/** The gateway's Codex login driver (`gateway/logins.ts` `LoginDriver`). */
export function codexLoginDriver(
  configDir: string,
  events: {
    output(text: string): void;
    url(url: string): void;
    code(code: string): void;
  },
): { input(text: string): void; cancel(): void; done: Promise<void> } {
  const abort = new AbortController();
  const done = (async () => {
    if (!flowsRegistered) {
      registerBunOAuthFlows();
      flowsRegistered = true;
    }
    const runtime = await ModelRuntime.create({
      authPath: join(configDir, "auth.json"),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    events.output("Starting the OpenAI device-code login…\n");
    await runtime.login(
      "openai-codex",
      "oauth",
      deviceCodeInteraction((url, code) => {
        events.url(url);
        events.code(code);
        events.output(`Open ${url} and enter the code ${code}.\n`);
      }, abort.signal),
    );
    events.output("OpenAI login completed.\n");
  })();
  return {
    input: () => {},
    cancel: () => abort.abort(),
    done,
  };
}
