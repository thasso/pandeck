import { useCallback, useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorktreeComment } from "@assistant/shared";
import WorktreeDetailPage from "../../../src/components/worktree/WorktreeDetailPage.tsx";
import { WorktreeDeliverySection } from "../../../src/components/worktree/WorktreeDelivery.tsx";
import type { Prefs } from "../../../src/hooks/usePrefs.ts";
import type { WorktreeView } from "../../../src/hooks/useSessionRouting.ts";
import {
  cleanStatus,
  dirtyStatus,
  featureWorktree,
  installWorktreeApi,
  reviewComments,
  storyPrefs,
} from "../../fixtures/worktree.ts";

export interface WorktreeDetailStoryProps {
  frameWidth: number;
  frameHeight: number;
  scenario: "clean" | "dirty" | "with-pr";
  view: WorktreeView;
  filePath?: string;
  layout: "by-file" | "changeset";
  narrow: boolean;
}

interface Route {
  view: WorktreeView;
  filePath?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** What `navigate` is handed, read back into the page's route props. */
function parseRoute(path: string): Route {
  const url = new URL(path, "http://story.local");
  const view = url.pathname.split("/").at(-1) === "files" ? "files" : "changes";
  return {
    view,
    filePath: url.searchParams.get("path") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
}

const COMMENT_ACTIONS = {
  onAddComment: () => {},
  onResolveComment: () => {},
  onDeleteComment: () => {},
};

/**
 * The production worktree page over a fake REST server: Review (by file or all
 * files), Files (tree, source, Markdown preview, history) and, for `with-pr`,
 * the Delivery section the object panel shows beside it.
 */
export function WorktreeDetailStory({
  frameWidth,
  frameHeight,
  scenario,
  view,
  filePath,
  layout,
  narrow,
}: WorktreeDetailStoryProps) {
  const status = scenario === "clean" ? cleanStatus : dirtyStatus;
  // Installed before the first render so the page's first reads hit it.
  const [restore] = useState(() =>
    installWorktreeApi(
      scenario === "clean" ? { status, files: [] } : { status },
    ),
  );
  useEffect(() => restore, [restore]);

  const [route, setRoute] = useState<Route>({ view, filePath });
  const [prefs, setPrefs] = useState<Prefs>({
    ...storyPrefs,
    worktreeReviewMode: layout,
  });
  const updatePrefs = useCallback(
    (patch: Partial<Prefs>) =>
      setPrefs((current) => ({ ...current, ...patch })),
    [],
  );
  const comments: WorktreeComment[] =
    scenario === "clean" ? [] : reviewComments;

  return (
    <div className="flex bg-background" style={{ height: frameHeight }}>
      <div className="flex min-w-0 flex-col" style={{ width: frameWidth }}>
        <WorktreeDetailPage
          worktree={featureWorktree}
          status={status}
          narrow={narrow}
          view={route.view}
          filePath={route.filePath}
          from={route.from}
          to={route.to}
          navigate={(path) => setRoute(parseRoute(path))}
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          comments={comments}
          onLoadComments={() => {}}
          onUnloadComments={() => {}}
          commentActions={COMMENT_ACTIONS}
          onSubmitReview={() => {}}
          markdownPreviewFirst
        />
      </div>
      {scenario === "with-pr" ? (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-2">
          <WorktreeDeliverySection
            worktree={featureWorktree}
            storageScope="story"
            delivery={{
              status,
              hosting: {
                worktreeId: featureWorktree.id,
                provider: "github",
                repoWebUrl: "https://github.com/pandeck/pandeck",
                pr: {
                  number: 418,
                  url: "https://github.com/pandeck/pandeck/pull/418",
                  title: "Back off between provider retries",
                  state: "open",
                },
                ci: { state: "pending", total: 9 },
                review: { changesRequested: false, unresolvedThreads: 1 },
              },
              actions: [],
              dialogs: null,
            }}
          />
        </aside>
      ) : null}
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "worktree-detail",
  title: "App/Worktree/Detail page",
  component: WorktreeDetailStory,
  parameters: { layout: "fullscreen" },
  args: {
    frameWidth: 1024,
    frameHeight: 720,
    scenario: "dirty",
    view: "changes",
    layout: "by-file",
    narrow: false,
  },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 1280, step: 1 } },
    scenario: {
      control: "inline-radio",
      options: ["clean", "dirty", "with-pr"],
    },
    view: { control: "inline-radio", options: ["changes", "files"] },
    layout: { control: "inline-radio", options: ["by-file", "changeset"] },
  },
} satisfies Meta<typeof WorktreeDetailStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Clean: Story = { args: { scenario: "clean" } };

export const DirtyByFile: Story = {
  args: { filePath: "src/lib/retry.ts" },
};

export const DirtyByFileDark: Story = {
  args: { filePath: "src/lib/retry.ts" },
  globals: { theme: "dark" },
};

export const ChangesetList: Story = { args: { layout: "changeset" } };

export const WithPullRequest: Story = {
  args: { scenario: "with-pr", frameWidth: 760, filePath: "docs/retries.md" },
};

export const FileNavigatorAndCode: Story = {
  args: { view: "files", filePath: "src/lib/retry.ts" },
};

export const FileMarkdown: Story = {
  args: { view: "files", filePath: "docs/retries.md" },
};

export const FileMarkdownDark: Story = {
  args: { view: "files", filePath: "docs/retries.md" },
  globals: { theme: "dark" },
};

export const Phone: Story = {
  args: { frameWidth: 390, narrow: true, layout: "changeset" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};
