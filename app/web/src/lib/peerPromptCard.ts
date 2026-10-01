/**
 * The peer-prompt card parser lives in `@assistant/shared/toolCards` so the
 * server's payload policy and this client's card use ONE acceptance rule;
 * this module keeps the client's import path.
 */
export {
  isPeerPromptState,
  parsePeerPromptCard,
} from "@assistant/shared/toolCards";
