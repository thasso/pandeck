import { SessionBusyError } from "./errors.ts";

/** Server-only authority for one account recovery reservation. */
export type AccountRecoveryTicket = symbol;
const reservations = new Map<string, AccountRecoveryTicket>();

/** A backend refusal whose fixed host-owned message is safe for the timeline. */
export class AccountSwitchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountSwitchBlockedError";
  }
}

class AccountSwitchInProgressError extends SessionBusyError {
  constructor(id: string) {
    super(id, "This session is switching accounts; wait for it to resume.");
    this.name = "AccountSwitchInProgressError";
  }
}

export function assertAccountRecoveryAdmission(
  id: string,
  ticket?: AccountRecoveryTicket,
): void {
  const held = reservations.get(id);
  if ((held && ticket !== held) || (ticket && ticket !== held))
    throw new AccountSwitchInProgressError(id);
}

export function reserveAccountRecovery(id: string): AccountRecoveryTicket {
  const ticket = Symbol("account recovery");
  reservations.set(id, ticket);
  return ticket;
}

export function ownsAccountRecovery(
  id: string,
  ticket: AccountRecoveryTicket,
): boolean {
  return reservations.get(id) === ticket;
}

export function releaseAccountRecovery(
  id: string,
  ticket: AccountRecoveryTicket,
): boolean {
  if (!ownsAccountRecovery(id, ticket)) return false;
  reservations.delete(id);
  return true;
}
