/**
 * The entries+streaming → `DisplayMessage[]` projection lives in the shared
 * package so the client reducer shares it; re-exported here for the server
 * transport's existing imports.
 */
export { entriesToDisplayMessages } from "@assistant/shared/display";
