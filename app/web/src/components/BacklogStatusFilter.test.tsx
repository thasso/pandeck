// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "@assistant/shared";
import { BacklogStatusFilter } from "./BacklogStatusFilter.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Host({ onChange }: { onChange: (next: TaskStatus[]) => void }) {
  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  return (
    <BacklogStatusFilter
      statuses={new Set(statuses)}
      onChange={(next) => {
        onChange(next);
        setStatuses(next);
      }}
    />
  );
}

describe("BacklogStatusFilter", () => {
  it("selects several statuses at once and deselects one", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const toggle = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      )!;
    try {
      await act(async () => root.render(<Host onChange={onChange} />));
      await act(async () => toggle("To do").click());
      await act(async () => toggle("Done").click());
      expect(onChange).toHaveBeenLastCalledWith(["todo", "done"]);
      expect(toggle("To do").getAttribute("aria-pressed")).toBe("true");
      expect(toggle("Done").getAttribute("aria-pressed")).toBe("true");

      await act(async () => toggle("To do").click());
      expect(onChange).toHaveBeenLastCalledWith(["done"]);
      expect(toggle("To do").getAttribute("aria-pressed")).toBe("false");
      expect(toggle("Done").getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
