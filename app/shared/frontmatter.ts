const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const YAML_KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/;

/**
 * Splits a document whose byte-zero opening fence and first closing fence delimit
 * a YAML frontmatter block. The body is left byte-for-byte unchanged.
 */
export function splitYamlFrontmatter(
  content: string,
  path: string,
): { yaml: string; body: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error(
      `Invalid frontmatter in ${path}: document must start with YAML frontmatter delimited by --- lines.`,
    );
  }
  const [, yaml = "", body = ""] = match;
  return { yaml, body };
}

/**
 * Parses the deliberately small YAML subset used by server-owned frontmatter:
 * maps, sequences, scalar values, and inline scalar arrays.
 */
export function parseYamlSubset(yaml: string, path: string): unknown {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  const skipTrivia = () => {
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.trim() && !line.trimStart().startsWith("#")) break;
      index++;
    }
  };

  const indentation = (line: string): number => {
    if (/\t/.test(line))
      throw new Error(
        `Invalid YAML in ${path} line ${index + 1}: tabs are not supported; use spaces.`,
      );
    return line.match(/^ */)?.[0].length ?? 0;
  };

  const parseBlock = (indent: number): unknown => {
    skipTrivia();
    const line = lines[index];
    if (line === undefined || indentation(line) < indent) return {};
    if (indentation(line) !== indent) {
      throw new Error(
        `Invalid YAML in ${path} line ${index + 1}: expected ${indent} spaces of indentation.`,
      );
    }
    return line.slice(indent).startsWith("- ")
      ? parseSequence(indent)
      : parseMap(indent);
  };

  const parseMap = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (index < lines.length) {
      skipTrivia();
      const line = lines[index];
      if (line === undefined) break;
      const actual = indentation(line);
      if (actual < indent) break;
      if (actual > indent)
        throw new Error(
          `Invalid YAML in ${path} line ${index + 1}: unexpected indentation.`,
        );
      const text = line.slice(indent);
      if (text.startsWith("- ")) break;
      const match = YAML_KEY_RE.exec(text);
      if (!match)
        throw new Error(
          `Invalid YAML in ${path} line ${index + 1}: expected "key: value".`,
        );
      const [, key = "", rawValue] = match;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new Error(
          `Invalid YAML in ${path} line ${index + 1}: duplicate key "${key}".`,
        );
      }
      index++;
      out[key] =
        rawValue === undefined
          ? parseBlock(indent + 2)
          : parseScalar(rawValue, path, index);
    }
    return out;
  };

  const parseSequence = (indent: number): unknown[] => {
    const out: unknown[] = [];
    while (index < lines.length) {
      skipTrivia();
      const line = lines[index];
      if (line === undefined) break;
      const actual = indentation(line);
      if (actual < indent) break;
      if (actual !== indent || !line.slice(indent).startsWith("- ")) {
        throw new Error(
          `Invalid YAML in ${path} line ${index + 1}: expected list item indentation.`,
        );
      }
      const rest = line.slice(indent + 2).trimEnd();
      index++;
      if (!rest) {
        out.push(parseBlock(indent + 2));
        continue;
      }
      const objectItem = YAML_KEY_RE.exec(rest);
      if (objectItem) {
        const [, key = "", rawValue] = objectItem;
        const obj: Record<string, unknown> = {
          [key]:
            rawValue === undefined
              ? parseBlock(indent + 2)
              : parseScalar(rawValue, path, index),
        };
        const following = parseFollowingMap(indent + 2);
        Object.assign(obj, following);
        out.push(obj);
      } else {
        out.push(parseScalar(rest, path, index));
      }
    }
    return out;
  };

  const parseFollowingMap = (indent: number): Record<string, unknown> => {
    skipTrivia();
    const line = lines[index];
    if (line === undefined || indentation(line) < indent) return {};
    if (indentation(line) !== indent || line.slice(indent).startsWith("- "))
      return {};
    return parseMap(indent);
  };

  const result = parseBlock(0);
  skipTrivia();
  if (index < lines.length)
    throw new Error(
      `Invalid YAML in ${path} line ${index + 1}: trailing content is not supported.`,
    );
  return result;
}

function parseScalar(raw: string, path: string, lineNumber: number): unknown {
  const value = raw.trim();
  if (value === "") return "";
  if (value.startsWith("[")) return parseInlineArray(value, path, lineNumber);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(
        `Invalid YAML in ${path} line ${lineNumber}: invalid quoted string (${String(err)}).`,
      );
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'"))
      throw new Error(
        `Invalid YAML in ${path} line ${lineNumber}: unterminated single-quoted string.`,
      );
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

function parseInlineArray(
  raw: string,
  path: string,
  lineNumber: number,
): unknown[] {
  const text = raw.trim();
  if (!text.endsWith("]"))
    throw new Error(
      `Invalid YAML in ${path} line ${lineNumber}: unterminated inline array.`,
    );
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const values: unknown[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] ?? "";
    if (quote) {
      current += char;
      if (char === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      values.push(parseScalar(current.trim(), path, lineNumber));
      current = "";
      continue;
    }
    current += char;
  }
  if (quote)
    throw new Error(
      `Invalid YAML in ${path} line ${lineNumber}: unterminated quoted value in inline array.`,
    );
  values.push(parseScalar(current.trim(), path, lineNumber));
  return values;
}
