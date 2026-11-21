/**
 * The closed argument checker for edge tools: an object of string, boolean,
 * integer, number and string-array properties with `required`,
 * `additionalProperties: false`, `pattern`, `maxLength`, `minimum`,
 * `maximum`, `enum` (on a string or an array's string items), and `default`
 * applied. A number must be finite. Since Task-1463 also: closed nested
 * objects and arrays of them, `minItems`/`maxItems` on arrays, a string or
 * `null` (`anyOf`), and an opaque object passed through as given. Defaults
 * apply only at the root. A refusal names the property by its schema path
 * (schema names and `[index]`), never the value or a name the caller sent.
 */
import type { ObjectSchema } from "./descriptor.ts";

export type SchemaCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

type Property = ObjectSchema["properties"][string];
type ClosedObject = Extract<Property, { additionalProperties: false }>;

/** A refusal's text without the prefix, or the value to pass on. */
type Checked<T = unknown> = { refusal: string } | { value: T };

const listed = (allowed: readonly string[] | undefined, value: string) =>
  allowed === undefined || allowed.includes(value);

export function checkArguments(
  schema: ObjectSchema,
  args: unknown,
): SchemaCheck {
  const checked = checkObject(schema, args ?? {}, undefined);
  if ("refusal" in checked)
    return { ok: false, message: `Invalid arguments: ${checked.refusal}` };
  return { ok: true, params: checked.value };
}

/**
 * Checks a closed object: the root (`path` undefined, its own messages and
 * defaults) or a nested one. Accepts a fresh object of the schema-named keys
 * given, so no caller key is ever assigned.
 */
function checkObject(
  schema: ObjectSchema | ClosedObject,
  given: unknown,
  path: string | undefined,
): Checked<Record<string, unknown>> {
  if (given === null || typeof given !== "object" || Array.isArray(given))
    return {
      refusal:
        path === undefined
          ? "an object is required."
          : `${path} must be an object.`,
    };
  const values = given as Record<string, unknown>;
  for (const key of Object.keys(values))
    if (!Object.hasOwn(schema.properties, key))
      return {
        refusal:
          path === undefined
            ? "an unknown property was given."
            : `${path} has an unknown property.`,
      };
  const accepted: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const at = path === undefined ? name : `${path}.${name}`;
    const value = values[name];
    if (value === undefined) {
      if (schema.required?.includes(name))
        return { refusal: `${at} is required.` };
      if (
        path === undefined &&
        "default" in property &&
        property.default !== undefined
      )
        accepted[name] = property.default;
      continue;
    }
    const checked = checkValue(property, value, at);
    if ("refusal" in checked) return checked;
    accepted[name] = checked.value;
  }
  return { value: accepted };
}

/** Refuses a list shorter than `minItems` or longer than `maxItems`. */
function outOfBounds(
  property: { readonly minItems?: number; readonly maxItems?: number },
  length: number,
  path: string,
): Checked | undefined {
  if (property.minItems !== undefined && length < property.minItems)
    return {
      refusal: `${path} must hold at least ${property.minItems} item(s).`,
    };
  if (property.maxItems !== undefined && length > property.maxItems)
    return {
      refusal: `${path} must hold at most ${property.maxItems} item(s).`,
    };
  return undefined;
}

/** Checks one given (not `undefined`) value against its property. */
function checkValue(property: Property, value: unknown, path: string): Checked {
  if (property.type === undefined) {
    if (value !== null && typeof value !== "string")
      return { refusal: `${path} must be a string or null.` };
    return { value };
  }
  switch (property.type) {
    case "string":
      if (typeof value !== "string")
        return { refusal: `${path} must be a string.` };
      if (property.maxLength !== undefined && value.length > property.maxLength)
        return { refusal: `${path} is too long.` };
      if (
        property.pattern !== undefined &&
        !new RegExp(property.pattern).test(value)
      )
        return { refusal: `${path} does not have the expected form.` };
      if (!listed(property.enum, value))
        return { refusal: `${path} must be one of the listed values.` };
      return { value };
    case "boolean":
      if (typeof value !== "boolean")
        return { refusal: `${path} must be a boolean.` };
      return { value };
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        return { refusal: `${path} must be an integer.` };
      if (
        (property.minimum !== undefined && value < property.minimum) ||
        (property.maximum !== undefined && value > property.maximum)
      )
        return { refusal: `${path} is out of range.` };
      return { value };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return { refusal: `${path} must be a number.` };
      return { value };
    case "object":
      if (property.additionalProperties === false)
        return checkObject(property, value, path);
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return { refusal: `${path} must be an object.` };
      return { value };
    case "array": {
      const items = property.items;
      if (items.type === "object") {
        if (!Array.isArray(value))
          return { refusal: `${path} must be a list.` };
        const bounds = outOfBounds(property, value.length, path);
        if (bounds !== undefined) return bounds;
        const accepted: unknown[] = [];
        for (const [index, item] of value.entries()) {
          const checked = checkObject(items, item, `${path}[${index}]`);
          if ("refusal" in checked) return checked;
          accepted.push(checked.value);
        }
        return { value: accepted };
      }
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      )
        return { refusal: `${path} must be a list of strings.` };
      const bounds = outOfBounds(property, value.length, path);
      if (bounds !== undefined) return bounds;
      if (!value.every((item: string) => listed(items.enum, item)))
        return { refusal: `${path} must hold only the listed values.` };
      return { value };
    }
  }
}
