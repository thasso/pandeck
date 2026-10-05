/**
 * Contacts domain layer: the general people directory reused across the
 * assistant (time-logging routing is one consumer, but it is NOT time-logging
 * specific). Owns id derivation, field normalization, dedup/merge policy, and
 * search/lookup over `db/contactStore.ts`. The store is pure row I/O; all rules
 * live here.
 *
 * Self-enriching by design (see the time-logging-routing plan): agents create
 * and merge contacts as they encounter people. Merge is identity-based
 * (email / jiraId / slackId) so re-observing a known person UPDATES rather than
 * duplicates. Privacy: names, roles, work ids, and routing area only — never
 * sensitive personal data.
 */
import { randomUUID } from "node:crypto";
import { contactStore, type ContactRow } from "./db/contactStore.ts";

export type Contact = ContactRow;

export interface ContactInput {
  /** Explicit id to target an existing contact; omit to create/merge by identity. */
  id?: string;
  name?: string;
  roles?: string[];
  email?: string | null;
  jiraId?: string | null;
  slackId?: string | null;
  ids?: Record<string, string>;
  areas?: string[];
  notes?: string | null;
}

const MAX_NAME = 200;
const MAX_NOTES = 2000;
const MAX_FIELD = 200;
const MAX_LIST = 25;

function clean(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanList(values: string[] | undefined, max: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw, max);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, MAX_LIST);
}

function cleanIdMap(
  map: Record<string, string> | undefined,
): Record<string, string> {
  if (!map || typeof map !== "object") return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const key = clean(rawKey, 40);
    const value = clean(rawValue, MAX_FIELD);
    if (key && value) out[key.toLowerCase()] = value;
  }
  return out;
}

/** Emails are matched case-insensitively; store the lowercase form. */
function normalizeEmail(value: string | null | undefined): string | null {
  const cleaned = clean(value, MAX_FIELD);
  return cleaned ? cleaned.toLowerCase() : null;
}

function deriveId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug
    ? `${slug}-${randomUUID().slice(0, 6)}`
    : `contact-${randomUUID().slice(0, 8)}`;
}

export interface UpsertContactResult {
  contact: Contact;
  created: boolean;
  merged: boolean;
}

/**
 * Create or merge a contact. Resolution order: explicit `id` → identity match
 * (email/jiraId/slackId) → new contact. Merging is field-wise: provided scalar
 * fields overwrite, arrays/id-maps union, so re-observing a person enriches
 * without clobbering existing knowledge. A create requires a name.
 */
export function upsertContact(input: ContactInput): UpsertContactResult {
  const now = Date.now();
  const email = normalizeEmail(input.email);
  const jiraId = clean(input.jiraId, MAX_FIELD);
  const slackId = clean(input.slackId, MAX_FIELD);

  const existing = input.id
    ? contactStore.get(input.id)
    : contactStore.findByIdentity({ email, jiraId, slackId });

  if (input.id && !existing) {
    throw new Error(`No contact with id "${input.id}".`);
  }

  const name = clean(input.name, MAX_NAME);
  if (!existing && !name) {
    throw new Error("Creating a contact requires a name.");
  }

  const base: Contact = existing ?? {
    id: deriveId(name!),
    name: name!,
    roles: [],
    email: null,
    jiraId: null,
    slackId: null,
    ids: {},
    areas: [],
    notes: null,
    createdAt: now,
    updatedAt: now,
  };

  const merged: Contact = {
    id: base.id,
    name: name ?? base.name,
    roles:
      input.roles !== undefined
        ? cleanList([...base.roles, ...input.roles], MAX_FIELD)
        : base.roles,
    email: email ?? base.email,
    jiraId: jiraId ?? base.jiraId,
    slackId: slackId ?? base.slackId,
    ids:
      input.ids !== undefined
        ? { ...base.ids, ...cleanIdMap(input.ids) }
        : base.ids,
    areas:
      input.areas !== undefined
        ? cleanList([...base.areas, ...input.areas], MAX_FIELD)
        : base.areas,
    notes:
      input.notes !== undefined ? clean(input.notes, MAX_NOTES) : base.notes,
    createdAt: base.createdAt,
    updatedAt: now,
  };

  contactStore.put(merged);
  return {
    contact: merged,
    created: !existing,
    merged: Boolean(existing && !input.id),
  };
}

