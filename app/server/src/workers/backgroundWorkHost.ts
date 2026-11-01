/**
 * The server's side of Worker-executed background work (`docs/workers.md`):
 * the `backgroundWork.*` requests a Worker sends, and the `host-process` port
 * through which the supervisor launches and stops that work on the Worker.
 *
 * - `admit` runs for a session placed on the asking Worker. It registers the
 *   port on first use, admits through the supervisor (`admitBackgroundWork`
 *   stays the only creation path), and for a new item launches it within the
 *   same span: the port sends the launch on the asking connection, under the
 *   launch key the Worker reserved.
 * - An item report names a `host-process` row whose owner is placed on the
 *   asking Worker, or it is refused before any supervisor call. An output
 *   report's file is copied from the Worker through `files.open` and captured
 *   here, where the artifact store lives.
 * - Stop and Stop-all go to the owner's Worker by placement. A request that
 *   fails is an unanswered Stop, which the supervisor records unconfirmed.
 *
 * Imports no connection acquisition, so `inProcessWorker.ts` can wire it.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackgroundWorkBackendPort,
  BackgroundWorkOutputCaptured,
} from "../backgroundWork/backends.ts";
import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";
import { captureTaskOutputArtifact } from "../outputPolicy.ts";
import {
  BACKGROUND_WORK_METHODS,
  decodeActivity,
  decodeAdmitRequest,
  decodeCompletion,
  decodeLaunchAck,
  decodeOutput,
  decodeRateExceeded,
  decodeStopAck,
  decodeStopAllAck,
  encodeBackgroundWork,
  type BackgroundWorkMethod,
  type BackgroundWorkOutputReport,
} from "../workerProtocol/backgroundWorkMethods.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import type { AdmittedPeer } from "./appToolHost.ts";
import { copyFromWorker } from "./copyFromWorker.ts";
import { sessionCheckoutSide, type CheckoutSide } from "./placement.ts";
import { workerRegistry } from "./workerRegistry.ts";

/** The error code of a request for work not placed on the asking Worker. */
const NOT_PLACED = "not_placed";
/** Today's answer to a launch with no reservation behind it. */
const RESERVATION_GONE = "the pi launch reservation is no longer available";

const served = new Map<BackgroundWorkMethod, number>();

/** Admissions between `admit` and their launch: the connection and key to launch on. */
const launches = new Map<
  string,
  { connection: WorkerConnection; launchKey: string }
>();

function refuse(what: string): never {
  throw new WorkerMethodError(
    NOT_PLACED,
    `${what} is not placed on this Worker.`,
  );
}

function boundedError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Stop failed";
}

/** The open connection of the Worker `ownerSessionId` is placed on. */
function ownerConnection(ownerSessionId: string): WorkerConnection {
  const side = sessionCheckoutSide(ownerSessionId);
  if (side === "server")
    throw new Error(`Session ${ownerSessionId} runs on no Worker.`);
  const connection = workerRegistry.connection(side.workerId);
  if (!connection)
    throw new Error(`Worker "${side.workerId}" is not connected.`);
  return connection;
}

const hostProcessPort: BackgroundWorkBackendPort = {
  backend: "host-process",
  async launch(request) {
    const launch = launches.get(request.target.itemId);
    if (!launch) return { launched: false, reason: RESERVATION_GONE };
    return decodeLaunchAck(
      await launch.connection.request(
        BACKGROUND_WORK_METHODS.launch,
        encodeBackgroundWork({ launchKey: launch.launchKey, request }),
      ),
    );
  },
  async stop(request) {
    try {
      return decodeStopAck(
        await ownerConnection(request.target.ownerSessionId).request(
          BACKGROUND_WORK_METHODS.stop,
          encodeBackgroundWork(request),
        ),
      );
    } catch (error) {
      return { acknowledged: false, evidence: boundedError(error) };
    }
  },
  async stopAll(request) {
    try {
      return decodeStopAllAck(
        await ownerConnection(request.ownerSessionId).request(
          BACKGROUND_WORK_METHODS.stopAll,
          encodeBackgroundWork(request),
        ),
      );
    } catch {
      return {
        acknowledgedItemIds: [],
        unconfirmedItemIds: [...request.itemIds],
      };
    }
  },
};

let portRegistered = false;

/**
 * The supervisor, with the port registered once, before the first admission
 * can need it. Lazy: the supervisor reaches the in-process Worker, which
 * imports this host, so a static import would close a cycle.
 */
async function supervisor() {
  const { backgroundWorkSupervisor } =
    await import("../backgroundWork/supervisor.ts");
  if (!portRegistered) {
    backgroundWorkSupervisor.registerBackend(hostProcessPort);
    portRegistered = true;
  }
  return backgroundWorkSupervisor;
}

/**
 * The evidence an output report yields: its Worker file copied into a fresh
 * server directory and captured there, with the writer's head-cap facts as
 * the Worker's capture recorded them.
 */
