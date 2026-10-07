import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkdownFile } from "../../../src/components/MarkdownFile.tsx";

export interface MarkdownFileStoryProps {
  frameWidth: number;
}

const PLAIN = `---
title: Release checklist
tags: [release, ops]
owner: platform team
status: draft
reviewers:
  - ana
  - ben
---
# Release checklist

Run the gates, then tag the build.
`;

const NAMESPACED = `---
kb:
  schema: 1
  id: drm-session-binding-overview
  title: DRM session binding
  status: active
  tags:
    - project:drmtoday
    - drm
  links:
    - pa://project/drmtoday
---
## Overview

A namespaced block reads as its namespace's fields.
`;

const UNPARSEABLE = `---
summary: |
  A block scalar the shared YAML subset does not read.
---
The raw block stays out of the rendered body.
`;

/**
 * Three Markdown files as the document viewers draw them: a plain frontmatter
 * block, a single-namespace block, and YAML outside the shared subset.
 */
export function MarkdownFileStory({ frameWidth }: MarkdownFileStoryProps) {
  return (
    <div className="bg-background p-4">
      <div className="flex flex-col gap-8" style={{ width: frameWidth }}>
        {[PLAIN, NAMESPACED, UNPARSEABLE].map((text) => (
          <article key={text}>
            <MarkdownFile text={text} />
          </article>
        ))}
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "markdown-file",
  title: "Worktree/Markdown file",
  component: MarkdownFileStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
  },
} satisfies Meta<typeof MarkdownFileStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Frontmatter: Story = {
  args: { frameWidth: 720 },
};

export const FrontmatterDark: Story = {
  args: { frameWidth: 720 },
  globals: { theme: "dark" },
};
