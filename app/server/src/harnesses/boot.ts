/**
 * What the server's composition root starts in the engines
 * (`docs/agent-harnesses.md`): pi's bundled tool binaries, its model provider
 * sync, each account's model runtime, and the OpenAI account login flow.
 */
export {
  modelRuntimeForProfile,
  startOpenAiProfileLogin,
  syncConfiguredModelProviders,
  warmCredentialProfileModelRuntimes,
} from "../piSdk/models.ts";
export { linkPiToolBinaries } from "../piSdk/toolBinaries.ts";
