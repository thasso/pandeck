/**
 * Applying a gateway-prepared card (Task-1463 P6b): what the `jiraIssue` and
 * `confluencePage` executors run for a card whose context says
 * `via: "gateway"`. The card's items go to the gateway's `tools.apply` and
 * never to local credentials, whatever happens.
 *
 * Before the send, in order (P6-O4): the body's kind, client mode, the
 * card's proposal form (each item without result fields) through P6a's
 * closed check, the first listing (bounded wait); then, with no await
 * between check and send, the connection, the product's toggle and the
 * listing's two-phase offer. Every refusal so far says nothing was written,
 * which holds because nothing was sent.
 *
 * After the send, one table decides the card (`docs/approvals.md`):
 * - `notSent`: unreachable, nothing written;
 * - a failed answer certified `effects: "none"`: its message with the
 *   client's own "Nothing was written." (D6(i));
 * - a failed answer with `effects: "possible"`: its checked results merged,
 *   then {@link MAY_HAVE_WRITTEN};
 * - a success: every record checked before any is merged, then the local
 *   summary owner's text with the effects-driven suffix;
 * - `lost`, `timeout`, `undecodable`, a record that fails its check:
 *   {@link MAY_HAVE_WRITTEN}, nothing merged.
 *
 * Every merge runs inside the executor's awaited path, before it returns or
 * throws; a late answer never reaches here (the link drops it).
 *
 * A Confluence card with upload items (Task-1441 P8a, v02 AC5, v03 K1/K3)
 * first sends its approved bytes. After the bounded wait, the route is
 * checked once so an unavailable route reads no file. Then `uploads.open`
 * reserves the edge's one transfer for the card's sources and W, and each
 * source streams from its staged copy in 1 MiB chunks, one `uploads.put`
 * outstanding at a time. Each source must end with its approved length and
 * digest, `streamComplete`, and `sealed` only after the last. The fence
 * above follows, then `tools.apply` names the sealed upload. Up to that
 * attempt nothing reached Atlassian: any failure releases the upload
 * without waiting and says nothing was written; a refused open shows the
 * edge's own text (ruling P8A-V10-O1). From the attempt on, nothing is
 * released (only the edge's holds end an attached upload), and every row
 * above that says {@link MAY_HAVE_WRITTEN} says
 * {@link MAY_HAVE_WRITTEN_UPLOAD}.
 *
 * Imports no catalog, tool group or local tool module
 * (`architecture.test.ts`).
 */
