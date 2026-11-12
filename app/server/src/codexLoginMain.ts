/**
 * The Codex login child (ADR-0005 "The login children", M5, M11), its own
 * entry: the vault spawns one per login through `gateway/loginChild.ts`. It
 * runs pi's `openai-codex` device-code login (`piSdk/codexLogin.ts`, via the
 * harness gateway port) with its `auth.json` in the login's directory. Like
 * the renewal child, it is a place pi loads outside the vault process.
 */
import { codexLoginDriver } from "./harnesses/gatewayPorts.ts";
import { runLoginChild } from "./loginChildEntry.ts";

runLoginChild(codexLoginDriver);
