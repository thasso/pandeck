/**
 * The Claude login child (ADR-0005 "The login children"), its own entry: the
 * vault spawns one per login through `gateway/loginChild.ts`. It runs the
 * official CLI's subscription login (`claudeLoginDriver.ts`) with
 * `CLAUDE_CONFIG_DIR` set to the login's directory, where the CLI leaves the
 * credential. It loads no pi.
 */
import { claudeLoginDriver } from "./claudeLoginDriver.ts";
import { runLoginChild } from "./loginChildEntry.ts";

runLoginChild(claudeLoginDriver);
