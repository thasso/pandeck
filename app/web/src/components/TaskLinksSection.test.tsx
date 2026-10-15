// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskLinkedTask, TaskLinks } from "@assistant/shared";
import { TaskLinksSection } from "./TaskLinksSection.tsx";

/**
 * The Task page's read-only Links section: three groups as they read from the
 * open Task, nothing drawn for what is empty, done and archived Tasks toned
 * back but still there, and every row a way to the linked Task.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function linked(
  id: string,
  patch: Partial<TaskLinkedTask> = {},
): TaskLinkedTask {
  return {
    id,
    title: `Linked ${id}`,
    status: "todo",
    archived: false,
    ...patch,
  };
}

function links(patch: Partial<TaskLinks> = {}): TaskLinks {
  return { blocks: [], blockedBy: [], relates: [], ...patch };
}

function render(value: TaskLinks | undefined): string[] {
  const opened: string[] = [];
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <TaskLinksSection links={value} onOpenTask={(id) => opened.push(id)} />,
    );
  });
  return opened;
}

/** The group labels in the order they are drawn. */
function groups(): string[] {
  return [...container!.querySelectorAll('[role="group"]')].map((group) =>
    group.getAttribute("aria-label")!,
  );
}

function row(title: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(title),
  );
  if (!found) throw new Error(`no row ${title}`);
  return found;
}

describe("TaskLinksSection", () => {
  it("groups the links as Blocked by, Blocks, Related", () => {
    render(
      links({
        relates: [linked("4")],
        blocks: [linked("3")],
        blockedBy: [linked("1"), linked("2")],
      }),
    );
    expect(groups()).toEqual(["Blocked by", "Blocks", "Related"]);
    const blockedBy = container!.querySelector(
      '[role="group"][aria-label="Blocked by"]',
    )!;
    expect(blockedBy.textContent).toContain("Linked 1");
    expect(blockedBy.textContent).toContain("Linked 2");
    expect(blockedBy.textContent).not.toContain("Linked 3");
    // Each row names its Task by id as well as title.
    expect(row("Linked 3").textContent).toContain("#3");
  });

  it("drops an empty group, and the whole section when there are no links", () => {
    render(links({ relates: [linked("4")] }));
    expect(groups()).toEqual(["Related"]);

    render(links());
    expect(container!.querySelector('section[aria-label="Links"]')).toBeNull();
    render(undefined);
    expect(container!.innerHTML).toBe("");
  });

  it("tones back done and archived Tasks without hiding them", () => {
    render(
      links({
        blockedBy: [
          linked("1", { title: "Still open" }),
          linked("2", { title: "Finished", status: "done" }),
          linked("3", { title: "Shelved", archived: true }),
        ],
      }),
    );
    const title = (text: string) =>
      [...row(text).querySelectorAll("span")].find(
        (span) => span.textContent === text,
      )!;
    expect(title("Still open").className).not.toContain(
      "text-muted-foreground",
    );
    expect(title("Finished").className).toContain("line-through");
    expect(title("Finished").className).toContain("text-muted-foreground");
    expect(title("Shelved").className).toContain("text-muted-foreground");
    expect(row("Shelved").textContent).toContain("Archived");
    expect(row("Still open").textContent).not.toContain("Archived");
  });

  it("opens the linked Task from its row", () => {
    const opened = render(links({ blocks: [linked("9", { title: "Next" })] }));
    act(() => row("Next").click());
    expect(opened).toEqual(["9"]);
  });
});
