import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BuildInfo } from "@assistant/shared/buildInfo";
import { AboutSettingsSection } from "./AboutSettingsSection.tsx";

/**
 * What the About section is FOR: telling the browser bundle's build from the
 * server's. So the assertions are about the two rows existing separately, and
 * about the section saying nothing it does not know — a client that has not heard
 * from the server yet must not print a version for it.
 *
 * Rendered server-side, so `nativeShellPlatform()` sees no document and the shell
 * row is absent, which is also the browser case.
 */
const server: BuildInfo = {
  version: "0.14.1",
  commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  release: true,
};

describe("AboutSettingsSection", () => {
  it("names the server's build separately from the web app's", () => {
    const markup = renderToStaticMarkup(
      <AboutSettingsSection serverBuild={server} />,
    );

    expect(markup).toContain("Server");
    expect(markup).toContain("0.14.1 (1a2b3c4d)");
    expect(markup).toContain("Web app");
  });

  it("says the server has not answered rather than showing a version", () => {
    const markup = renderToStaticMarkup(
      <AboutSettingsSection serverBuild={null} />,
    );

    expect(markup).toContain("Waiting for the server…");
    expect(markup).not.toContain("1a2b3c4d");
  });

  it("marks a server build that is not the tagged release", () => {
    const markup = renderToStaticMarkup(
      <AboutSettingsSection serverBuild={{ ...server, release: false }} />,
    );

    expect(markup).toContain("0.14.1-dev (1a2b3c4d)");
  });
});