async function capturedEvidence(
  ownerSessionId: string,
  side: CheckoutSide,
  report: BackgroundWorkOutputReport,
): Promise<BackgroundWorkOutputCaptured["evidence"]> {
  let evidence: BackgroundWorkOutputCaptured["evidence"];
  if (report.file === undefined)
    evidence = {
      capturedBytes: 0,
      text: false,
      truncated: false,
      refusalReason: "output-write-failed",
    };
  else {
    const root = mkdtempSync(join(tmpdir(), `pa-pi-capture-${process.pid}-`));
    try {
      chmodSync(root, 0o700);
      const outputFile = join(root, "output.log");
      let copied = true;
      try {
        await copyFromWorker(side, report.file, outputFile);
      } catch {
        copied = false;
      }
      evidence = copied
        ? captureTaskOutputArtifact({
            sessionId: ownerSessionId,
            outputFile,
            trustedRoot: root,
            sourceTool: "pi background work",
            artifactLabel: "pi background work output",
          })
        : {
            capturedBytes: 0,
            text: false,
            truncated: false,
            refusalReason: "output-path-unavailable",
          };
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Capture already copied or refused the output; cleanup is best effort.
      }
    }
  }
  return report.truncated
    ? {
        ...evidence,
        ...(report.originalBytes !== undefined
          ? { originalBytes: report.originalBytes }
          : {}),
        truncated: true,
      }
    : evidence;
}

/**
 * The server's `backgroundWork.*` handlers for one Worker connection. `peer`
 * answers the connection and its admitted Worker id; a request runs only once
 * the handshake has admitted one.
 */
export function backgroundWorkHandlers(
  peer: () => AdmittedPeer | undefined,
): MethodHandlers {
  /** The asking Worker and `sessionId`'s side, once that Worker holds it. */
  const placed = (sessionId: string, what: string) => {
    const asking = peer();
    const side = sessionCheckoutSide(sessionId);
    if (!asking || side === "server" || side.workerId !== asking.workerId)
      refuse(what);
    return { asking, side };
  };
  const count = (method: BackgroundWorkMethod) =>
    served.set(method, (served.get(method) ?? 0) + 1);
  /** The item's row and side, once it is the asking Worker's to report on. */
  const reportable = (method: BackgroundWorkMethod, itemId: string) => {
    const item = backgroundWorkStore.getItem(itemId);
    const what = `Background item ${itemId}`;
    if (!item || item.backend !== "host-process") refuse(what);
    const { side } = placed(item.ownerSessionId, what);
    count(method);
    return { item, side };
  };
  return {
    [BACKGROUND_WORK_METHODS.admit]: async (payload) => {
      const { sessionId, launchKey, ...request } = decodeAdmitRequest(payload);
      const { asking } = placed(sessionId, `Session ${sessionId}`);
      count(BACKGROUND_WORK_METHODS.admit);
      const backgroundWorkSupervisor = await supervisor();
      const admission = backgroundWorkSupervisor.admit({
        ownerSessionId: sessionId,
        backend: "host-process",
        ...request,
      });
      if (!admission.admitted)
        return encodeBackgroundWork({
          admitted: false,
          message: admission.message,
        });
      const { item } = admission;
      const intent = item.intent === "service" ? { intent: "service" } : {};
      if (admission.reused)
        return encodeBackgroundWork({
          admitted: true,
          itemId: item.id,
          state: item.state,
          reused: true,
          ...intent,
        });
      launches.set(item.id, { connection: asking.connection, launchKey });
      let launched;
      try {
        launched = await backgroundWorkSupervisor.launch(admission);
      } finally {
        launches.delete(item.id);
      }
      return encodeBackgroundWork({
        admitted: true,
        itemId: item.id,
        state: launched?.state ?? item.state,
        reused: false,
        ...intent,
        ...(launched?.outcomeSummary !== undefined
          ? { outcomeSummary: launched.outcomeSummary }
          : {}),
      });
    },
    [BACKGROUND_WORK_METHODS.activity]: async (payload) => {
      const activity = decodeActivity(payload);
      reportable(BACKGROUND_WORK_METHODS.activity, activity.itemId);
      (await supervisor()).activity(activity);
      return encodeBackgroundWork({});
    },
    [BACKGROUND_WORK_METHODS.rateExceeded]: async (payload) => {
      const event = decodeRateExceeded(payload);
      reportable(BACKGROUND_WORK_METHODS.rateExceeded, event.itemId);
      (await supervisor()).activityRateExceeded(event);
      return encodeBackgroundWork({});
    },
    [BACKGROUND_WORK_METHODS.output]: async (payload) => {
      const report = decodeOutput(payload);
      const { item, side } = reportable(
        BACKGROUND_WORK_METHODS.output,
        report.itemId,
      );
      const evidence = await capturedEvidence(
        item.ownerSessionId,
        side,
        report,
      );
      (await supervisor()).outputCaptured({
        itemId: report.itemId,
        eventId: report.eventId,
        evidence,
      });
      return encodeBackgroundWork({});
    },
    [BACKGROUND_WORK_METHODS.completed]: async (payload) => {
      const completion = decodeCompletion(payload);
      reportable(BACKGROUND_WORK_METHODS.completed, completion.itemId);
      (await supervisor()).completed(completion);
      return encodeBackgroundWork({});
    },
  };
}

/** Test seam: how many `method` requests the server has admitted and served. */
export function backgroundWorkCallsServedForTests(
  method: BackgroundWorkMethod,
): number {
  return served.get(method) ?? 0;
}
