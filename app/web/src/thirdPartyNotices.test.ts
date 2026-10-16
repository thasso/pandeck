/**
 * The web bundle's third-party notices (`../thirdPartyNotices.ts`): read from
 * the installed packages, verbatim, and refused when anything drifted (F031).
 *   pnpm --filter @assistant/web test src/thirdPartyNotices.test.ts
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectWebNotices,
  renderWebNotices,
  WEB_NOTICE_PACKAGES,
  type NoticeIo,
} from "../thirdPartyNotices.ts";

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const realIo: NoticeIo = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  realpath: realpathSync,
  readdir: (path) => readdirSync(path),
};

/** The real tree, with one package's facts changed. */
function ioWith(
  packageName: string,
  change: {
    manifest?: (json: Record<string, unknown>) => Record<string, unknown>;
    license?: (text: string) => string;
    noLicense?: true;
  },
): NoticeIo {
  const isPackage = (dir: string) => {
    try {
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return json.name === packageName;
    } catch {
      return false;
    }
  };
  return {
    ...realIo,
    readFile: (path) => {
      const text = realIo.readFile(path);
      const dir = dirname(path);
      if (!isPackage(dir)) return text;
      if (basename(path) === "package.json" && change.manifest)
        return JSON.stringify(change.manifest(JSON.parse(text)));
      if (/^licen[cs]e/i.test(basename(path)) && change.license)
        return change.license(text);
      return text;
    },
    readdir: (path) =>
      change.noLicense && isPackage(path)
        ? realIo.readdir(path).filter((file) => !/^licen[cs]e/i.test(file))
        : realIo.readdir(path),
  };
}

describe("the web third-party notices", () => {
  it("names exactly the pinned packages, with their own license texts", () => {
    const entries = collectWebNotices(WEB_DIR);
    expect(entries.map((entry) => `${entry.name}@${entry.version}`)).toEqual(
      WEB_NOTICE_PACKAGES.map((entry) => `${entry.name}@${entry.version}`),
    );
    expect(entries).toHaveLength(13);
    const text = renderWebNotices(entries);
    for (const entry of entries) {
      expect(text).toContain(
        `## ${entry.name} ${entry.version} (${entry.license})`,
      );
      // The whole body, verbatim: no abbreviation of permission, conditions or
      // disclaimer.
      expect(text).toContain(entry.text.trimEnd());
    }
    expect(text).toContain("webkid GmbH");
    expect(text).toContain("Jorge Bucaran");
    expect(text).toContain("Paul Henschel");
    expect(text).toContain("Copyright 2001 Robert Penner");
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    // The baseline package under React is not the map's to add.
    expect(text).not.toContain("use-sync-external-store");
  });

  it("refuses a package with no license file", () => {
    expect(() =>
      collectWebNotices(WEB_DIR, ioWith("d3-ease", { noLicense: true })),
    ).toThrow("d3-ease ships no license file.");
  });

  it("refuses a license that lost a copyright holder", () => {
    expect(() =>
      collectWebNotices(
        WEB_DIR,
        ioWith("d3-ease", {
          license: (text) => text.replace("Copyright 2001 Robert Penner", ""),
        }),
      ),
    ).toThrow("d3-ease's license no longer names Robert Penner.");
  });

  it("refuses a version or license that moved from its pin", () => {
    expect(() =>
      collectWebNotices(
        WEB_DIR,
        ioWith("zustand", {
          manifest: (json) => ({ ...json, version: "5.0.0" }),
        }),
      ),
    ).toThrow("zustand is 5.0.0, but its notice pins 4.5.7.");
    expect(() =>
      collectWebNotices(
        WEB_DIR,
        ioWith("classcat", {
          manifest: (json) => ({ ...json, license: "GPL-3.0" }),
        }),
      ),
    ).toThrow("classcat is now licensed GPL-3.0, not MIT.");
  });

  it("refuses a bundled dependency the notice does not name", () => {
    expect(() =>
      collectWebNotices(
        WEB_DIR,
        ioWith("d3-timer", {
          manifest: (json) => ({
            ...json,
            dependencies: { "left-pad": "1.3.0" },
          }),
        }),
      ),
    ).toThrow(/Cannot find left-pad|does not name: left-pad/);
  });
});
