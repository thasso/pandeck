import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  renderToolBlock,
  toolBlockIsVisible,
  type ToolBlock,
} from "./registry.tsx";

const notice: ToolBlock = {
  kind: "tool",
  name: "working_directory",
  toolId: "notice",
  args: {},
  output: JSON.stringify({
    renderKind: "workingDirectoryNotice",
    message:
      "Configured directory is unavailable. Using /data/personal-assistant.",
  }),
  done: true,
  isError: false,
};

test("cwd fallback is an always-visible transcript card when tools are hidden", () => {
  expect(toolBlockIsVisible(notice, false)).toBe(true);
  const markup = renderToStaticMarkup(
    renderToolBlock(notice, { showTools: false, expandTools: false }),
  );
  expect(markup).toContain("Working directory");
  expect(markup).toContain("Using /data/personal-assistant.");
});

test("partial, failed and malformed cwd notices do not claim to be cards", () => {
  for (const block of [
    { ...notice, done: false },
    { ...notice, isError: true },
    { ...notice, output: "bad" },
    {
      ...notice,
      output: '{"renderKind":"workingDirectoryNotice","message":3}',
    },
  ])
    expect(toolBlockIsVisible(block, false)).toBe(false);
});
