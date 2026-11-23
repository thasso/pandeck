/**
 * The closed rule kit the proposal validators are built from
 * (`jiraMutationCheck.ts`, `confluenceMutationCheck.ts`, Task-1463 P6a). A
 * proposal is what an edge's `tools.prepare` answers and what its
 * `tools.apply` receives back: card items before any result.
 *
 * Every object type gets a {@link RuleTable}: one rule per key of the type,
 * required or optional exactly as the type declares it, checked with
 * `satisfies`. A key added to a type without a rule, a rule for a key the type
 * lacks, an optional rule for a required key, or a check wider than the
 * field's type is a type error. A value is refused for any key without a
 * rule, a missing required key, a wrong type, or a pure result field
 * ({@link result}). Strings are bounded only by the proposal's byte budget
 * ({@link PROPOSAL_MAX_BYTES}).
 *
 * Boundary-clean: imports nothing (`workerBoundary.test.ts`).
 */

/** The most items one proposal holds: both products' prepare refuses more. */
export const MAX_PROPOSAL_ITEMS = 10;
/** A proposal's serialized ceiling, UTF-8 bytes of `JSON.stringify(items)`. */
export const PROPOSAL_MAX_BYTES = 1_048_576;
/** The most entries a metadata array holds; opaque JSON has no such cap. */
const ARRAY_MAX = 1_000;
/** The deepest an opaque JSON value nests, counted in containers. */
const JSON_DEPTH_MAX = 32;
/** Keys an opaque JSON object never has, at any depth. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `value` is a `V`. `depth` is how deep the value sits. */
export type Check<V> = (value: unknown, depth: number) => value is V;

/** One key's rule: whether it may be absent, and what its value must be. */
export interface Rule<V, Optional extends boolean> {
  readonly optional: Optional;
  readonly check: Check<V>;
}

/** The keys `T` declares optional. */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/** One rule per key of `T`, optional exactly where `T` is. */
export type RuleTable<T> = {
  readonly [K in keyof T]-?: Rule<
    Exclude<T[K], undefined>,
    K extends OptionalKeys<T> ? true : false
  >;
};

/** A key the value must carry. */
export function req<V>(check: Check<V>): Rule<V, false> {
  return { optional: false, check };
}

/** A key the value may leave out. */
export function opt<V>(check: Check<V>): Rule<V, true> {
  return { optional: true, check };
}

/** A pure result field: absent from every proposal. */
export const result: Rule<never, true> = {
  optional: true,
  check: (_value: unknown): _value is never => false,
};

export const str: Check<string> = (value): value is string =>
  typeof value === "string";

export const bool: Check<boolean> = (value): value is boolean =>
  typeof value === "boolean";

/** A non-negative safe integer: ids, versions and sizes. */
export const count: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function nullable<V>(check: Check<V>): Check<V | null> {
  return (value, depth): value is V | null =>
    value === null || check(value, depth);
}

export const strOrNull = nullable(str);

/** Exactly `literal`: a discriminator. */
export function literal<L extends string>(literal: L): Check<L> {
  return (value): value is L => value === literal;
}

/** The members of `U` that `A` leaves out, as a type error. */
type AllOf<U, A extends readonly unknown[]> = [Exclude<U, A[number]>] extends [
  never,
]
  ? unknown
  : { readonly missingMember: Exclude<U, A[number]> };

/**
 * One of a literal union's members. The list must name every member: one
 * missing is a type error (`oneOf<U>()([…])`).
 */
export function oneOf<U extends string>() {
  return <const A extends readonly U[]>(values: A & AllOf<U, A>): Check<U> => {
    const members = new Set<unknown>(values);
    return (value): value is U => members.has(value);
  };
}

/** A plain data object: no prototype but `Object.prototype` or none, no hidden or symbol keys. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).length === Object.keys(value).length;
}

/** Up to `max` entries, each a `V`; a hole is refused like a wrong entry. */
export function arrayOf<V>(check: Check<V>, max = ARRAY_MAX): Check<V[]> {
  return (value, depth): value is V[] => {
    if (!Array.isArray(value) || value.length > max) return false;
    for (let index = 0; index < value.length; index += 1)
      if (!check(value[index], depth + 1)) return false;
    return true;
  };
}

/**
 * An object holding exactly `table`'s keys: every required one present, no
 * other key. An own key whose value is `undefined` counts as absent, as
 * `JSON.stringify` drops it.
 */
export function closed<T>(table: RuleTable<T>): Check<T> {
  const rules = table as Readonly<Record<string, Rule<unknown, boolean>>>;
  const entries = Object.entries(rules);
  return (value, depth): value is T => {
    if (!isPlainObject(value)) return false;
    for (const key of Object.keys(value))
      if (!Object.hasOwn(rules, key)) return false;
    for (const [key, rule] of entries) {
      const field = Object.hasOwn(value, key) ? value[key] : undefined;
      if (field === undefined) {
        if (!rule.optional) return false;
        continue;
      }
      if (!rule.check(field, depth + 1)) return false;
    }
    return true;
  };
}

/**
 * A discriminated union: the discriminator first, then the variant's own
 * table. A variant without a table, or a table missing one of its variant's
 * keys, is a type error.
 */
export function variants<
  U extends Record<D, string>,
  D extends keyof U & string,
>(
  discriminator: D,
  tables: { readonly [K in U[D]]: RuleTable<Extract<U, Record<D, K>>> },
): Check<U> {
  const byTag = tables as Readonly<Record<string, RuleTable<unknown>>>;
  const checks = new Map<unknown, Check<unknown>>(
    Object.entries(byTag).map(([tag, table]) => [tag, closed(table)]),
  );
  return (value, depth): value is U => {
    if (!isPlainObject(value)) return false;
    const check = checks.get(value[discriminator]);
    return check !== undefined && check(value, depth);
  };
}

/**
 * An opaque value sent to the product as it is (`unknown` in the item
 * type): plain JSON only. Null, a boolean, a finite number, a string, an
 * array, or a plain object without `__proto__`, `constructor` or `prototype`
 * keys, nested at most {@link JSON_DEPTH_MAX} containers deep, counted from
 * the value itself.
 */
export const plainJson: Check<unknown> = (value): value is unknown =>
  isJson(value, 0);

function isJson(value: unknown, containers: number): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  if (containers >= JSON_DEPTH_MAX) return false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      if (!isJson(value[index], containers + 1)) return false;
    return true;
  }
  if (!isPlainObject(value)) return false;
  for (const [key, field] of Object.entries(value))
    if (FORBIDDEN_KEYS.has(key) || !isJson(field, containers + 1)) return false;
  return true;
}

/** UTF-8 bytes of `text`; a lone surrogate counts as its 3-byte replacement. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 bytes of `value` serialized, or `undefined` when it does not serialize. */
export function jsonBytes(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? utf8Bytes(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A proposal: an array of 1 to {@link MAX_PROPOSAL_ITEMS} items, each an
 * `item`, within {@link PROPOSAL_MAX_BYTES}. The size is measured first, so a
 * huge value costs one serialization and no walk.
 */
export function checkProposal<T>(value: unknown, item: Check<T>): value is T[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_PROPOSAL_ITEMS) return false;
  const bytes = jsonBytes(value);
  if (bytes === undefined || bytes > PROPOSAL_MAX_BYTES) return false;
  return arrayOf(item, MAX_PROPOSAL_ITEMS)(value, 0);
}
