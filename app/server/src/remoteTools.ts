/**
 * Client mode's gateway tools (Task-1398): the edge's tools Pandeck's agents
 * call through the client link (`tools.list` and `tools.call` on gateway
 * client 1.0, `gatewayClientLink.ts`). The catalog's remote group
 * (`tools/gateway/remoteToolGroup.ts`) is built from the set kept here.
 *
 * The link lists on every connect, before it publishes the connection, and
 * hands the listing to {@link applyListing}. Only read tools of a mapped
 * product are accepted, until approvals wrap writes (G5): the `actionKey`
 * prefix names the product, and {@link PRODUCTS} maps `jira`, `slack` and
 * `confluence` to the Settings toggle that turns their tools on; a product in
 * {@link PRODUCT_READS} accepts only the names listed there. A name accepted
 * once stays known for the boot, so a pi engine's universe, registered at
 * open, never outgrows the server's binding; a dispatch checks the CURRENT
 * listing, connection and product toggle before any call. A pi open waits for
 * the boot's first listing.
 *
 * Types are structural: nothing here imports `gateway/`.
 */
import { getConfluenceSettings } from "./confluenceSettings.ts";
import { GatewayUnavailableError } from "./gatewayLink.ts";
import { notifyIntegrationToolsChanged } from "./integrationToolChanges.ts";
import { getJiraSettings } from "./jiraSettings.ts";
import { getSlackRuntimeSettings } from "./slackSettings.ts";

/**
 * The mapped products and their Settings toggle: a listed tool is accepted
 * only when its `actionKey` prefix is a key here. UI text and catalog group
 * metadata live with the remote group and the catalog, not here.
 */
const PRODUCTS = {
  jira: () => getJiraSettings().enabled,
  slack: () => getSlackRuntimeSettings().enabled,
  confluence: () => getConfluenceSettings().enabled,
} as const;

export type RemoteProduct = keyof typeof PRODUCTS;

/**
 * Products that accept only these names (Task-1439 P3): any other entry of
 * the product is dropped, so a tool the edge adds later (the attachment
 * download, a write) stays out until a change here admits it on purpose.
 * Products without an entry accept every bounded read tool.
 */
const PRODUCT_READS: Partial<Record<RemoteProduct, ReadonlySet<string>>> = {
  confluence: new Set([
    "confluence_search",
    "confluence_get_page",
    "confluence_lookup",
  ]),
};

function isRemoteProduct(value: string | undefined): value is RemoteProduct {
  return value !== undefined && Object.hasOwn(PRODUCTS, value);
}

export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: "read";
  actionKey: string;
  product: RemoteProduct;
}

/** The edge's answer to one call, as the link decodes it. */
export type RemoteToolAnswer =
  | { ok: true; text: string }
  | {
      ok: false;
      code:
        | "unknown_tool"
        | "invalid_params"
        | "tool_error"
        | "result_too_large"
        | "timeout"
        | "cancelled"
        | "failed";
      message: string;
    };

/** A call the link could not make; the tool group says why in fixed text. */
export class RemoteToolRefusal extends Error {
  constructor(readonly code: "gateway_unavailable" | "tools_unavailable") {
    super(code);
  }
}

/** The gateway's tool calls, as the client link offers them. */
export interface RemoteToolPort {
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RemoteToolAnswer>;
}

const MAX_TOOLS = 64;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DESCRIPTION = 1_024;
const MAX_SCHEMA = 4_096;
/** The product is the `actionKey`'s prefix; {@link PRODUCTS} says which map. */
const ACTION_KEY_RE = /^([a-z]+):[a-z_]{1,32}$/;

let port: RemoteToolPort | undefined;
const known = new Map<string, RemoteToolDescriptor>();
let current = new Set<string>();
let connected = false;
let resolveFirstListing!: () => void;
let firstListing = new Promise<void>((resolve) => {
  resolveFirstListing = resolve;
});