import type {
  ApprovalCard,
  ConfluencePageMutationItemDisplay,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared";
import { summarizeConfluenceApplication } from "../../confluenceMutateApply.ts";
import { checkConfluencePageItems } from "../../confluenceMutationCheck.ts";
import {
  checkConfluenceResult,
  confluenceProposalOf,
  mergeConfluenceResult,
  type ConfluenceResultRecord,
} from "../../confluenceMutationResult.ts";
import { summarizeJiraApplication } from "../../jiraMutateApply.ts";
import { checkJiraIssueItems } from "../../jiraMutationCheck.ts";
import {
  checkJiraResult,
  jiraProposalOf,
  mergeJiraResult,
  type JiraResultRecord,
} from "../../jiraMutationResult.ts";
import {
  remoteProductEnabled,
  remoteToolDispatchable,
  remoteToolPort,
  remoteToolsConnected,
  remoteToolsReady,
  type RemoteApplyAnswer,
  type RemoteApplyOutcome,
  type RemoteApplyUpload,
  type RemoteProduct,
  type RemoteToolPort,
  type RemoteUploadPort,
  type RemoteUploadStream,
  type RemoteWriteName,
} from "../../remoteTools.ts";
import { readStagedChunks } from "../confluence/confluenceAttachments.ts";
import {
  UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN,
  cardUploads,
  type CardUploads,
} from "./remoteUploads.ts";
import {
  ATLASSIAN_SITE_RE,
  DISABLED,
  NOTHING_WRITTEN,
  NOT_OFFERED,
  withNothingWritten,
} from "./remoteWriteRules.ts";

/** How long an approval waits for the link's first listing after a boot. */
const READY_WAIT_MS = 15_000;

const NOT_CLIENT_MODE =
  "This change was prepared on the credential gateway, which this server no longer uses. Nothing was written; ask for it again.";
const UNREACHABLE =
  "The credential gateway is unreachable. Nothing was written; ask for the change again.";
const CANNOT_SEND =
  "This proposal can't be sent to the gateway. Nothing was written; ask for it again.";
/** Nothing confirmed what happened: the transport or the answer failed. */
const MAY_HAVE_WRITTEN =
  "The gateway did not confirm the result. Changes may have been written, and a change already sent can still finish within about a minute. Wait a minute, then check the site; ask again only for what is missing. Don't approve the same change again unchecked.";
/**
 * {@link MAY_HAVE_WRITTEN} for a card that uploads (v02 AC9): the edge's
 * apply may run up to 145 s after it admits the request.
 */
const MAY_HAVE_WRITTEN_UPLOAD =
  "The gateway did not confirm the result. Changes may have been written, and an upload already sent can still finish within about three minutes. Wait three minutes, then check the page; ask again only for what is missing. Don't approve the same upload again unchecked.";
/** A confirmed answer in which a failed item may have written first. */
const PARTIAL_EFFECTS =
  "Some failed changes may have been partly written before they failed; the card shows each item's outcome. Check the site and ask again only for what is missing. Don't approve the same change again unchecked.";
const TRIMMED = "Some result details were too long to return.";

interface Applied {
  resultSummary: string;
  resultUrl?: string;
}

/** What differs between the two products. */
interface GatewayKind<Item, Rec extends object> {
  name: RemoteWriteName;
  product: RemoteProduct;
  /** The card's site and items, or undefined for another body kind. */
  body(card: ApprovalCard): { site?: string; items: Item[] } | undefined;
  proposalOf(item: Item): Item;
  checkProposal(items: unknown): items is Item[];
  checkResult(record: unknown, sent: Item, site: string): record is Rec;
  merge(card: Item, record: Rec, trimmed: boolean): void;
  /** The local summary owner; throws its all-failed text. */
  summarize(items: Item[]): Applied;
  /** The card's upload sources, when it has any (Confluence only). */
  uploads?(items: Item[]): CardUploads | undefined;
}

const JIRA: GatewayKind<JiraIssueMutationItemDisplay, JiraResultRecord> = {
  name: "jira_mutate_issue",
  product: "jira",
  body: (card) =>
    card.body.kind === "jiraIssue"
      ? {
          ...(card.body.jiraHost !== undefined
            ? { site: card.body.jiraHost }
            : {}),
          items: card.body.items,
        }
      : undefined,
  proposalOf: jiraProposalOf,
  checkProposal: checkJiraIssueItems,
  checkResult: checkJiraResult,
  merge: mergeJiraResult,
  summarize: summarizeJiraApplication,
};

const CONFLUENCE: GatewayKind<
  ConfluencePageMutationItemDisplay,
  ConfluenceResultRecord
> = {
  name: "confluence_mutate_page",
  product: "confluence",
  body: (card) =>
    card.body.kind === "confluencePage"
      ? {
          ...(card.body.confluenceHost !== undefined
            ? { site: card.body.confluenceHost }
            : {}),
          items: card.body.items,
        }
      : undefined,
  proposalOf: confluenceProposalOf,
  checkProposal: checkConfluencePageItems,
  checkResult: checkConfluenceResult,
  merge: (card, record) => mergeConfluenceResult(card, record),
  summarize: summarizeConfluenceApplication,
  uploads: cardUploads,
};

/**
 * Applies a gateway-prepared card of `kind` through the gateway; the card's
 * items get the per-item results. Throws the card's error text.
 */
export function applyOnGateway(
  card: ApprovalCard,
  kind: "jiraIssue" | "confluencePage",
): Promise<Applied> {
  return kind === "jiraIssue"
    ? applyWith(JIRA, card)
    : applyWith(CONFLUENCE, card);
}

async function applyWith<Item, Rec extends object>(
  kind: GatewayKind<Item, Rec>,
  card: ApprovalCard,
): Promise<Applied> {
  const body = kind.body(card);
  if (!body) throw new Error(`Mismatched approval body for ${card.kind}.`);
  if (!remoteToolPort()) throw new Error(NOT_CLIENT_MODE);
  const { site, items } = body;
  const sent = items.map((item) => kind.proposalOf(item));
  if (
    site === undefined ||
    !ATLASSIAN_SITE_RE.test(site) ||
    !kind.checkProposal(sent)
  )
    throw new Error(CANNOT_SEND);
  const sources = kind.uploads?.(sent);
  try {
    await remoteToolsReady(READY_WAIT_MS);
  } catch {
    throw new Error(UNREACHABLE);
  }
  let upload: { port: RemoteToolPort; apply: RemoteApplyUpload } | undefined;
  if (sources) {
    const port = route(kind);
    upload = {
      port,
      apply: await sendUploads(port.uploads, card.sessionId, sources),
    };
  }
  // From here to the send nothing is awaited (P6-O4): what is checked is
  // what holds when the request leaves. An upload is sent on this port's
  // connection, so another port (a mode switch) is not client mode.
  let port: RemoteToolPort;
  try {
    port = route(kind);
    if (upload && port !== upload.port) throw new Error(NOT_CLIENT_MODE);
  } catch (err) {
    if (upload) upload.port.uploads.release(upload.apply.uploadId);
    throw err;
  }
  const outcome = await port.apply(kind.name, site, sent, upload?.apply);
  return settle(
    kind,
    items,
    sent,
    site,
    outcome,
    upload ? MAY_HAVE_WRITTEN_UPLOAD : MAY_HAVE_WRITTEN,
  );
}

/** The port, when client mode, the connection, toggle and listing allow. */
function route<Item, Rec extends object>(
  kind: GatewayKind<Item, Rec>,
): RemoteToolPort {
  const port = remoteToolPort();
  if (!port) throw new Error(NOT_CLIENT_MODE);
  if (!remoteToolsConnected()) throw new Error(UNREACHABLE);
  if (!remoteProductEnabled(kind.product))
    throw new Error(DISABLED[kind.product]);
  if (!remoteToolDispatchable(kind.name, "two-phase"))
    throw new Error(NOT_OFFERED);
  return port;
}

/**
 * Opens the card's upload and sends every source (v02 AC5 steps 3-5, v03
 * K1): the sealed upload for the apply. Throws the card's text, nothing
 * written, after releasing what it opened.
 */
async function sendUploads(
  uploads: RemoteUploadPort,
  sessionId: string,
  sources: CardUploads,
): Promise<RemoteApplyUpload> {
  let opened;
  try {
    opened = await uploads.open(sources.streams, sources.work);
  } catch {
    throw new Error(UNREACHABLE);
  }
  // The edge's fixed text, busy or not (P8A-V10-O1).
  if (!opened.ok) throw new Error(withNothingWritten(opened.message));
  const { uploadId } = opened;
  try {
    for (const [index, stream] of sources.streams.entries())
      await sendSource(
        uploads,
        sessionId,
        uploadId,
        stream,
        index === sources.streams.length - 1,
      );
  } catch (err) {
    uploads.release(uploadId);
    throw err instanceof UploadStopped
      ? new Error(err.message)
      : new Error(UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
  }
  return { uploadId, work: sources.work };
}

/** A send that stopped with the card's own text. */
class UploadStopped extends Error {}

/**
 * One source's chunks, each put awaited before the next is read; then its
 * length and digest against the approved ones, and the edge's account of
 * the stream: complete, and sealed exactly when it is the last. A refused
 * put shows the edge's text; an answer that disagrees with the put, or a
 * staged copy that changed, is a changed source.
 */
async function sendSource(
  uploads: RemoteUploadPort,
  sessionId: string,
  uploadId: string,
  stream: RemoteUploadStream,
  last: boolean,
): Promise<void> {
  const changed = () =>
    new UploadStopped(UPLOAD_SOURCE_CHANGED_NOTHING_WRITTEN);
  let complete = false;
  let sealed = false;
  const read = await readStagedChunks(
    sessionId,
    stream,
    async (chunk, offset) => {
      let answer;
      try {
        answer = await uploads.put(
          uploadId,
          stream.stagedAttachmentId,
          offset,
          chunk,
        );
      } catch {
        throw new UploadStopped(UNREACHABLE);
      }
      // The edge's fixed text, as for open (requester ruling k1dz2xl1 #2):
      // an expired or invalid upload is not a changed file.
      if (!answer.ok)
        throw new UploadStopped(withNothingWritten(answer.message));
      const received = offset + chunk.byteLength;
      if (
        answer.received !== received ||
        answer.streamComplete !== (received === stream.size) ||
        (answer.sealed && !(last && received === stream.size))
      )
        throw changed();
      complete = answer.streamComplete;
      sealed = answer.sealed;
    },
  );
  if (
    !read ||
    read.size !== stream.size ||
    read.sha256 !== stream.sha256 ||
    !complete ||
    sealed !== last
  )
    throw changed();
}

/** The card's outcome from the link's, by the table in the header. */
function settle<Item, Rec extends object>(
  kind: GatewayKind<Item, Rec>,
  items: Item[],
  sent: Item[],
  site: string,
  outcome: RemoteApplyOutcome,
  uncertain: string,
): Applied {
  switch (outcome.outcome) {
    case "notSent":
      throw new Error(UNREACHABLE);
    case "lost":
    case "timeout":
    case "undecodable":
      throw new Error(uncertain);
    case "answer":
      return answered(kind, items, sent, site, outcome.answer, uncertain);
  }
}

function answered<Item, Rec extends object>(
  kind: GatewayKind<Item, Rec>,
  items: Item[],
  sent: Item[],
  site: string,
  answer: RemoteApplyAnswer,
  uncertain: string,
): Applied {
  const trimmed = answer.trimmed === true;
  if (!answer.ok) {
    if (answer.effects === "none")
      throw new Error(
        answer.code === "unknown_tool"
          ? NOT_OFFERED
          : withNothingWritten(
              answer.message || `${kind.name} failed on the gateway.`,
            ),
      );
    // What the edge's working copy shows, when every record passes.
    if (answer.results)
      mergeChecked(kind, items, sent, site, answer.results, trimmed);
    throw new Error(uncertain);
  }
  const { results } = answer;
  if (
    (answer.effects === "none" && results.some(mayHaveWritten)) ||
    !mergeChecked(kind, items, sent, site, results, trimmed)
  )
    throw new Error(uncertain);
  const notes = trimmed ? [TRIMMED] : [];
  let summary: Applied;
  try {
    summary = kind.summarize(items);
  } catch (err) {
    // Every item failed. Only the root certificate may say nothing was
    // written, never a count of errors.
    const text = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        text,
        ...notes,
        answer.effects === "none" ? NOTHING_WRITTEN : PARTIAL_EFFECTS,
      ].join(" "),
    );
  }
  const partial = results.some(
    (record) => mayHaveWritten(record) && failed(record),
  );
  const resultUrl = summary.resultUrl?.startsWith(`https://${site}/`)
    ? summary.resultUrl
    : undefined;
  return {
    resultSummary: [
      summary.resultSummary,
      ...notes,
      ...(partial ? [PARTIAL_EFFECTS] : []),
    ].join(" "),
    ...(resultUrl ? { resultUrl } : {}),
  };
}

/**
 * Checks every record against the item it answers, then merges them all;
 * false, with nothing merged, when the count or any record is wrong.
 */
function mergeChecked<Item, Rec extends object>(
  kind: GatewayKind<Item, Rec>,
  items: Item[],
  sent: Item[],
  site: string,
  records: readonly object[],
  trimmed: boolean,
): boolean {
  if (records.length !== sent.length) return false;
  const checked: Rec[] = [];
  for (const [index, record] of records.entries()) {
    if (!kind.checkResult(record, sent[index]!, site)) return false;
    checked.push(record);
  }
  for (const [index, record] of checked.entries())
    kind.merge(items[index]!, record, trimmed);
  return true;
}

const mayHaveWritten = (record: object): boolean =>
  "effects" in record && record.effects !== "none";

const failed = (record: object): boolean =>
  "error" in record && record.error !== undefined;
