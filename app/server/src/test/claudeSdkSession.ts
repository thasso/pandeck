/** Direct native-session tests use the real app projection unless they record it. */
import {
  ClaudeSdkSession as NativeClaudeSdkSession,
  type ClaudeSdkSessionDeps,
} from "../claudeSdk/ClaudeSdkSession.ts";
import type { HarnessHost } from "../harness.ts";
import { buildSessionState } from "../sessionState.ts";

type TestSessionDeps = Omit<ClaudeSdkSessionDeps, "buildSessionState"> &
  Partial<Pick<ClaudeSdkSessionDeps, "buildSessionState">>;

export class ClaudeSdkSession extends NativeClaudeSdkSession {
  constructor(id: string, deps: TestSessionDeps) {
    super(id, { buildSessionState, ...deps });
  }
}

/** Store-only tests have no hub to install their required app dependency. */
export function installClaudeStateBuilder(store: {
  setStateBuilder(builder: HarnessHost["buildSessionState"]): void;
}): void {
  store.setStateBuilder(buildSessionState);
}