/** Installs the client link's port; answers its uninstall. */
export function installRemoteToolPort(next: RemoteToolPort): () => void {
  port = next;
  return () => {
    if (port !== next) return;
    port = undefined;
    known.clear();
    current = new Set();
    connected = false;
    firstListing = new Promise<void>((resolve) => {
      resolveFirstListing = resolve;
    });
  };
}

/** The installed port, in client mode only. */
export function remoteToolPort(): RemoteToolPort | undefined {
  return port;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function accepted(value: unknown): RemoteToolDescriptor | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const { name, description, inputSchema, effect } = entry;
  const actionKey = typeof entry.actionKey === "string" ? entry.actionKey : "";
  const schema = record(inputSchema);
  const product = ACTION_KEY_RE.exec(actionKey)?.[1];
  if (
    typeof name !== "string" ||
    !NAME_RE.test(name) ||
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > MAX_DESCRIPTION ||
    !schema ||
    schema.type !== "object" ||
    JSON.stringify(schema).length > MAX_SCHEMA ||
    effect !== "read" ||
    !isRemoteProduct(product) ||
    PRODUCT_READS[product]?.has(name) === false
  )
    return undefined;
  return {
    name,
    description,
    inputSchema: schema,
    effect,
    actionKey,
    product,
  };
}

/**
 * The listing's entries Pandeck offers its agents: the first 64, read tools
 * of a mapped product within the bounds, a name listed twice not at all.
 */
export function acceptRemoteTools(listing: unknown): RemoteToolDescriptor[] {
  if (!Array.isArray(listing)) return [];
  const entries = listing.slice(0, MAX_TOOLS);
  const names = entries.map((entry) => record(entry)?.name);
  const tools = entries
    .map(accepted)
    .filter(
      (tool): tool is RemoteToolDescriptor =>
        tool !== undefined &&
        names.indexOf(tool.name) === names.lastIndexOf(tool.name),
    );
  const dropped = listing.length - tools.length;
  if (dropped > 0)
    console.log(`[remote-tools] dropped ${dropped} gateway tool(s)`);
  return tools;
}

function changed(): void {
  try {
    notifyIntegrationToolsChanged();
  } catch (err) {
    console.error("[remote-tools] a tool-change subscriber failed:", err);
  }
}

/** A connect's accepted listing; known names stay for the boot. */
export function applyListing(tools: readonly RemoteToolDescriptor[]): void {
  for (const tool of tools) known.set(tool.name, tool);
  current = new Set(tools.map((tool) => tool.name));
  connected = true;
  resolveFirstListing();
  changed();
}

/** The link's published connection ended. */
export function markDisconnected(): void {
  connected = false;
  changed();
}

/**
 * Settles once this boot's first listing is applied; outside client mode at
 * once. Rejects with the gateway-unavailable refusal after `ms`.
 */
export function remoteToolsReady(ms: number): Promise<void> {
  if (!port) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GatewayUnavailableError()), ms);
    void firstListing.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Every remote tool of `product` accepted this boot, first-accepted order. */
export function knownRemoteTools(
  product: RemoteProduct,
): RemoteToolDescriptor[] {
  return [...known.values()].filter((tool) => tool.product === product);
}

/** Whether `product`'s tools are turned on in Settings. */
export function remoteProductEnabled(product: RemoteProduct): boolean {
  return PRODUCTS[product]();
}

/** A remote group's gate: connected and its product turned on in Settings. */
export function remoteToolGate(product: RemoteProduct): boolean {
  return connected && remoteProductEnabled(product);
}

/** Whether `name` may be called now: connected, listed now, product on. */
export function remoteToolDispatchable(name: string): boolean {
  const tool = known.get(name);
  return (
    tool !== undefined &&
    connected &&
    current.has(name) &&
    remoteProductEnabled(tool.product)
  );
}

/** Whether the link holds a published connection. */
export function remoteToolsConnected(): boolean {
  return connected;
}
