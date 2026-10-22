/**
 * Inbound WebSocket trust boundary: validate every {@link ClientMessage} before
 * it reaches {@link Connection.handle}. The web client emits well-typed messages,
 * but the socket is untrusted input — malformed payloads would otherwise surface
 * as opaque `TypeError`s (`msg.text.trim()`, `request.title.trim()`) or silently
 * corrupt `settings.json` via `updateSettings(msg.patch)`.
 *
 * Dependency-free by design (no zod): a small per-type validator registry keyed
 * by `ClientMessage["type"]`. Each entry's field spec is mapped from its own
 * message variant: every field, including optional fields, needs a check, and
 * extra spec keys fail compilation. Custom checks refine those same specs.
 * New message types or fields fail the build until covered. Lookup uses a `Map`
 * so untrusted `raw.type` (`"__proto__"`, `"constructor"`, …) cannot select a
 * bogus validator via the prototype chain.
 *
 * Depth is proportional to risk: rigorous on the flagged sinks (`updateSettings`
 * persisted sections, `saveTask.request.title`) and required handler arguments,
 * shallow structural checks (right field present, right primitive/array/object
 * kind) elsewhere. Enum/string-union values are validated as strings only —
 * over-validation here risks rejecting legitimate messages, and downstream code
 * normalizes those values.
 */
import {
  BROADCAST_TOPICS,
  INITIATIVE_LAYOUT_COLLAPSE_LIMIT,
  isHarness,
  isSessionPeerTurnCap,
  isPeerRuntimeRelativeCost,
  MAX_INBOX_POSITIONS,
  MAX_PEER_RUNTIME_DESCRIPTION_CHARS,
  PULL_REQUEST_CARD_ACTIONS,
  PULL_REQUEST_MERGE_METHODS,
  SPEECH_TO_TEXT_LIMITS,
  WORKFLOW_ROLE_SET_BOUNDS,
  type BroadcastTopic,
  type ClientMessage,
} from "@assistant/shared";
import {
  SETTINGS_REGISTRY,
  type SettingValueSpec,
} from "@assistant/shared/settingsRegistry";

/* ------------------------------ kind predicates ----------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/* ------------------------------ field-spec helper --------------------------- */

interface FieldCheck {
  check: (value: unknown) => boolean;
  /** Human label of the expected kind, used in rejection reasons. */
  kind: string;
}

interface FieldSpec extends FieldCheck {
  optional?: false;
}

