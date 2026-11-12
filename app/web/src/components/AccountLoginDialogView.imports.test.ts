/**
 * The login dialog's view stays transport-free (Task-1402 B1, AC10): the
 * gateway's page renders it too, so it may import only React, icons, `ui/`,
 * three `common/` leaves and types from the shared package.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("AC10: the view imports no transport, only what the gateway bundle may carry", () => {
  const source = readFileSync(
    new URL("./AccountLoginDialogView.tsx", import.meta.url),
    "utf8",
  );
  const imports = [
    ...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms),
  ].map((match) => ({ typeOnly: match[1] !== undefined, from: match[2]! }));
  expect(imports.length).toBeGreaterThan(0);
  expect(source).not.toMatch(/^import\s+"[^"]+";/m);
  expect(source).not.toMatch(/\bimport\(/);
  const allowed = (from: string, typeOnly: boolean) =>
    from === "react" ||
    from === "lucide-react" ||
    /^\.\/ui\/[a-z-]+\.tsx$/.test(from) ||
    /^\.\/common\/(?:load|IconButton|LinkButton)\.tsx$/.test(from) ||
    (from === "@assistant/shared" && typeOnly);
  expect(
    imports.filter(({ from, typeOnly }) => !allowed(from, typeOnly)),
  ).toEqual([]);
});
