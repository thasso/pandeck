import { describe, expect, it } from "vitest";
import { followRowLink, type RowLinkClick } from "./rowLink.ts";

function click(patch: Partial<RowLinkClick> = {}) {
  const calls = { stopped: 0, prevented: 0 };
  const event: RowLinkClick = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    stopPropagation: () => calls.stopped++,
    preventDefault: () => calls.prevented++,
    ...patch,
  };
  return { event, calls };
}

describe("followRowLink", () => {
  it("navigates in-app and keeps the click off the row", () => {
    const { event, calls } = click();
    const paths: string[] = [];
    followRowLink(event, "/tasks/1", (path) => paths.push(path));
    expect(paths).toEqual(["/tasks/1"]);
    expect(calls).toEqual({ stopped: 1, prevented: 1 });
  });

  it("leaves every modifier click to the browser", () => {
    // Cmd/Ctrl/Shift/Alt open a tab, a window, or download — the app must not
    // swallow any of them, and the row must not act on them either.
    for (const modifier of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
    ] as const) {
      const { event, calls } = click({ [modifier]: true });
      const paths: string[] = [];
      followRowLink(event, "/tasks/1", (path) => paths.push(path));
      expect(paths).toEqual([]);
      expect(calls).toEqual({ stopped: 1, prevented: 0 });
    }
  });

  it("stops the click but stands aside with no navigator", () => {
    // An off-site link (a pull request) and a host that cannot navigate are the
    // same case: the `href` does the work.
    const { event, calls } = click();
    followRowLink(event, "https://forge/pulls/91");
    expect(calls).toEqual({ stopped: 1, prevented: 0 });
  });
});