/** Reusable kind specs for the field checkers below. */
const STRING: FieldSpec = { check: isString, kind: "a string" };
const BOOLEAN: FieldSpec = { check: isBoolean, kind: "a boolean" };
const NUMBER: FieldSpec = { check: isFiniteNumber, kind: "a finite number" };
/** A count or revision: never negative, never fractional, never a float id. */
const COUNT: FieldSpec = {
  check: (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0,
  kind: "a non-negative integer",
};
const STRING_ARRAY: FieldSpec = {
  check: isStringArray,
  kind: "a string array",
};
const ARRAY: FieldSpec = { check: Array.isArray, kind: "an array" };
/** A map's collapsed epics: bounded Task ids, the server drops what does not apply. */
const COLLAPSED_EPICS: FieldSpec = {
  check: (value: unknown) =>
    isStringArray(value) &&
    value.length <= INITIATIVE_LAYOUT_COLLAPSE_LIMIT &&
    value.every((id) => id.length > 0 && id.length <= 32),
  kind: `at most ${INITIATIVE_LAYOUT_COLLAPSE_LIMIT} Task ids`,
};
const OBJECT: FieldSpec = { check: isPlainObject, kind: "an object" };
/** The grant keys one scope change names: a session's own list, bounded. */
const GRANT_KEYS: FieldSpec = {
  check: (value: unknown) =>
    isStringArray(value) &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.every((key) => key.length > 0 && key.length <= 4096),
  kind: "1 to 256 grant keys",
};
/** A compaction window in whole tokens, or `null` to clear it. */
const COMPACTION_WINDOW_TOKENS: FieldSpec = {
  check: (value: unknown) =>
    value === null || (Number.isSafeInteger(value) && (value as number) > 0),
  kind: "a positive integer or null",
};

/**
 * The background updates a Recover or Dismiss names: one Recover's worth at
 * most (`BACKGROUND_RECOVERY_BATCH`), each a bounded safe identity.
 */
const BACKGROUND_REFS: FieldSpec = {
  check: (value: unknown) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every(
      (ref) =>
        isPlainObject(ref) &&
        isString(ref.itemId) &&
        ref.itemId.length > 0 &&
        ref.itemId.length <= 200 &&
        Number.isSafeInteger(ref.revision) &&
        (ref.revision as number) >= 0 &&
        (ref.attemptId === null ||
          (isString(ref.attemptId) &&
            ref.attemptId.length > 0 &&
            ref.attemptId.length <= 200)),
    ),
  kind: "1 to 20 background update identities",
};

interface OptionalFieldSpec extends FieldCheck {
  optional: true;
}

function optional(spec: FieldSpec): OptionalFieldSpec {
  return { ...spec, optional: true };
}

type MessageFields<K extends ClientMessage["type"]> = Omit<
  Extract<ClientMessage, { type: K }>,
  "type"
>;

/** All wire fields need a spec, even when the client may omit them. */
export type MessageFieldSpecs<K extends ClientMessage["type"]> =
  keyof MessageFields<K> extends never
    ? Record<string, never>
    : {
        [P in keyof MessageFields<K>]-?: Record<never, never> extends Pick<
          MessageFields<K>,
          P
        >
          ? OptionalFieldSpec
          : FieldSpec;
      };

type FieldSpecMap = Record<string, FieldSpec>;

/** Each present field must be the right kind. Absent fields are allowed. */
function checkOptionalFields(
  obj: Record<string, unknown>,
  spec: FieldSpecMap,
): string | null {
  for (const [field, { check, kind }] of Object.entries(spec)) {
    if (hasOwn(obj, field) && obj[field] !== undefined && !check(obj[field])) {
      return `${field} must be ${kind}`;
    }
  }
  return null;
}

/** Every listed field must be present and the right kind. */
function checkRequiredFields(
  obj: Record<string, unknown>,
  spec: FieldSpecMap,
): string | null {
  for (const [field, { check, kind }] of Object.entries(spec)) {
    if (!hasOwn(obj, field) || obj[field] === undefined)
      return `${field} is required and must be ${kind}`;
    if (!check(obj[field])) return `${field} must be ${kind}`;
  }
  return null;
}

type Validator = (msg: Record<string, unknown>) => string | null;

interface MessageSpec {
  fields: Record<string, FieldSpec | OptionalFieldSpec>;
  refine?: Validator;
}

type MessageRegistry = {
  [K in ClientMessage["type"]]: {
    fields: MessageFieldSpecs<K>;
    refine?: Validator;
  };
};

/** Preserve literal keys so the registry can reject extra spec fields too. */
function fields<
  R extends FieldSpecMap,
  O extends FieldSpecMap = Record<never, never>,
>(
  required: R,
  optionalFields?: O & Record<Extract<keyof R, keyof O>, never>,
  refine?: Validator,
): {
  // Infer keys only from arguments, never from a registry entry's context.
  fields: NoInfer<R> & { [P in keyof NoInfer<O>]: OptionalFieldSpec };
  refine?: Validator;
} {
  const optionalSpecs = Object.fromEntries(
    Object.entries(optionalFields ?? {}).map(([key, spec]) => [
      key,
      optional(spec),
    ]),
  ) as { [P in keyof O]: OptionalFieldSpec };
  return {
    fields: { ...required, ...optionalSpecs },
    ...(refine ? { refine } : {}),
  };
}

/** Structural assignability alone would allow extra keys returned by fields(). */
function defineRegistry<R extends MessageRegistry>(
  registry: R &
    Record<Exclude<keyof R, keyof MessageRegistry>, never> & {
      [K in keyof MessageRegistry]: {
        fields: Record<
          Exclude<keyof R[K]["fields"], keyof MessageFieldSpecs<K>>,
          never
        >;
      };
    },
): R {
  return registry;
}

/** Zero-payload messages still participate in the per-field contract. */
const NONE = fields({});

/** Run every field check before the optional whole-message refinement. */
function compileValidator(spec: MessageSpec): Validator {
  return (msg) => {
    for (const [field, check] of Object.entries(spec.fields)) {
      if (!hasOwn(msg, field) || msg[field] === undefined) {
        if ("optional" in check && check.optional) continue;
        return `${field} is required and must be ${check.kind}`;
      }
      if (!check.check(msg[field])) return `${field} must be ${check.kind}`;
    }
    return spec.refine?.(msg) ?? null;
  };
}

const LIVE_BODY_KINDS = new Set(["thinking", "toolInput", "toolOutput"]);

/** A bounded list of well-formed body keys; the handler scopes them to the viewed session. */
const validateSetLiveBodySubscriptions: Validator = (msg) => {
  const required = checkRequiredFields(msg, {
    sessionId: STRING,
    bodies: ARRAY,
  });
  if (required) return required;
  const bodies = msg.bodies as unknown[];
  if (bodies.length > 200) return "bodies must hold at most 200 keys";
  for (const body of bodies) {
    if (!isPlainObject(body)) return "bodies must hold objects";
    const key = body as Record<string, unknown>;
    if (!isString(key.streamId)) return "bodies[].streamId must be a string";
    if (!Number.isSafeInteger(key.blockIndex) || (key.blockIndex as number) < 0)
      return "bodies[].blockIndex must be a non-negative integer";
    if (!isString(key.kind) || !LIVE_BODY_KINDS.has(key.kind))
      return "bodies[].kind must be a live body kind";
  }
  return null;
};

/* --------------------------- prompt attachments ----------------------------- */

// PromptAttachment fields dereferenced immediately after dispatch: PiLiveSession
// inspects `a.mimeType.startsWith(...)`, `a.name`, `a.id`, `a.data`, `a.size`,
// and Claude attachment saving relies on `id`/`name`/`data`. Validate those
// kinds so a `{}` or wrong-kind entry can't crash the handler.
const ATTACHMENT_REQUIRED: FieldSpecMap = {
  id: STRING,
  name: STRING,
  mimeType: STRING,
  data: STRING,
  size: NUMBER,
};
const ATTACHMENT_OPTIONAL: FieldSpecMap = { role: STRING };

/**
 * An approval decision, optionally carrying the user's per-row edits. Only the
 * structure is checked here: which rows exist, and whether a model/account the
 * edit names may actually run, is the executor's `prepare` decision — it can
 * refuse while leaving the card pending, which this boundary cannot.
 */
/** Room for any token plus surrounding whitespace; the executor trims and re-bounds it. */
const MAX_SETTINGS_INPUT_CHARS = 16_384;

function validateResolveApproval(msg: Record<string, unknown>): string | null {
  const required = checkRequiredFields(msg, {
    approvalId: STRING,
    decision: STRING,
  });
  if (required) return required;
  const forSession = checkOptionalFields(msg, {
    forSession: BOOLEAN,
    grantInheritable: BOOLEAN,
  });
  if (forSession) return forSession;
  if (!hasOwn(msg, "edits") || msg.edits === undefined) return null;
  if (!isPlainObject(msg.edits)) return "edits must be an object";
  if (!isString(msg.edits.kind)) return "edits.kind must be a string";
  // A settings-input secret: kind-checked and bounded here, judged by the
  // card's executor. The value itself never appears in a rejection reason.
  if (msg.edits.kind === "settingsInput")
    return isString(msg.edits.value) &&
      msg.edits.value.length <= MAX_SETTINGS_INPUT_CHARS
      ? null
      : `edits.value must be a string of at most ${MAX_SETTINGS_INPUT_CHARS} characters`;
  // A grant request selection: shape only; the card's executor judges which
  // keys and which cap it may carry.
  if (msg.edits.kind === "approvalGrantsRequest") {
    if (!Array.isArray(msg.edits.keys)) return "edits.keys must be an array";
    for (const key of msg.edits.keys) {
      if (!isPlainObject(key)) return "each edits.keys entry must be an object";
      const entry = checkRequiredFields(key, {
        key: STRING,
        inheritable: BOOLEAN,
      });
      if (entry) return entry;
    }
    return checkOptionalFields(msg.edits, { peerTurnCap: NUMBER });
  }
  if (!Array.isArray(msg.edits.items)) return "edits.items must be an array";
  for (const item of msg.edits.items) {
    if (!isPlainObject(item)) return "each edits.items entry must be an object";
    const rowId = checkRequiredFields(item, { rowId: STRING });
    if (rowId) return rowId;
    const optional = checkOptionalFields(item, {
      skip: BOOLEAN,
      owner: STRING,
      provider: STRING,
      modelId: STRING,
      credentialProfileId: STRING,
      thinkingLevel: STRING,
    });
    if (optional) return optional;
    if (
      item.owner !== undefined &&
      item.owner !== "coordinator" &&
      item.owner !== "user"
    )
      return 'edits.items owner must be "coordinator" or "user"';
  }
  return null;
}

/** A jump target: the two kinds carry different ids, so each is checked as its own shape. */
function validateTimelineAnchorTarget(
  msg: Record<string, unknown>,
): string | null {
  const required = checkRequiredFields(msg, { requestId: STRING });
  if (required) return required;
  const target = msg.target;
  if (!isPlainObject(target)) return "target must be an object";
  if (target.kind === "peerPrompt")
    return checkRequiredFields(target, { messageKey: STRING })
      ? "target.messageKey is required and must be a string"
      : null;
  if (target.kind === "entry")
    return checkRequiredFields(target, { sessionId: STRING, entryId: STRING })
      ? "target.sessionId and target.entryId are required and must be strings"
      : null;
  if (target.kind === "approval")
    return checkRequiredFields(target, { approvalId: STRING })
      ? "target.approvalId is required and must be a string"
      : null;
  return "target.kind must be peerPrompt, entry or approval";
}

function validateTimelineCache(value: unknown): string | null {
  if (!isPlainObject(value)) return "timelineCache must be an object";
  const fieldsError = checkRequiredFields(value, {
    projectionVersion: NUMBER,
    startIndex: NUMBER,
    entryCount: NUMBER,
    lastEntryId: {
      check: (v) => v === null || isString(v),
      kind: "a string or null",
    },
    lastEntrySeq: {
      check: (v) => v === null || isFiniteNumber(v),
      kind: "a finite number or null",
    },
    fingerprint: STRING,
  });
  if (fieldsError) return `timelineCache.${fieldsError}`;
  if (
    !Number.isInteger(value.projectionVersion) ||
    (value.projectionVersion as number) < 1
  )
    return "timelineCache.projectionVersion must be a positive integer";
  if (!Number.isInteger(value.entryCount) || (value.entryCount as number) < 0)
    return "timelineCache.entryCount must be a non-negative integer";
  if (!Number.isInteger(value.startIndex) || (value.startIndex as number) < 0)
    return "timelineCache.startIndex must be a non-negative integer";
  if (
    value.lastEntrySeq !== null &&
    (!Number.isInteger(value.lastEntrySeq) ||
      (value.lastEntrySeq as number) < 0)
  )
    return "timelineCache.lastEntrySeq must be null or a non-negative integer";
  if (
    (value.entryCount as number) === 0 &&
    (value.lastEntryId !== null || value.lastEntrySeq !== null)
  )
    return "an empty timelineCache must have null anchors";
  if (
    (value.entryCount as number) > 0 &&
    (typeof value.lastEntryId !== "string" || value.lastEntrySeq === null)
  )
    return "a non-empty timelineCache requires last-entry anchors";
  return null;
}

function validateAttachments(value: unknown): string | null {
  if (!Array.isArray(value)) return "must be an array";
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isPlainObject(item)) return `[${i}] must be an object`;
    const required = checkRequiredFields(item, ATTACHMENT_REQUIRED);
    if (required) return `[${i}].${required}`;
    const optional = checkOptionalFields(item, ATTACHMENT_OPTIONAL);
    if (optional) return `[${i}].${optional}`;
  }
  return null;
}

