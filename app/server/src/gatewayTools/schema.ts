/**
 * The closed argument checker for edge tools: an object of string, boolean
 * and integer properties with `required`, `additionalProperties: false`,
 * `pattern`, `maxLength`, `minimum` and `maximum`, and `default` applied.
 * A refusal names the property as the schema names it, never the value or a
 * name the caller sent.
 */
import type { ObjectSchema } from "./descriptor.ts";

export type SchemaCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string };

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
    }
    params[name] = value;
  }
  return { ok: true, params };
}
