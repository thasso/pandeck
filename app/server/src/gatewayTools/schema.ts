/**
 * The closed argument checker for edge tools: an object of string, boolean,
 * integer, number and string-array properties with `required`,
 * `additionalProperties: false`, `pattern`, `maxLength`, `minimum`,
 * `maximum`, `enum` (on a string or an array's string items), and `default`
 * applied. A number must be finite. A refusal names the property as the
 * schema names it, never the value or a name the caller sent.
 */
import type { ObjectSchema } from "./descriptor.ts";

export type SchemaCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

const listed = (allowed: readonly string[] | undefined, value: string) =>
  allowed === undefined || allowed.includes(value);

export function checkArguments(
  schema: ObjectSchema,
  args: unknown,
): SchemaCheck {
  const refuse = (message: string): SchemaCheck => ({
    ok: false,
    message: `Invalid arguments: ${message}`,
  });
  const given = args ?? {};
  if (typeof given !== "object" || Array.isArray(given))
    return refuse("an object is required.");
  const values = given as Record<string, unknown>;
  for (const key of Object.keys(values))
    if (!Object.hasOwn(schema.properties, key))
      return refuse("an unknown property was given.");
  const params: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = values[name];
    if (value === undefined) {
      if (schema.required?.includes(name))
        return refuse(`${name} is required.`);
      if ("default" in property && property.default !== undefined)
        params[name] = property.default;
      continue;
    }
    switch (property.type) {
      case "string":
        if (typeof value !== "string")
          return refuse(`${name} must be a string.`);
        if (
          property.maxLength !== undefined &&
          value.length > property.maxLength
        )
          return refuse(`${name} is too long.`);
        if (
          property.pattern !== undefined &&
          !new RegExp(property.pattern).test(value)
        )
          return refuse(`${name} does not have the expected form.`);
        if (!listed(property.enum, value))
          return refuse(`${name} must be one of the listed values.`);
        break;
      case "boolean":
        if (typeof value !== "boolean")
          return refuse(`${name} must be a boolean.`);
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value))
          return refuse(`${name} must be an integer.`);
        if (
          (property.minimum !== undefined && value < property.minimum) ||
          (property.maximum !== undefined && value > property.maximum)
        )
          return refuse(`${name} is out of range.`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value))
          return refuse(`${name} must be a number.`);
        break;
      case "array":
        if (
          !Array.isArray(value) ||
          !value.every((item) => typeof item === "string")
        )
          return refuse(`${name} must be a list of strings.`);
        if (!value.every((item: string) => listed(property.items.enum, item)))
          return refuse(`${name} must hold only the listed values.`);
        break;
    }
    params[name] = value;
  }
  return { ok: true, params };
}
