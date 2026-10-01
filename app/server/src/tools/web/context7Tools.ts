/**
 * Context7 documentation-search tools, shared by every persona over the session
 * MCP server. Mirrors Context7's own two-step flow: resolve a library name to a
 * Context7 library id, then fetch focused, up-to-date docs for that id.
 *
 * Both read the API key + enable flag through `getContext7ToolConfig()` in
 * `../context7Settings.ts` (runtime user setting, no static/env fallback), which
 * throws a user-actionable error when disabled or unconfigured.
 */
import {
  CONTEXT7_API_BASE,
  getContext7ToolConfig,
} from "../../context7Settings.ts";
import {
  defineAgentTool,
  jsonResult,
  type ToolResult,
} from "../../mcp/tool.ts";

const RESOLVE_MAX_RESULTS = 15;
const DOCS_DEFAULT_MAX_CHARS = 20_000;
const DOCS_HARD_MAX_CHARS = 100_000;

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function context7Get(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const { apiKey } = getContext7ToolConfig();
  const url = new URL(`${CONTEXT7_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "personal-assistant/1.0 (+context7)",
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Context7 request failed (${res.status} ${res.statusText}). ${body}`.trim(),
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// context7_resolve_library
// ---------------------------------------------------------------------------

type ResolveParams = {
  libraryName: string;
  query?: string;
};

const resolveParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["libraryName"],
  properties: {
    libraryName: {
      type: "string",
      description:
        'The library/package/framework name to resolve, e.g. "next.js", "react", "fastapi".',
    },
    query: {
      type: "string",
      description:
        "Optional natural-language query to disambiguate which library you mean.",
    },
  },
} as const;

interface Context7LibResult {
  id?: string;
  title?: string;
  description?: string;
  branch?: string;
  totalTokens?: number;
  totalSnippets?: number;
  trustScore?: number;
}

export const context7ResolveLibraryTool = defineAgentTool<ResolveParams>({
  name: "context7_resolve_library",
  label: "Context7 Resolve Library",
  description:
    'Resolve a library/framework name to Context7 library IDs. Returns candidate matches (id, title, description). Read-only. Call this first, then context7_get_docs with the chosen id — skip it only when the user already gave an exact id starting with "/". Pick the candidate whose title/description best matches the question, preferring higher trustScore and snippet coverage.',
  executionMode: "parallel",
  parameters: resolveParamsSchema,
  async execute(params, ctx): Promise<ToolResult> {
    const libraryName = params.libraryName?.trim();
    if (!libraryName)
      throw new Error("context7_resolve_library requires a libraryName.");
    const res = await context7Get(
      "/libs/search",
      { libraryName, query: params.query?.trim() ?? "" },
      ctx.signal,
    );
    const data = (await res.json()) as { results?: Context7LibResult[] };
    const results = (data.results ?? [])
      .slice(0, RESOLVE_MAX_RESULTS)
      .map((r) => ({
        id: r.id ?? "",
        title: r.title ?? undefined,
        description: r.description ?? undefined,
        trustScore: typeof r.trustScore === "number" ? r.trustScore : undefined,
        totalSnippets:
          typeof r.totalSnippets === "number" ? r.totalSnippets : undefined,
      }))
      .filter((r) => r.id);

    return jsonResult({ libraryName, count: results.length, results });
  },
});

// ---------------------------------------------------------------------------
// context7_get_docs
// ---------------------------------------------------------------------------

type GetDocsParams = {
  libraryId: string;
  query: string;
  maxChars?: number;
};

const getDocsParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["libraryId", "query"],
  properties: {
    libraryId: {
      type: "string",
      description:
        'A Context7 library id from context7_resolve_library, e.g. "/vercel/next.js".',
    },
    query: {
      type: "string",
      description:
        "Detailed natural-language query describing the topic/API you need docs for.",
    },
    maxChars: {
      type: "integer",
      minimum: 1,
      maximum: DOCS_HARD_MAX_CHARS,
      description: `Maximum characters of documentation to return (default ${DOCS_DEFAULT_MAX_CHARS}, hard max ${DOCS_HARD_MAX_CHARS}).`,
    },
  },
} as const;

interface Context7CodeSnippet {
  codeTitle?: string;
  codeDescription?: string;
  codeLanguage?: string;
  codeList?: Array<{ code?: string; language?: string }>;
}

interface Context7Context {
  codeSnippets?: Context7CodeSnippet[];
  infoSnippets?: Array<{ content?: string }>;
}

function formatDocs(context: Context7Context): string {
  const parts: string[] = [];
  for (const info of context.infoSnippets ?? []) {
    if (info.content?.trim()) parts.push(info.content.trim());
  }
  for (const snippet of context.codeSnippets ?? []) {
    const heading = snippet.codeTitle?.trim();
    const desc = snippet.codeDescription?.trim();
    const code = (snippet.codeList ?? [])
      .map((c) => c.code?.trim())
      .filter((c): c is string => Boolean(c));
    const block: string[] = [];
    if (heading) block.push(`### ${heading}`);
    if (desc) block.push(desc);
    for (const c of code) {
      const lang = snippet.codeLanguage ?? "";
      block.push("```" + lang + "\n" + c + "\n```");
    }
    if (block.length > 0) parts.push(block.join("\n\n"));
  }
  return parts.join("\n\n");
}

export const context7GetDocsTool = defineAgentTool<GetDocsParams>({
  name: "context7_get_docs",
  label: "Context7 Get Docs",
  description:
    "Fetch focused, up-to-date documentation for a Context7 library id (from context7_resolve_library) matching a query. Returns Markdown docs with code snippets. Prefer it over web_search whenever the library is known and you need authoritative current documentation. Read-only.",
  executionMode: "parallel",
  parameters: getDocsParamsSchema,
  async execute(params, ctx): Promise<ToolResult> {
    const libraryId = params.libraryId?.trim();
    const query = params.query?.trim();
    if (!libraryId)
      throw new Error(
        "context7_get_docs requires a libraryId (see context7_resolve_library).",
      );
    if (!query) throw new Error("context7_get_docs requires a query.");
    const maxChars = clampInt(
      params.maxChars,
      DOCS_DEFAULT_MAX_CHARS,
      1,
      DOCS_HARD_MAX_CHARS,
    );

    const res = await context7Get(
      "/context",
      { libraryId, query, type: "json" },
      ctx.signal,
    );
    const raw = await res.text();

    let content: string;
    try {
      const parsed = JSON.parse(raw) as Context7Context;
      content =
        parsed.codeSnippets || parsed.infoSnippets ? formatDocs(parsed) : raw;
    } catch {
      content = raw; // Context7 may return plain text; pass it through.
    }

    content = content.trim();
    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    return jsonResult({
      libraryId,
      query,
      truncated,
      chars: content.length,
      content,
    });
  },
});

export const context7Tools = [context7ResolveLibraryTool, context7GetDocsTool];