/** Reason for an optional `attachments` array on a message, prefixed for context. */
function checkAttachments(msg: Record<string, unknown>): string | null {
  if (!hasOwn(msg, "attachments") || msg.attachments === undefined) return null;
  const reason = validateAttachments(msg.attachments);
  if (!reason) return null;
  return `attachments${reason.startsWith("[") ? "" : " "}${reason}`;
}

/* ------------------------- updateSettings (key sink) ------------------------ */

/**
 * The wire kind of a registry value. Kinds are all a settings message must
 * get right: bounds and vocabularies stay with the normalizers, which clamp a
 * hand-edited or older client's value instead of refusing it. The agent path
 * is strict on top (`settingValueError` in `settingsPatchForWrites`).
 */
function kindOf(spec: SettingValueSpec): FieldSpec | undefined {
  switch (spec.kind) {
    case "boolean":
      return BOOLEAN;
    case "string":
    case "enum":
      return STRING;
    case "integer":
    case "number":
      return NUMBER;
    case "json":
      return undefined;
  }
}

/**
 * The one MAP-valued setting: global skill toggles
 * ([Task-613](pa://task/613)). Its keys are declared skill names, so there is
 * no field spec to check — every value must be exactly one of the two states.
 * A wrong-kind value is rejected rather than normalized away, so a client that
 * misunderstands the section cannot quietly erase a toggle the user set.
 */
function validateSkillToggles(value: unknown): string | null {
  if (!isPlainObject(value)) return "must be an object";
  for (const [name, state] of Object.entries(value))
    if (state !== "on" && state !== "off")
      return `.${name} must be "on" or "off"`;
  return null;
}

/**
 * Dictation corrections. The vocabulary is replaced whole and its normalizer
 * answers a non-array with an empty list, so an unchecked malformed patch
 * would silently delete every correction the user added.
 */
function validateVocabulary(vocabulary: unknown): string | null {
  if (!Array.isArray(vocabulary)) return "must be an array";
  if (vocabulary.length > SPEECH_TO_TEXT_LIMITS.vocabularyEntries)
    return `must have at most ${SPEECH_TO_TEXT_LIMITS.vocabularyEntries} entries`;
  for (let i = 0; i < vocabulary.length; i += 1) {
    const entry: unknown = vocabulary[i];
    if (!isPlainObject(entry)) return `[${i}] must be an object`;
    const reason = checkRequiredFields(entry, { from: STRING, to: STRING });
    if (reason) return `[${i}].${reason}`;
  }
  return null;
}

/**
 * The approved peer runtimes ([Task-595](pa://task/595)).
 *
 * A patch here REPLACES the whole roster, and the normalizer answers "not an
 * array" with an empty list — so an unvalidated `peerSpawnRuntimes: "oops"`
 * would not be rejected, it would silently delete every runtime the user
 * approved. Rejecting the malformed patch is the only outcome that preserves
 * the standing approvals.
 */
function validatePeerSpawnRuntimes(value: unknown): string | null {
  if (!Array.isArray(value)) return "must be an array";
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!isPlainObject(row)) return `[${i}] must be an object`;
    const required = checkRequiredFields(row, {
      id: STRING,
      modelId: STRING,
    });
    if (required) return `[${i}].${required}`;
    // `thinkingLevel` is kind-checked and no more. A vocabulary check here
    // cannot tell a client INVENTING a level from one PRESERVING the level a
    // row already stores — this patch replaces the whole roster, so every edit
    // resends every row — and rejecting the message would freeze renaming,
    // enabling or re-picking the model of a legacy row behind replacing its
    // level, which is the opposite of retaining it for repair. Nothing is lost:
    // settings store the value verbatim, `peerRuntimeUnavailableReason` refuses
    // any level outside the vocabulary, and `resolveApprovedPeerRuntime` will
    // not spawn on it. An unrecognized level can be recorded; it can never run.
    // Relative cost is different: read normalization maps every legacy invalid
    // label to `unknown`, so no legitimate round trip needs to preserve one and
    // a newly invented label can be rejected without making a row unsavable.
    const optional = checkOptionalFields(row, {
      name: STRING,
      relativeCost: STRING,
      description: STRING,
      credentialProfileId: STRING,
      provider: STRING,
      thinkingLevel: STRING,
      enabled: BOOLEAN,
    });
    if (optional) return `[${i}].${optional}`;
    if (
      row.relativeCost !== undefined &&
      !isPeerRuntimeRelativeCost(row.relativeCost)
    )
      return `[${i}].relativeCost must be low, medium, high, or unknown`;
    if (
      typeof row.description === "string" &&
      row.description.length > MAX_PEER_RUNTIME_DESCRIPTION_CHARS
    )
      return `[${i}].description must be at most ${MAX_PEER_RUNTIME_DESCRIPTION_CHARS} characters`;
  }
  return null;
}

