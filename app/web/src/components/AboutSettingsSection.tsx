/**
 * Settings → About: which build of each part of the app is actually running.
 *
 * Three answers, not one. The browser bundle, the server that served it, and the
 * native shell hosting the page are versioned and deployed independently — a tab
 * can outlive a deploy, and the desktop app is installed by hand — so this lists
 * them side by side instead of printing one number and implying it covers
 * everything. The desktop app's own About panel shows its row of this table; when
 * the question is "is the server on the release I just cut", this is the surface.
 */
import type { BuildInfo } from "@assistant/shared/buildInfo";
import { formatBuildInfo } from "@assistant/shared/buildInfo";
import { useFetchState } from "../hooks/useFetchState.ts";
import { dataOf } from "../lib/loadState.ts";
import { appBuildInfo } from "../lib/appBuild.ts";
import { nativeShellBuild, nativeShellPlatform } from "../lib/nativeShell.ts";
import { CopyButton } from "./ui/CopyButton.tsx";

/** How the shell's row is titled, per platform. */
const SHELL_LABELS: Record<string, string> = {
  macos: "Desktop app (macOS)",
  ios: "iOS app",
  desktop: "Desktop app",
};

interface Row {
  label: string;
  /** Null while the answer is still outstanding; that is a state, not a value. */
  build: BuildInfo | null;
  /** What to say instead of a version when there is no answer. */
  missing: string;
}

function BuildRow({ label, build, missing }: Row) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-body text-fg">{label}</span>
      {build ? (
        <span className="font-mono text-caption text-muted">
          {formatBuildInfo(build)}
        </span>
      ) : (
        <span className="text-caption text-muted">{missing}</span>
      )}
    </div>
  );
}

/** The shell answers from an installed binary, so one key with no arguments. */
const SHELL_BUILD_KEY = "native-shell";

export function AboutSettingsSection({
  serverBuild,
}: {
  /** The server's build from `ready`, or null before this client has connected. */
  serverBuild: BuildInfo | null;
}) {
  const platform = nativeShellPlatform();
  // Asked once, and only in the shell: the answer is a property of the installed
  // binary, so it cannot change while this page is open.
  const { state: shell } = useFetchState<BuildInfo | null>(
    SHELL_BUILD_KEY,
    () => nativeShellBuild(),
    { enabled: platform !== null },
  );
  const shellBuild = dataOf(shell) ?? null;
  const rows: Row[] = [
    { label: "Web app", build: appBuildInfo(), missing: "Unknown" },
    {
      label: "Server",
      build: serverBuild,
      missing: "Waiting for the server…",
    },
    // A browser gets no third row at all: there is no shell to have a version.
    ...(platform
      ? [
          {
            label: SHELL_LABELS[platform] ?? "Native shell",
            build: shellBuild,
            missing: "Unknown",
          },
        ]
      : []),
  ];

  // One block to paste into a bug report: every row, including the ones that had
  // no answer, because "the server never said" is itself the report.
  const diagnostic = rows
    .map(
      (row) =>
        `${row.label}: ${row.build ? formatBuildInfo(row.build) : "unknown"}`,
    )
    .join("\n");

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-heading font-semibold">About</h2>
      <p className="mt-1 text-caption text-muted">
        Which build each part of the app is running. They are updated
        independently — the browser reloads itself on a deploy, the desktop app
        is installed by hand — so these can legitimately differ.
      </p>

      <div className="mt-6 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-body font-semibold text-fg">Versions</h3>
          <CopyButton
            value={diagnostic}
            label="Copy version details"
            copiedLabel="Version details copied"
          />
        </div>
        <div className="mt-2 divide-y divide-line">
          {rows.map((row) => (
            <BuildRow key={row.label} {...row} />
          ))}
        </div>
        <p className="mt-3 text-micro text-muted">
          Each entry is the released version followed by the commit it was built
          from. <span className="font-mono">-dev</span> marks a build ahead of
          its release tag, and <span className="font-mono">-dirty</span> one
          built from a modified working tree.
        </p>
      </div>
    </div>
  );
}
