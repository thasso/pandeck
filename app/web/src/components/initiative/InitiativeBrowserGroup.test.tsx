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
});