/**
 * Deep checks for the `json` settings, which are written whole. Keyed by
 * registry path; a test requires one for every `json` descriptor. A reason
 * starting with `.` or `[` names a part inside the value.
 */
export const JSON_SETTING_VALIDATORS: Record<
  string,
  (value: unknown) => string | null
> = {
  "models.hidden": (value) =>
    isStringArray(value) ? null : "must be a string array",
  "models.order": (value) =>
    isStringArray(value) ? null : "must be a string array",
  "speechToText.vocabulary": validateVocabulary,
  skills: validateSkillToggles,
  peerSpawnRuntimes: validatePeerSpawnRuntimes,
};

/**
 * The registry settings checked against every settings patch: the writable
 * ones, and the read-only ones a client echoes back, which declare the kind
 * they read as.
 */
const CHECKED_SETTINGS = SETTINGS_REGISTRY.filter(
  (descriptor) =>
    descriptor.value &&
    (descriptor.access === "value" || descriptor.access === "readonly"),
);

/**
 * Why an `AppSettings` patch must not reach `updateSettings`, or null. Shared
 * by the socket message and the agent write path (`settingsService.ts`).
 *
 * The checks come from the settings registry
 * (`@assistant/shared/settingsRegistry`): every present leaf of a checked
 * setting must be its registry kind, every object on the way to it must be an
 * object, and every `json` setting passes its deep check. Fields the registry
 * does not name are left to the normalizers, which ignore them.
 */
export function appSettingsPatchError(patch: unknown): string | null {
  if (!isPlainObject(patch)) return "patch must be an object";
  for (const descriptor of CHECKED_SETTINGS) {
    const keys = descriptor.path.split(".");
    let node: Record<string, unknown> = patch;
    let reached = true;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i]!;
      if (!hasOwn(node, key) || node[key] === undefined) {
        reached = false;
        break;
      }
      const next = node[key];
      if (!isPlainObject(next))
        return `patch.${keys.slice(0, i + 1).join(".")} must be an object`;
      node = next;
    }
    const leaf = keys[keys.length - 1]!;
    if (!reached || !hasOwn(node, leaf) || node[leaf] === undefined) continue;
    const value = node[leaf];
    const spec = descriptor.value!;
    const kind = kindOf(spec);
    const reason = kind
      ? kind.check(value)
        ? null
        : `must be ${kind.kind}`
      : (JSON_SETTING_VALIDATORS[descriptor.path]?.(value) ?? null);
    if (reason)
      return `patch.${descriptor.path}${/^[.[]/.test(reason) ? "" : " "}${reason}`;
  }
  return null;
}

const validateUpdateSettings: Validator = (msg) =>
  appSettingsPatchError(msg.patch);

/* --------------------------- bespoke validators ----------------------------- */

// Topics select a fan-out set on the connection, so an unknown one is rejected
// rather than normalized downstream: it would silently subscribe to nothing.
const validateTopics: Validator = (msg) => {
  if (!Array.isArray(msg.topics)) return "topics must be an array";
  for (const topic of msg.topics) {
    if (!isString(topic) || !BROADCAST_TOPICS.includes(topic as BroadcastTopic))
      return `topics must name known broadcast topics (${BROADCAST_TOPICS.join(", ")})`;
  }
  if (msg.digests === undefined) return null;
  if (!Array.isArray(msg.digests)) return "digests must be an array";
  for (const topic of msg.digests) {
    if (topic !== "tasks" && topic !== "projects" && topic !== "initiatives")
      return "digests currently supports only tasks, projects and initiatives";
    if (!msg.topics.includes(topic))
      return "digests must be a subset of topics";
  }
  return null;
};

const validateGetStateItems: Validator = (msg) => {
  if (
    msg.topic !== "tasks" &&
    msg.topic !== "projects" &&
    msg.topic !== "initiatives"
  )
    return "topic must be tasks, projects or initiatives";
  if (!Array.isArray(msg.ids) || !msg.ids.every(isString))
    return "ids must be an array of strings";
  if (!isString(msg.requestId)) return "requestId must be a string";
  return null;
};

const validateSaveTask: Validator = (msg) => {
  if (!isPlainObject(msg.request)) return "request must be an object";
  // A create needs a title; an update may omit it to leave the stored one alone.
  // Other request fields are normalized downstream, so a plain-object guard is
  // sufficient there.
  const hasId = isString(msg.request.id) && msg.request.id.length > 0;
  if (msg.request.title !== undefined && !isString(msg.request.title))
    return "request.title must be a string";
  if (!hasId && !isString(msg.request.title))
    return "request.title is required when creating a task";
  return null;
};

const validatePrompt: Validator = checkAttachments;

const validateQueuePrompt: Validator = (msg) => {
  const required = checkRequiredFields(msg, {
    sessionId: STRING,
    text: STRING,
  });
  if (required) return required;
  const attachments = checkAttachments(msg);
  if (attachments) return attachments;
  if (!hasOwn(msg, "command") || msg.command === undefined) return null;
  if (!isPlainObject(msg.command)) return "command must be an object";
  const command = checkRequiredFields(msg.command, {
    name: STRING,
    rawArgs: STRING,
  });
  return command ? `command.${command}` : null;
};

const validateHarnessSend: Validator = (msg) => {
  if (!isString(msg.id)) return "id is required and must be a string";
  if (!isString(msg.harness)) return "harness is required and must be a string";
  if (!isHarness(msg.harness)) return "harness is not a known harness";
  if (!isString(msg.agentType))
    return "agentType is required and must be a string";
  if (!isString(msg.text)) return "text is required and must be a string";
  const attachments = checkAttachments(msg);
  if (attachments) return attachments;
  return null;
};

const validateNewSession: Validator = (msg) => {
  if (hasOwn(msg, "model") && msg.model !== undefined) {
    const model = msg.model;
    if (!isPlainObject(model)) return "model must be an object";
    if (!isString(model.provider)) return "model.provider must be a string";
    if (!isString(model.id)) return "model.id must be a string";
  }
  return null;
};

const validateAssignTaskProjects: Validator = (msg) => {
  if (!Array.isArray(msg.updates))
    return "updates is required and must be an array";
  for (let i = 0; i < msg.updates.length; i += 1) {
    const update = msg.updates[i];
    if (!isPlainObject(update)) return `updates[${i}] must be an object`;
    if (!isString(update.id)) return `updates[${i}].id must be a string`;
    if (update.projectId !== null && !isString(update.projectId))
      return `updates[${i}].projectId must be a string or null`;
  }
  return null;
};

