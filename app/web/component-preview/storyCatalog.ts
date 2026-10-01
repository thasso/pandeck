export type PreviewTheme = "light" | "dark";
export type PreviewTextScale = "100" | "110" | "120" | "130";

export interface StoryPreviewDefinition {
  title: string;
  frameWidth: number;
  canvasWidth: number;
  canvasHeight: number;
  theme: PreviewTheme;
  textScale: PreviewTextScale;
}

/**
 * Stories the chat adapter can build. IDs match Storybook's stable CSF ids, so
 * the catalog and the one-story chat output name the same case.
 */
export const storyCatalog = {
  "prompt-queue--running": {
    title: "Composer with a queue, turn running",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 460,
    theme: "dark",
    textScale: "100",
  },
  "prompt-queue--paused": {
    title: "Composer with a paused queue",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 460,
    theme: "dark",
    textScale: "100",
  },
  "prompt-queue--phone": {
    title: "Composer with a queue, phone",
    frameWidth: 390,
    canvasWidth: 390,
    canvasHeight: 460,
    theme: "dark",
    textScale: "100",
  },
  "session-inbox--attention-mix": {
    title: "Attention list, default rail",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 720,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--minimum-rail": {
    title: "Attention list, minimum rail",
    frameWidth: 220,
    canvasWidth: 1024,
    canvasHeight: 720,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--phone": {
    title: "Attention list, phone",
    frameWidth: 390,
    canvasWidth: 390,
    canvasHeight: 720,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--dark-large-text": {
    title: "Attention list, dark with 120% text",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 720,
    theme: "dark",
    textScale: "120",
  },
  "session-inbox--phone-dark-large-text": {
    title: "Attention list, phone, dark with 130% text",
    frameWidth: 390,
    canvasWidth: 390,
    canvasHeight: 720,
    theme: "dark",
    textScale: "130",
  },
  "session-inbox--phone-quiet-list": {
    title: "Activity list, phone",
    frameWidth: 390,
    canvasWidth: 390,
    canvasHeight: 844,
    theme: "dark",
    textScale: "130",
  },
  "session-inbox--all-states": {
    title: "Attention list, every card state",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 2400,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--sessions": {
    title: "Attention list, session cards only",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 2400,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--workflow-runs": {
    title: "Attention list, Workflow Run cards only",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 1600,
    theme: "light",
    textScale: "100",
  },
  "session-inbox--all-states-dark": {
    title: "Attention list, every card state, dark",
    frameWidth: 256,
    canvasWidth: 1024,
    canvasHeight: 2400,
    theme: "dark",
    textScale: "100",
  },
  "session-inbox--all-states-phone": {
    title: "Attention list, every card state, phone",
    frameWidth: 390,
    canvasWidth: 390,
    canvasHeight: 2400,
    theme: "light",
    textScale: "100",
  },
  "jira-issue-approval--create": {
    title: "Jira create approval, chat column",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 900,
    theme: "light",
    textScale: "100",
  },
  "jira-issue-approval--create-preview": {
    title: "Jira create approval, full ticket open",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 900,
    theme: "light",
    textScale: "100",
  },
  "jira-issue-approval--comment": {
    title: "Jira comment approval, chat column",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 600,
    theme: "dark",
    textScale: "100",
  },
  "jira-issue-approval--executed": {
    title: "Jira create approval, executed with warning",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 900,
    theme: "light",
    textScale: "100",
  },
  "github-approval--all-cards": {
    title: "GitHub issue and branch approvals, pending and resolved",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 1500,
    theme: "light",
    textScale: "100",
  },
  "approval-session-grant--lifecycle": {
    title: "Approve for session: grant, queued and auto-approved cards",
    frameWidth: 720,
    canvasWidth: 1024,
    canvasHeight: 1100,
    theme: "light",
    textScale: "100",
  },
} as const satisfies Record<string, StoryPreviewDefinition>;

export type StoryPreviewId = keyof typeof storyCatalog;

export function isStoryPreviewId(value: string): value is StoryPreviewId {
  return Object.hasOwn(storyCatalog, value);
}
