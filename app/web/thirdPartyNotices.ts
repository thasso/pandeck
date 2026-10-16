/**
 * The license notices of the third-party packages the web bundle's Initiative
 * map carries, written beside the bundle at build time (`NOTICE`,
 * `docs/deployment.md`).
 *
 * The texts are read from the INSTALLED packages, verbatim, so the notice names
 * exactly the code that is bundled. The build fails rather than ship a notice
 * that does not match: a package whose version or license moved, a license file
 * that is missing or lost a copyright holder, or a dependency the map pulled in
 * that this list does not name.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the notice file lands, relative to the web bundle's root. */
export const WEB_NOTICES_FILE = "licenses/third-party-web.md";

/** What the bundle is entered from: the map's one runtime dependency. */
const ROOT_PACKAGE = "@xyflow/react";

interface PinnedPackage {
  name: string;
  version: string;
  license: "MIT" | "ISC" | "BSD-3-Clause";
  /** Every holder the package's own license file must still name. */
  holders: string[];
}

/** The runtime packages the map added to the bundle, as pinned in the lockfile. */
export const WEB_NOTICE_PACKAGES: readonly PinnedPackage[] = [
  {
    name: "@xyflow/react",
    version: "12.12.0",
    license: "MIT",
    holders: ["webkid GmbH"],
  },
  {
    name: "@xyflow/system",
    version: "0.0.83",
    license: "MIT",
    holders: ["webkid GmbH"],
  },
  {
    name: "classcat",
    version: "5.0.5",
    license: "MIT",
    holders: ["Jorge Bucaran"],
  },
  {
    name: "zustand",
    version: "4.5.7",
    license: "MIT",
    holders: ["Paul Henschel"],
  },
  {
    name: "d3-color",
    version: "3.1.0",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-dispatch",
    version: "3.0.1",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-drag",
    version: "3.0.0",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-ease",
    version: "3.0.1",
    license: "BSD-3-Clause",
    holders: ["Mike Bostock", "Robert Penner"],
  },
  {
    name: "d3-interpolate",
    version: "3.0.1",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-selection",
    version: "3.0.0",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-timer",
    version: "3.0.1",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-transition",
    version: "3.0.1",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
  {
    name: "d3-zoom",
    version: "3.0.0",
    license: "ISC",
    holders: ["Mike Bostock"],
  },
];

/**
 * Runtime dependencies of the map that are NOT this list's: already part of
 * the bundle before the map (`use-sync-external-store`, under React), so their
 * notices are not the map's to add.
 */
const EXCLUDED = new Set(["use-sync-external-store"]);

/** The file system, injectable so a test can take one fact away at a time. */
export interface NoticeIo {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  realpath: (path: string) => string;
  readdir: (path: string) => string[];
}

const nodeIo: NoticeIo = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  realpath: realpathSync,
  readdir: (path) => readdirSync(path),
};

export interface WebNoticeEntry extends PinnedPackage {
  /** The package's own license file, verbatim. */
  text: string;
  /** Its file name inside the package, for the notice's provenance line. */
  file: string;
}

/** Node's lookup: the nearest `node_modules/<name>` above `fromDir`. */
function findPackage(fromDir: string, name: string, io: NoticeIo): string {
  let dir = fromDir;
  for (;;) {
    if (!dir.endsWith("/node_modules")) {
      const candidate = join(dir, "node_modules", name);
      if (io.exists(join(candidate, "package.json")))
        return io.realpath(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`Cannot find ${name} from ${fromDir} for its notice.`);
    dir = parent;
  }
}

/**
 * Collect the map's bundled packages from the installed tree, starting at the
 * web package directory, and check each against its pin.
 */
export function collectWebNotices(
  webDir: string,
  io: NoticeIo = nodeIo,
): WebNoticeEntry[] {
  const pinned = new Map(
    WEB_NOTICE_PACKAGES.map((entry) => [entry.name, entry]),
  );
  const found = new Map<string, string>();
  const queue: Array<{ name: string; from: string }> = [
    { name: ROOT_PACKAGE, from: webDir },
  ];
  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    if (found.has(name) || EXCLUDED.has(name) || name.startsWith("@types/"))
      continue;
    const dir = findPackage(from, name, io);
    found.set(name, dir);
    const manifest = JSON.parse(io.readFile(join(dir, "package.json"))) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dependency, from: dir });
  }
  const unlisted = [...found.keys()].filter((name) => !pinned.has(name));
  if (unlisted.length > 0)
    throw new Error(
      `The map bundles packages its notice does not name: ${unlisted.join(", ")}.`,
    );
  const missing = [...pinned.keys()].filter((name) => !found.has(name));
  if (missing.length > 0)
    throw new Error(
      `The notice names packages the map no longer bundles: ${missing.join(", ")}.`,
    );
  return WEB_NOTICE_PACKAGES.map((entry) => {
    const dir = found.get(entry.name)!;
    const manifest = JSON.parse(io.readFile(join(dir, "package.json"))) as {
      version?: string;
      license?: string;
    };
    if (manifest.version !== entry.version)
      throw new Error(
        `${entry.name} is ${manifest.version}, but its notice pins ${entry.version}.`,
      );
    if (manifest.license !== entry.license)
      throw new Error(
        `${entry.name} is now licensed ${manifest.license}, not ${entry.license}.`,
      );
    const file = io
      .readdir(dir)
      .find((candidate) => /^licen[cs]e(\.(md|txt))?$/i.test(candidate));
    if (!file) throw new Error(`${entry.name} ships no license file.`);
    const text = io.readFile(join(dir, file));
    for (const holder of entry.holders)
      if (!text.includes(holder))
        throw new Error(`${entry.name}'s license no longer names ${holder}.`);
    return { ...entry, text, file };
  });
}

/** The notice file: each package with its version, license and own text. */
export function renderWebNotices(entries: readonly WebNoticeEntry[]): string {
  const sections = entries.map((entry) =>
    [
      `## ${entry.name} ${entry.version} (${entry.license})`,
      "",
      `Source: https://www.npmjs.com/package/${entry.name}/v/${entry.version}`,
      `License text: \`${entry.file}\` of the package, verbatim.`,
      "",
      "````text",
      entry.text.trimEnd(),
      "````",
    ].join("\n"),
  );
  return [
    "# Third-party notices for the Pandeck web app",
    "",
    "The Initiative map in this web bundle contains the following packages,",
    "unmodified apart from bundling and minification. Each license text is the",
    "package's own, copied from the installed package when the bundle was built.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

/** The comment the map's chunk carries, so the bundle names where these live. */
export function webNoticeBanner(): string {
  const licenses = [
    ...new Set(WEB_NOTICE_PACKAGES.map((entry) => entry.license)),
  ];
  return `/*! @xyflow/react ${WEB_NOTICE_PACKAGES[0]!.version} and the packages it bundles | ${licenses.join(", ")} | license texts: /${WEB_NOTICES_FILE} */\n`;
}