/**
 * The ceiling gate's answer. `raise` is the only choice carrying numbers, and
 * they are the run's new ceilings — the handler floors them at each limit's
 * minimum and refuses to lower, but caps nothing: a raise at the gate is the
 * user's explicit decision, so this guards only the shape it dereferences.
 */
const validateAnswerWorkflowCeiling: Validator = (msg) => {
  const required = checkRequiredFields(msg, {
    runId: STRING,
    choice: STRING,
  });
  if (required) return required;
  const choice = msg.choice;
  if (
    choice !== "raise" &&
    choice !== "deliver" &&
    choice !== "re-evaluate" &&
    choice !== "cancel"
  )
    return "choice";
  if (choice !== "raise") return null;
  if (!isPlainObject(msg.raise)) return "raise";
  if (msg.raise.mode === "set") {
    if (!isPlainObject(msg.raise.ceilings)) return "raise.ceilings";
    const limits = checkRequiredFields(msg.raise.ceilings, {
      maxIterations: NUMBER,
      maxReviewPasses: NUMBER,
    });
    return limits ? `raise.ceilings.${limits}` : null;
  }
  if (msg.raise.mode !== "raise-by") return "raise.mode";
  if (!isPlainObject(msg.raise.amounts)) return "raise.amounts";
  const amounts = checkOptionalFields(msg.raise.amounts, {
    maxIterations: NUMBER,
    maxReviewPasses: NUMBER,
  });
  if (amounts) return `raise.amounts.${amounts}`;
  return typeof msg.raise.amounts.maxIterations === "number" ||
    typeof msg.raise.amounts.maxReviewPasses === "number"
    ? null
    : "raise.amounts";
};

const validateAnswerWorkflowCommitCheck: Validator = (msg) => {
  const required = checkRequiredFields(msg, {
    runId: STRING,
    choice: STRING,
  });
  if (required) return required;
  return msg.choice === "send-to-implementer" || msg.choice === "commit-anyway"
    ? null
    : "choice";
};

// The start handler re-validates semantics (known thinking level, prompt
// override bound); this guards the shape the handler dereferences.
const validateStartWorkflowRun: Validator = (msg) => {
  const required = checkRequiredFields(msg, {
    taskId: STRING,
    requestId: STRING,
    config: OBJECT,
  });
  if (required) return required;
  const startOptional = checkOptionalFields(msg, { baseBranch: STRING });
  if (startOptional) return startOptional;
  if (msg.limits !== undefined) {
    if (!isPlainObject(msg.limits)) return "limits";
    const limits = checkRequiredFields(msg.limits, {
      maxIterations: NUMBER,
      maxReviewPasses: NUMBER,
    });
    if (limits) return `limits.${limits}`;
  }
  const root = msg.config as Record<string, unknown>;
  if (!isPlainObject(root.coordinator))
    return "config.coordinator must be an object";
  const coordinatorError =
    checkRequiredFields(root.coordinator, {
      provider: STRING,
      modelId: STRING,
      thinkingLevel: STRING,
    }) ??
    checkOptionalFields(root.coordinator, {
      credentialProfileId: STRING,
      promptOverride: STRING,
    });
  if (coordinatorError) return `config.coordinator.${coordinatorError}`;
  if (!isPlainObject(root.roles)) return "config.roles must be an object";
  for (const role of ["implementer", "reviewer", "fixer", "verdict"] as const) {
    const candidates = root.roles[role];
    const bounds = WORKFLOW_ROLE_SET_BOUNDS[role];
    if (
      !Array.isArray(candidates) ||
      candidates.length < bounds.min ||
      candidates.length > bounds.max
    )
      return `config.roles.${role} must be an array of ${bounds.min}..${bounds.max} configurations`;
    for (const [index, config] of candidates.entries()) {
      const path = `config.roles.${role}[${index}]`;
      if (!isPlainObject(config)) return `${path} must be an object`;
      const roleError =
        checkRequiredFields(config, {
          provider: STRING,
          modelId: STRING,
          thinkingLevel: STRING,
          family: STRING,
        }) ??
        checkOptionalFields(config, {
          credentialProfileId: STRING,
          promptOverride: STRING,
          notes: STRING,
        });
      if (roleError) return `${path}.${roleError}`;
    }
  }
  const optional = checkOptionalFields(root, {
    earlyPush: BOOLEAN,
    ciTimeoutMs: NUMBER,
    ciPollIntervalMs: NUMBER,
    implementerPromptOverride: STRING,
    reviewerPromptOverride: STRING,
  });
  return optional ? `config.${optional}` : null;
};

const validateCommentTarget = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "target must be an object";
  switch (value.kind) {
    case "worktree":
      if (!isString(value.worktreeId))
        return "target.worktreeId must be a string";
      if (!isString(value.path)) return "target.path must be a string";
      if (value.side !== "old" && value.side !== "new")
        return "target.side must be 'old' or 'new'";
      return isString(value.revision)
        ? null
        : "target.revision must be a string";
    case "session":
      if (!isString(value.sessionId))
        return "target.sessionId must be a string";
      if (!isString(value.entryId)) return "target.entryId must be a string";
      return Number.isInteger(value.blockIndex)
        ? null
        : "target.blockIndex must be an integer";
    default:
      return "target.kind is invalid";
  }
};

const validateGenericAddComment: Validator = (msg) => {
  const targetError = validateCommentTarget(msg.target);
  if (targetError) return targetError;
  if (!isString(msg.body)) return "body is required and must be a string";
  const optional = checkOptionalFields(msg, { requestId: STRING });
  if (optional) return optional;
  if (msg.selectors === undefined) return null;
  const selectors = msg.selectors;
  if (!isPlainObject(selectors)) return "selectors must be an object";
  if (!isPlainObject(selectors.quote))
    return "selectors.quote must be an object";
  if (
    !isString(selectors.quote.exact) ||
    !isString(selectors.quote.prefix) ||
    !isString(selectors.quote.suffix)
  )
    return "selectors.quote fields must be strings";
  if (
    isPlainObject(msg.target) &&
    msg.target.kind === "worktree" &&
    selectors.quote.exact !== "" &&
    !isPlainObject(selectors.position)
  )
    return "selectors.position is required and must be an object";
  if (selectors.position !== undefined) {
    if (!isPlainObject(selectors.position))
      return "selectors.position must be an object";
    const { start, end } = selectors.position;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number)
    )
      return "selectors.position must be a positive integer range";
  }
  if (selectors.block !== undefined) {
    if (
      !isPlainObject(selectors.block) ||
      !isString(selectors.block.id) ||
      (selectors.block.endId !== undefined &&
        !isString(selectors.block.endId)) ||
      !Number.isInteger(selectors.block.occurrence) ||
      (selectors.block.occurrence as number) < 1
    )
      return "selectors.block must have an id and positive occurrence";
  }
  return null;
};

