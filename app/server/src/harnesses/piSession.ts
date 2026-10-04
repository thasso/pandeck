/**
 * The pi session types app code still names (`docs/agent-harnesses.md`): a
 * commit dry run is recorded on, and accepted from, the pi agent session that
 * ran it (`LiveSession.acceptCommitDryRun`, pi only). Types only; importing
 * this loads nothing.
 */
export type { AgentSession, SessionManager } from "../piSdk/index.ts";
