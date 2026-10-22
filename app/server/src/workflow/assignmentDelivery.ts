import type { DeliveryAcquisitionFailure } from "../deliveryScheduler.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";

/** The executor owns reservations; the scheduler only admits their delivery. */
export interface WorkflowAssignmentDelivery {
  owes(sessionId: string): boolean;
  deliver(
    session: RuntimePromptDriver,
    shouldStart: () => boolean,
  ): Promise<void>;
  unavailable(sessionId: string, failure: DeliveryAcquisitionFailure): void;
}

let delivery: WorkflowAssignmentDelivery | undefined;

export function setWorkflowAssignmentDelivery(
  next: WorkflowAssignmentDelivery | undefined,
): void {
  delivery = next;
}

export const workflowAssignmentDelivery: WorkflowAssignmentDelivery = {
  owes: (id) => delivery?.owes(id) ?? false,
  deliver: async (session, shouldStart) => {
    await delivery?.deliver(session, shouldStart);
  },
  unavailable: (id, failure) => delivery?.unavailable(id, failure),
};