const validateAttachComments: Validator = (msg) => {
  if (!isStringArray(msg.threadIds))
    return "threadIds is required and must be a string array";
  if (msg.threadIds.length < 1 || msg.threadIds.length > 20)
    return "threadIds must contain between 1 and 20 ids";
  if (isString(msg.sessionId)) return null;
  const session = msg.session;
  if (!isPlainObject(session)) return "sessionId or session is required";
  if (session.kind === "existing") {
    if (!isString(session.sessionId))
      return "session.sessionId must be a string";
    return checkOptionalFields(session, { additionalPrompt: STRING });
  }
  if (session.kind === "new") {
    if (!isString(session.harness) || !isHarness(session.harness))
      return "session.harness must be 'pi' or 'claude-sdk'";
    const optional = checkOptionalFields(session, {
      agentType: STRING,
      modelProvider: STRING,
      modelId: STRING,
      thinkingLevel: STRING,
      mode: STRING,
      credentialProfileId: STRING,
      requiresEnterprise: BOOLEAN,
      additionalPrompt: STRING,
    });
    if (optional) return optional;
    return checkAttachments(session);
  }
  return "session.kind must be 'existing' or 'new'";
};

/* ------------------------------- the registry ------------------------------- */

// Each entry is bound to its own ClientMessage variant, with no missing or
// extra spec fields. The object only seeds the Map, never an untrusted lookup.
const REGISTRY = defineRegistry({
  prompt: fields(
    { text: STRING },
    {
      attachments: ARRAY,
      attachTaskId: STRING,
      projectId: STRING,
      fileContext: STRING,
      clientRequestId: STRING,
      skill: STRING,
    },
    validatePrompt,
  ),
  runSlashCommand: fields({ name: STRING, rawArgs: STRING }),
  queuePrompt: fields(
    { sessionId: STRING, text: STRING },
    { attachments: ARRAY, command: OBJECT },
    validateQueuePrompt,
  ),
  updateQueuedPrompt: fields({ sessionId: STRING, id: STRING, text: STRING }),
  removeQueuedPrompt: fields({ sessionId: STRING, id: STRING }),
  moveQueuedPrompt: fields({ sessionId: STRING, id: STRING, toIndex: NUMBER }),
  clearPromptQueue: fields({ sessionId: STRING }),
  sendQueuedPromptNow: fields({ sessionId: STRING, id: STRING }),
  resumePromptQueue: fields({ sessionId: STRING }),
  sendQueuedPeerPromptNow: fields({ sessionId: STRING, id: STRING }),
  withdrawQueuedPeerPrompt: fields({ sessionId: STRING, id: STRING }),
  recoverBackgroundUpdates: fields({
    sessionId: STRING,
    items: BACKGROUND_REFS,
  }),
  dismissBackgroundUpdates: fields({
    sessionId: STRING,
    items: BACKGROUND_REFS,
  }),
  acceptCommitDryRun: fields({ entryId: STRING }),
  respondToQuestion: fields({ response: OBJECT }),
  abort: NONE,
  loadTimelineBlock: fields({
    entryId: STRING,
    blockIndex: NUMBER,
    kind: STRING,
  }),
  setLiveBodySubscriptions: fields(
    { sessionId: STRING, bodies: ARRAY },
    {},
    validateSetLiveBodySubscriptions,
  ),
  loadTimelineRange: fields(
    { sessionId: STRING, beforeSeq: NUMBER },
    { limit: NUMBER },
  ),
  setModel: fields({ provider: STRING, id: STRING }),
  setThinkingLevel: fields({ level: STRING }),
  setSessionMode: fields({ mode: STRING }),
  refreshModels: fields({ requestId: STRING }),
  requestSettings: NONE,
  newSession: fields(
    { agentType: STRING },
    {
      harness: STRING,
      model: OBJECT,
      thinkingLevel: STRING,
      mode: STRING,
      worktreeId: STRING,
    },
    validateNewSession,
  ),
  loadSession: fields({ id: STRING }, { timelineCache: OBJECT }, (msg) => {
    const required = checkRequiredFields(msg, { id: STRING });
    if (required) return required;
    return hasOwn(msg, "timelineCache") && msg.timelineCache !== undefined
      ? validateTimelineCache(msg.timelineCache)
      : null;
  }),
  openPermanentAssistant: fields({}, { timelineCache: OBJECT }, (msg) =>
    hasOwn(msg, "timelineCache") && msg.timelineCache !== undefined
      ? validateTimelineCache(msg.timelineCache)
      : null,
  ),
  releasePermanentAssistant: fields({ sessionId: STRING }),
  loadArchivedSessions: NONE,
  resolveObjectLinks: fields({ requestId: STRING, uris: STRING_ARRAY }),
  deleteSession: fields({ id: STRING }, { requestId: STRING }),
  archiveSession: fields(
    { id: STRING },
    { archived: BOOLEAN, requestId: STRING },
  ),
  // `throughRevision` is REQUIRED: a settle that states no observed revision
  // would acknowledge whatever the server holds, hiding an outcome the client
  // never rendered.
  settleSession: fields(
    { id: STRING, throughRevision: COUNT },
    {
      settled: BOOLEAN,
      requestId: STRING,
    },
  ),
  // The failure the clicked row showed: its revision is required for the same
  // reason, and an omitted `errorAt` matches only a row with no error record.
  dismissSessionFailure: fields(
    { id: STRING, outcomeRevision: COUNT },
    { errorAt: COUNT, requestId: STRING },
  ),
  // Same rule for a Workflow Run's Settle (Task-677): the observed revision is
  // required, so a stale item cannot acknowledge an outcome it never rendered.
  settleWorkflowRun: fields(
    { runId: STRING, throughRevision: COUNT },
    { requestId: STRING },
  ),
  setInboxPositions: fields(
    { positions: ARRAY },
    { requestId: STRING },
    (msg) => {
      const { positions } = msg;
      if (!Array.isArray(positions) || positions.length === 0)
        return "positions is required and must be a non-empty array";
      if (positions.length > MAX_INBOX_POSITIONS)
        return `positions may carry at most ${MAX_INBOX_POSITIONS} entries`;
      for (const entry of positions as unknown[]) {
        if (!isPlainObject(entry)) return "each position must be an object";
        const missing =
          entry.kind === "session"
            ? checkRequiredFields(entry, { id: STRING, position: NUMBER })
            : entry.kind === "run"
              ? checkRequiredFields(entry, { runId: STRING, position: NUMBER })
              : 'each position\'s kind must be "session" or "run"';
        if (missing) return missing;
      }
      return null;
    },
  ),
  renameSession: fields({ id: STRING, title: STRING }, { requestId: STRING }),
  setCompactionWindow: fields(
    {
      sessionId: STRING,
      tokens: COMPACTION_WINDOW_TOKENS,
    },
    { requestId: STRING },
  ),
  regenerateSessionTitle: fields({ id: STRING }, { guidance: STRING }),
  setSpawnOwnership: fields(
    {
      id: STRING,
      ownership: {
        check: (value: unknown) =>
          value === "taken-over" || value === "coordinator",
        kind: '"taken-over" or "coordinator"',
      },
    },
    { requestId: STRING },
  ),
  acknowledgeMissingWorktree: fields({ id: STRING }),
  forkSession: fields({ id: STRING, entryId: STRING, position: STRING }),
  createDraftSession: fields(
    { agentType: STRING, draftText: STRING },
    { notice: STRING },
  ),
  listSessions: NONE,
  memoryList: fields({ requestId: STRING }, { filter: OBJECT }),
  memoryGet: fields({ requestId: STRING, id: STRING }),
  memoryMutate: fields({ requestId: STRING, operation: OBJECT }),
  memoryLoads: fields(
    { requestId: STRING, sessionId: STRING },
    { limit: NUMBER },
  ),
  memoryStatus: fields({ requestId: STRING }),
  resolveTimelineAnchor: fields(
    { requestId: STRING, target: OBJECT },
    {},
    validateTimelineAnchorTarget,
  ),
  updateSettings: fields(
    { patch: OBJECT },
    { requestId: STRING },
    validateUpdateSettings,
  ),
  updateJiraSettings: fields({ patch: OBJECT }),
  saveAndTestJiraSettings: fields({ patch: OBJECT }),
  testJiraSettings: NONE,
  updateConfluenceSettings: fields({ patch: OBJECT }),
  saveAndTestConfluenceSettings: fields({ patch: OBJECT }),
  testConfluenceSettings: NONE,
  updateTempoSettings: fields({ patch: OBJECT }),
  saveAndTestTempoSettings: fields({ patch: OBJECT }),
  testTempoSettings: NONE,
  updateGoogleSettings: fields({ patch: OBJECT }),
  saveAndTestGoogleSettings: fields({ patch: OBJECT }),
  testGoogleSettings: NONE,
  updateSlackSettings: fields({ patch: OBJECT }),
  saveAndTestSlackSettings: fields({ patch: OBJECT }),
  testSlackSettings: NONE,
  updateOpenAiCompatibleSettings: fields({ patch: OBJECT }),
  saveAndTestOpenAiCompatibleSettings: fields({ patch: OBJECT }),
  testOpenAiCompatibleSettings: NONE,
  updateBraveSettings: fields({ patch: OBJECT }),
  saveAndTestBraveSettings: fields({ patch: OBJECT }),
  testBraveSettings: NONE,
  updateContext7Settings: fields({ patch: OBJECT }),
  saveAndTestContext7Settings: fields({ patch: OBJECT }),
  testContext7Settings: NONE,
  updateGithubSettings: fields({ patch: OBJECT }),
  saveAndTestGithubSettings: fields({ patch: OBJECT }),
  testGithubSettings: NONE,
  updateForgejoSettings: fields({ patch: OBJECT }),
  saveAndTestForgejoSettings: fields({ patch: OBJECT }),
  testForgejoSettings: NONE,
  subscribe: fields({ topics: ARRAY }, { digests: ARRAY }, validateTopics),
  unsubscribe: fields({ topics: ARRAY }, {}, validateTopics),
  stopBackgroundWork: fields({ itemId: STRING, requestId: STRING }),
  stopAllBackgroundWork: fields({ ownerSessionId: STRING, requestId: STRING }),
  refreshUsage: NONE,
  listTasks: fields({ request: OBJECT }),
  getStateItems: fields(
    { topic: STRING, ids: STRING_ARRAY, requestId: STRING },
    {},
    validateGetStateItems,
  ),
  saveTask: fields(
    { request: OBJECT },
    { requestId: STRING },
    validateSaveTask,
  ),
  assignTaskProjects: fields(
    { updates: ARRAY },
    { requestId: STRING },
    validateAssignTaskProjects,
  ),
  listProjects: fields({}, { request: OBJECT }),
  getProject: fields({ id: STRING, requestId: STRING }),
  getInitiative: fields(
    { id: STRING, requestId: STRING },
    { collapsed: COLLAPSED_EPICS },
  ),
  saveProject: fields({ id: STRING, patch: OBJECT }, { requestId: STRING }),
  provisionProjectRepo: fields({ id: STRING }, { requestId: STRING }),
  removeProjectRepo: fields({ id: STRING }, { requestId: STRING }),
  archiveProject: fields({ id: STRING }, { requestId: STRING }),
  deleteProject: fields({ id: STRING }, { requestId: STRING }),
  reorderProjects: fields(
    { orderedIds: STRING_ARRAY },
    { placements: ARRAY, requestId: STRING },
  ),
  archiveTask: fields({ id: STRING }, { archived: BOOLEAN, requestId: STRING }),
  deleteTask: fields({ id: STRING }, { requestId: STRING }),
  getTask: fields({ id: STRING, requestId: STRING }),
  listComments: fields({ target: OBJECT }, { requestId: STRING }, (msg) =>
    validateCommentTarget(msg.target),
  ),
  unwatchComments: fields({ target: OBJECT }, {}, (msg) =>
    validateCommentTarget(msg.target),
  ),
  addComment: fields(
    { target: OBJECT, body: STRING },
    { requestId: STRING, selectors: OBJECT },
    validateGenericAddComment,
  ),
  replyComment: fields(
    { threadId: STRING, body: STRING },
    { parentId: STRING, requestId: STRING },
  ),
  resolveComment: fields(
    { threadId: STRING, resolved: BOOLEAN },
    { requestId: STRING },
  ),
  editComment: fields(
    { commentId: STRING, body: STRING },
    { requestId: STRING },
  ),
  deleteComment: fields(
    { threadId: STRING },
    { commentId: STRING, requestId: STRING },
  ),
  attachComments: fields(
    { threadIds: STRING_ARRAY },
    { sessionId: STRING, session: OBJECT, requestId: STRING },
    validateAttachComments,
  ),
  reorderTasks: fields(
    { orderedIds: STRING_ARRAY },
    { placements: ARRAY, requestId: STRING },
  ),
  cancelPostReloadContinuation: NONE,
  harnessSend: fields(
    { id: STRING, harness: STRING, agentType: STRING, text: STRING },
    {
      attachments: ARRAY,
      modelProvider: STRING,
      modelId: STRING,
      thinkingLevel: STRING,
      mode: STRING,
      attachTaskId: STRING,
      projectId: STRING,
      fileContext: STRING,
      worktreeId: STRING,
      createWorktreeInProjectId: STRING,
      agent: STRING,
      clientRequestId: STRING,
      requiresEnterprise: BOOLEAN,
      credentialProfileId: STRING,
    },
    validateHarnessSend,
  ),
  resolveApproval: fields(
    { approvalId: STRING, decision: STRING },
    { edits: OBJECT, forSession: BOOLEAN, grantInheritable: BOOLEAN },
    validateResolveApproval,
  ),
  revokeApprovalGrant: fields({ sessionId: STRING, key: STRING }),
  setSessionPeerTurnCap: fields({
    sessionId: STRING,
    cap: {
      check: (value) => value === null || isSessionPeerTurnCap(value),
      kind: "an integer from 1 to 16, or null",
    },
  }),
  grantApprovalForSession: fields(
    { sessionId: STRING, key: STRING },
    { inheritable: BOOLEAN },
  ),
  setApprovalGrantScope: fields({
    sessionId: STRING,
    keys: GRANT_KEYS,
    inheritable: BOOLEAN,
  }),
  resolvePullRequestCardTask: fields({
    cardId: STRING,
    taskId: {
      check: (value) => value === null || isString(value),
      kind: "a string or null",
    },
  }),
  pullRequestCardAction: fields(
    { cardId: STRING, action: STRING },
    {
      mergeMethod: STRING,
      deleteBranch: BOOLEAN,
      baseBranch: STRING,
      requestId: STRING,
    },
    (msg) => {
      if (!hasOwn(msg, "cardId") || !isString(msg.cardId))
        return "cardId is required and must be a string";
      if (
        !isString(msg.action) ||
        !(PULL_REQUEST_CARD_ACTIONS as readonly string[]).includes(msg.action)
      )
        return `action must be one of ${PULL_REQUEST_CARD_ACTIONS.join(", ")}`;
      // The method is a per-merge decision, so it is required exactly for `merge`
      // rather than defaulted here: no surface may merge with a method the user
      // did not pick.
      if (msg.action === "merge") {
        if (
          !isString(msg.mergeMethod) ||
          !(PULL_REQUEST_MERGE_METHODS as readonly string[]).includes(
            msg.mergeMethod,
          )
        )
          return `mergeMethod must be one of ${PULL_REQUEST_MERGE_METHODS.join(", ")} for a merge`;
        if (!isString(msg.baseBranch) || !msg.baseBranch)
          return "baseBranch is required for a merge";
      } else if (hasOwn(msg, "mergeMethod") && !isString(msg.mergeMethod)) {
        return "mergeMethod must be a string";
      }
      if (hasOwn(msg, "baseBranch") && !isString(msg.baseBranch))
        return "baseBranch must be a string";
      // Keeping the remote branch is an explicit opt-out, so only a real boolean
      // is accepted: a truthy string must never read as "delete it".
      if (hasOwn(msg, "deleteBranch") && typeof msg.deleteBranch !== "boolean")
        return "deleteBranch must be a boolean";
      if (hasOwn(msg, "requestId") && !isString(msg.requestId))
        return "requestId must be a string";
      return null;
    },
  ),
  listWorktrees: fields({}, { projectId: STRING }),
  proposeWorktreeName: fields(
    { projectId: STRING, requestId: STRING },
    { taskId: STRING, context: STRING },
  ),
  createWorktree: fields(
    { projectId: STRING, name: STRING },
    { taskId: STRING, sessionId: STRING },
  ),
  removeWorktree: fields(
    { worktreeId: STRING },
    { deleteBranch: BOOLEAN, force: BOOLEAN, requestId: STRING },
  ),
  startWorkflowRun: fields(
    { taskId: STRING, requestId: STRING, config: OBJECT },
    { baseBranch: STRING, limits: OBJECT },
    validateStartWorkflowRun,
  ),
  answerWorkflowCeiling: fields(
    { runId: STRING, choice: STRING },
    { raise: OBJECT },
    validateAnswerWorkflowCeiling,
  ),
  answerWorkflowCommitCheck: fields(
    { runId: STRING, choice: STRING },
    {},
    validateAnswerWorkflowCommitCheck,
  ),
  pauseWorkflowRun: fields({ runId: STRING }, { reason: STRING }),
  resumeWorkflowRun: fields({ runId: STRING }),
  cancelWorkflowRun: fields({ runId: STRING }),
  deleteWorkflowRun: fields({
    runId: STRING,
    deleteWorktree: BOOLEAN,
    archiveSessions: BOOLEAN,
  }),
  retryWorkflowRun: fields({ runId: STRING }),
  rebaseAndReviewWorkflowRun: fields({ runId: STRING }),
  // Same rule as `pullRequestCardAction`: this IS that merge, reached from the
  // run, so the method stays a per-merge decision the click has to carry and
  // keeping the remote branch stays an explicit boolean opt-out.
  mergeWorkflowRun: fields(
    { runId: STRING, mergeMethod: STRING },
    { deleteBranch: BOOLEAN, requestId: STRING },
    (msg) => {
      if (!hasOwn(msg, "runId") || !isString(msg.runId))
        return "runId is required and must be a string";
      if (
        !isString(msg.mergeMethod) ||
        !(PULL_REQUEST_MERGE_METHODS as readonly string[]).includes(
          msg.mergeMethod,
        )
      )
        return `mergeMethod must be one of ${PULL_REQUEST_MERGE_METHODS.join(", ")}`;
      if (hasOwn(msg, "deleteBranch") && typeof msg.deleteBranch !== "boolean")
        return "deleteBranch must be a boolean";
      if (hasOwn(msg, "requestId") && !isString(msg.requestId))
        return "requestId must be a string";
      return null;
    },
  ),
  cleanUpWorkflowRun: fields({ runId: STRING }, { requestId: STRING }),
  watchWorktree: fields({ worktreeId: STRING }),
  unwatchWorktree: fields({ worktreeId: STRING }),
  mergeWorktree: fields({ worktreeId: STRING }, { strategy: STRING }),
});

