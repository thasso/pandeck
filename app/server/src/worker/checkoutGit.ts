/**
 * The Worker's checkout git methods: each request runs one git process in the
 * checkout it names, through `gitProcess.ts`, and answers its raw outcome.
 *
 * Every run asks the spawn broker for an EXIT RECEIPT, so a request settles
 * only once its child has exited: a cancel, or the connection ending, can
 * never leave git running behind a caller that already moved on
 * (`docs/workers.md`). Counting and the read fan-out bound stay with the
 * caller's executor family on the server.
 */
import { runGit, runGitBounded, runGitRaw } from "../gitProcess.ts";
import {
  CHECKOUT_GIT_METHODS,
  WRONG_WORKER,
  decodeBounded,
  decodeRun,
  encodeBoundedOutcome,
  encodeExecOutcome,
  encodeRawOutcome,
  type CheckoutLocation,
} from "../workerProtocol/checkoutMethods.ts";
import {
  WorkerMethodError,
  type MethodHandler,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";

/**
 * The handlers of the Worker `workerId`. Each git child inherits `childEnv()`,
 * read when its request is served, with the request's overrides on top.
 */
export function checkoutGitHandlers(
  workerId: string,
  childEnv: () => NodeJS.ProcessEnv,
): MethodHandlers {
  /** The checkout's path here; another Worker's location runs nothing. */
  const here = (location: CheckoutLocation): string => {
    if (location.workerId !== workerId)
      throw new WorkerMethodError(
        WRONG_WORKER,
        `The checkout ${location.path} is placed on Worker "${location.workerId}", not "${workerId}".`,
      );
    return location.path;
  };
  const run =
    (withInput: boolean): MethodHandler =>
    async (payload, signal) => {
      const { location, ...req } = decodeRun(payload, withInput);
      return encodeExecOutcome(
        await runGit(
          { ...req, cwd: here(location), signal, awaitExit: true },
          childEnv(),
        ),
      );
    };
  return {
    [CHECKOUT_GIT_METHODS.run]: run(false),
    [CHECKOUT_GIT_METHODS.runWithInput]: run(true),
    [CHECKOUT_GIT_METHODS.raw]: async (payload, signal) => {
      const { location, ...req } = decodeRun(payload, false);
      return encodeRawOutcome(
        await runGitRaw(
          { ...req, cwd: here(location), signal, awaitExit: true },
          childEnv(),
        ),
      );
    },
    [CHECKOUT_GIT_METHODS.bounded]: async (payload, signal) => {
      const { location, ...req } = decodeBounded(payload);
      return encodeBoundedOutcome(
        await runGitBounded(
          { ...req, cwd: here(location), signal, awaitExit: true },
          childEnv(),
        ),
      );
    },
  };
}