/** Replace a contact's roles/areas outright (not union) — for corrections. */
export function setContactFields(
  id: string,
  fields: { roles?: string[]; areas?: string[] },
): Contact {
  const existing = contactStore.get(id);
  if (!existing) throw new Error(`No contact with id "${id}".`);
  const next: Contact = {
    ...existing,
    roles:
      fields.roles !== undefined
        ? cleanList(fields.roles, MAX_FIELD)
        : existing.roles,
    areas:
      fields.areas !== undefined
        ? cleanList(fields.areas, MAX_FIELD)
        : existing.areas,
    updatedAt: Date.now(),
  };
  contactStore.put(next);
  return next;
}

export function getContact(id: string): Contact | null {
  return contactStore.get(id);
}

export function deleteContact(id: string): boolean {
  return contactStore.remove(id);
}

function score(contact: Contact, terms: string[]): number {
  const haystack = [
    contact.name,
    contact.email ?? "",
    contact.jiraId ?? "",
    contact.slackId ?? "",
    ...contact.roles,
    ...contact.areas,
    ...Object.values(contact.ids),
  ]
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits;
}

export interface ContactLookup {
  query?: string;
  id?: string;
  email?: string;
  jiraId?: string;
  slackId?: string;
  area?: string;
  limit?: number;
}

/**
 * Lookup contacts by explicit identity (id/email/jiraId/slackId), by area, or by
 * a free-text query over name/roles/areas/ids. Identity matches return the exact
 * contact; otherwise results are ranked by term-hit count, bounded by `limit`.
 */
export function lookupContacts(lookup: ContactLookup): Contact[] {
  const limit = Math.min(Math.max(lookup.limit ?? 10, 1), 50);

  if (lookup.id) {
    const found = contactStore.get(lookup.id);
    return found ? [found] : [];
  }
  const email = normalizeEmail(lookup.email);
  const jiraId = clean(lookup.jiraId, MAX_FIELD);
  const slackId = clean(lookup.slackId, MAX_FIELD);
  if (email || jiraId || slackId) {
    const found = contactStore.findByIdentity({ email, jiraId, slackId });
    return found ? [found] : [];
  }

  let candidates = contactStore.listAll();
  const area = clean(lookup.area, MAX_FIELD)?.toLowerCase();
  if (area) {
    candidates = candidates.filter((c) =>
      c.areas.some((a) => a.toLowerCase() === area),
    );
  }

  const query = clean(lookup.query, MAX_FIELD);
  if (!query) return candidates.slice(0, limit);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return candidates
    .map((contact) => ({ contact, s: score(contact, terms) }))
    .filter((row) => row.s > 0)
    .sort((a, b) => b.s - a.s || a.contact.name.localeCompare(b.contact.name))
    .slice(0, limit)
    .map((row) => row.contact);
}

/** Compact projection for tool output (drops empty fields). */
export function projectContact(contact: Contact): Record<string, unknown> {
  const out: Record<string, unknown> = { id: contact.id, name: contact.name };
  if (contact.roles.length) out.roles = contact.roles;
  if (contact.email) out.email = contact.email;
  if (contact.jiraId) out.jiraId = contact.jiraId;
  if (contact.slackId) out.slackId = contact.slackId;
  if (Object.keys(contact.ids).length) out.ids = contact.ids;
  if (contact.areas.length) out.areas = contact.areas;
  if (contact.notes) out.notes = contact.notes;
  return out;
}
