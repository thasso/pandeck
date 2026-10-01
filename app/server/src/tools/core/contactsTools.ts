/**
 * Contacts tools: the agent surface over the general people directory
 * (`../../contacts.ts`). `contacts_lookup` reads; `contacts_manage` creates,
 * merges, corrects, and deletes. Shared by every persona.
 *
 * These are the self-enrichment path the time-logging-routing plan calls for:
 * agents are encouraged to record a newly discovered person (or a new id for a
 * known person) in ANY context, not just time logging — the directory gets more
 * accurate over time.
 */
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  deleteContact,
  lookupContacts,
  projectContact,
  setContactFields,
  upsertContact,
  type ContactInput,
} from "../../contacts.ts";

const lookupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Free-text search over name, roles, areas, and ids.",
    },
    id: { type: "string", description: "Exact contact id." },
    email: { type: "string", description: "Exact email (case-insensitive)." },
    jiraId: { type: "string", description: "Exact Jira accountId." },
    slackId: { type: "string", description: "Exact Slack user id." },
    area: {
      type: "string",
      description:
        "Filter to contacts tagged with this responsibility area, e.g. resources.",
    },
    limit: {
      type: "number",
      description: "Max results (1–50). Defaults to 10.",
    },
  },
} as const;

const lookupTool = defineAgentTool<ContactLookupParams>({
  name: "contacts_lookup",
  label: "Look up contacts",
  description:
    "Look up people in the general contacts directory by exact identity (id/email/jiraId/slackId), by responsibility area, or by free-text query over name/roles/areas/ids. Read-only.",
  searchHint: "person people directory who is contact colleague teammate",
  parameters: lookupSchema,
  async execute(params) {
    const contacts = lookupContacts({
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(params.id !== undefined ? { id: params.id } : {}),
      ...(params.email !== undefined ? { email: params.email } : {}),
      ...(params.jiraId !== undefined ? { jiraId: params.jiraId } : {}),
      ...(params.slackId !== undefined ? { slackId: params.slackId } : {}),
      ...(params.area !== undefined ? { area: params.area } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return jsonResult({
      count: contacts.length,
      contacts: contacts.map(projectContact),
    });
  },
});

const manageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["upsert", "setFields", "delete"],
      description:
        "upsert: create or merge by identity (email/jiraId/slackId) or explicit id, unioning arrays/ids. setFields: REPLACE roles/areas outright (corrections). delete: remove a contact by id.",
    },
    id: {
      type: "string",
      description:
        "Target an existing contact by id (required for setFields/delete).",
    },
    name: {
      type: "string",
      description:
        "Person's display name. Required when creating a new contact.",
    },
    roles: {
      type: "array",
      items: { type: "string" },
      description:
        "Role(s), e.g. Head of Engineering. upsert unions; setFields replaces.",
    },
    email: { type: "string", description: "Work email (used for dedup)." },
    jiraId: { type: "string", description: "Jira accountId (used for dedup)." },
    slackId: { type: "string", description: "Slack user id (used for dedup)." },
    ids: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        'Extensible id map for other systems, e.g. {"github":"octocat"}.',
    },
    areas: {
      type: "array",
      items: { type: "string" },
      description:
        'Responsibility area tags used for time-logging routing, e.g. ["people","resources"]. upsert unions; setFields replaces.',
    },
    notes: {
      type: "string",
      description:
        "Short durable notes about this person (work-relevant only).",
    },
  },
} as const;

const manageTool = defineAgentTool<ContactManageParams>({
  name: "contacts_manage",
  label: "Manage contacts",
  description:
    "Create, merge, correct, or delete a person in the general contacts directory. Proactively record newly discovered people and new ids for known people. Store work-relevant facts only (name, roles, work ids, responsibility area) — never sensitive personal data.",
  searchHint:
    "add person people directory remember contact colleague new teammate area routing",
  parameters: manageSchema,
  async execute(params) {
    if (params.operation === "delete") {
      if (!params.id) throw new Error("delete requires an id.");
      const removed = deleteContact(params.id);
      return jsonResult({ operation: "delete", id: params.id, removed });
    }
    if (params.operation === "setFields") {
      if (!params.id) throw new Error("setFields requires an id.");
      const contact = setContactFields(params.id, {
        ...(params.roles !== undefined ? { roles: params.roles } : {}),
        ...(params.areas !== undefined ? { areas: params.areas } : {}),
      });
      return jsonResult({
        operation: "setFields",
        contact: projectContact(contact),
      });
    }
    const input: ContactInput = {
      ...(params.id !== undefined ? { id: params.id } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.roles !== undefined ? { roles: params.roles } : {}),
      ...(params.email !== undefined ? { email: params.email } : {}),
      ...(params.jiraId !== undefined ? { jiraId: params.jiraId } : {}),
      ...(params.slackId !== undefined ? { slackId: params.slackId } : {}),
      ...(params.ids !== undefined ? { ids: params.ids } : {}),
      ...(params.areas !== undefined ? { areas: params.areas } : {}),
      ...(params.notes !== undefined ? { notes: params.notes } : {}),
    };
    const result = upsertContact(input);
    return jsonResult({
      operation: "upsert",
      created: result.created,
      merged: result.merged,
      contact: projectContact(result.contact),
    });
  },
});

interface ContactLookupParams extends Record<string, unknown> {
  query?: string;
  id?: string;
  email?: string;
  jiraId?: string;
  slackId?: string;
  area?: string;
  limit?: number;
}

interface ContactManageParams extends Record<string, unknown> {
  operation: "upsert" | "setFields" | "delete";
  id?: string;
  name?: string;
  roles?: string[];
  email?: string;
  jiraId?: string;
  slackId?: string;
  ids?: Record<string, string>;
  areas?: string[];
  notes?: string;
}

export const assistantContactsTools = [lookupTool, manageTool];