// Look up validators through a Map (clean lookup semantics, no prototype chain),
// so a spoofed `raw.type` of "__proto__"/"constructor"/"toString" cannot resolve
// to an inherited member and bypass validation.
const VALIDATORS = new Map<ClientMessage["type"], Validator>(
  (Object.entries(REGISTRY) as Array<[ClientMessage["type"], MessageSpec]>).map(
    ([type, spec]) => [type, compileValidator(spec)],
  ),
);

export type ValidateClientMessageResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; type: string; reason: string };

/**
 * Validate a parsed inbound WS payload against the per-type registry. On success
 * the payload is returned narrowed to {@link ClientMessage}; on failure the
 * offending message type and a structured reason are returned for a rejection.
 */
export function validateClientMessage(
  raw: unknown,
): ValidateClientMessageResult {
  if (!isPlainObject(raw))
    return { ok: false, type: "unknown", reason: "message must be an object" };
  const type = raw.type;
  if (!isString(type))
    return { ok: false, type: "unknown", reason: "missing string `type`" };
  const validator = VALIDATORS.get(type as ClientMessage["type"]);
  if (!validator) return { ok: false, type, reason: "unknown message type" };
  const reason = validator(raw);
  if (reason) return { ok: false, type, reason };
  return { ok: true, msg: raw as ClientMessage };
}
