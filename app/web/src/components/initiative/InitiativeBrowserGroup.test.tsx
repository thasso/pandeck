// @vitest-environment jsdom
/**
 * The Initiatives group atop the Projects browser: a failed list read is
 * stated with a retry rather than an endless skeleton (F030).
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeBrowserGroup.test.tsx
 */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../test/mount.tsx";
import { hostedLabsSummary } from "../../../component-preview/fixtures/initiatives.ts";
import { InitiativeBrowserGroup } from "./InitiativeBrowserGroup.tsx";

const failure = "Failed to list Initiatives: database is locked";

describe("InitiativeBrowserGroup", () => {
  it("states a cold failure with a retry, not a loading skeleton", () => {
    const onRetry = vi.fn();
    const { container } = mount(
      <InitiativeBrowserGroup
        initiatives={[]}
        fresh={false}
        refreshing={false}
        error={failure}
        onRetry={onRetry}
        selectedId={null}
        onNavigate={() => {}}
      />,
    );
    expect(container.textContent).toContain(failure);
    expect(
      container.querySelector('[aria-label="Loading Initiatives"]'),
    ).toBeNull();
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    act(() => retry!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the rows it holds under a later failure", () => {
    const { container } = mount(
      <InitiativeBrowserGroup
        initiatives={[hostedLabsSummary()]}
        fresh={false}
        refreshing={false}
        error={failure}
        onRetry={() => {}}
        selectedId={null}
        onNavigate={() => {}}
      />,
    );
    expect(container.textContent).toContain(failure);
    expect(container.textContent).toContain("Hosted Labs");
  });

  it("is loading only while no answer and no failure exist", () => {
    const { container } = mount(
      <InitiativeBrowserGroup
        initiatives={[]}
        fresh={false}
        refreshing={false}
        error={null}
        onRetry={() => {}}
        selectedId={null}
        onNavigate={() => {}}
      />,
    );
    expect(
      container.querySelector('[aria-label="Loading Initiatives"]'),
    ).not.toBeNull();
  });

  it("is the app's group band: its heading only folds the rows, with no index link (F051)", () => {
    const onNavigate = vi.fn();
    const labs = hostedLabsSummary();
    const { container } = mount(
      <InitiativeBrowserGroup
        initiatives={[labs]}
        fresh
        refreshing={false}
        error={null}
        onRetry={() => {}}
        selectedId={null}
        onNavigate={onNavigate}
      />,
    );
    const heading = container.querySelector("h2");
    // The stock band: a heading holding the fold control.
    expect(heading, "the group band's heading").not.toBeNull();
    const fold = heading!.querySelector("button")!;
    expect(fold.textContent).toContain("Initiatives");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('a[href="/initiatives"]'),
      "the group links to no Initiatives index",
    ).toBeNull();
    const row = () =>
      container.querySelector<HTMLAnchorElement>(
        `a[href="/initiatives/${labs.id}"]`,
      );
    expect(row()).not.toBeNull();

    // The heading folds and unfolds; it navigates nowhere.
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    const folded = row();
    expect(folded === null || folded.closest("[hidden]") !== null).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    // A row still opens its Initiative in the app on a plain click, and leaves
    // a modifier click (a new tab) to the browser.
    const click = (init: MouseEventInit) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      let prevented: boolean | undefined;
      const observe = (seen: Event) => {
        prevented = seen.defaultPrevented;
        seen.preventDefault();
      };
      container.addEventListener("click", observe, { once: true });
      act(() => {
        row()!.dispatchEvent(event);
      });
      return prevented;
    };
    expect(click({})).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith(`/initiatives/${labs.id}`);
    onNavigate.mockClear();
    expect(click({ ctrlKey: true })).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("unfolds for the open Initiative and marks its row", () => {
    window.sessionStorage.setItem(
      "list-group-open:initiatives",
      JSON.stringify(false),
    );
    const labs = hostedLabsSummary();
    const { container } = mount(
      <InitiativeBrowserGroup
        initiatives={[labs]}
        fresh
        refreshing={false}
        error={null}
        onRetry={() => {}}
        selectedId={labs.id}
        onNavigate={() => {}}
      />,
    );
    const fold = container.querySelector("h2 button");
    expect(fold, "the group band's fold control").not.toBeNull();
    expect(fold!.getAttribute("aria-expanded")).toBe("true");
    expect(
      container
        .querySelector(`a[href="/initiatives/${labs.id}"]`)!
        .getAttribute("aria-current"),
    ).toBe("page");
    window.sessionStorage.clear();
  });
});
