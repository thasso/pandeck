import type { Meta, StoryObj } from "@storybook/react-vite";
import { InitiativesIndexPage } from "../../../src/components/initiative/InitiativesIndexPage.tsx";
import { hostedLabsSummary } from "../../fixtures/initiatives.ts";

const initiatives = [
  hostedLabsSummary(),
  hostedLabsSummary({
    id: "8",
    title: "Backlog search rewrite",
    state: "paused",
    progress: { total: 12, done: 4, doing: 1, startable: 3, blocked: 2 },
  }),
  hostedLabsSummary({
    id: "5",
    title: "Desktop shell 1.0",
    state: "done",
    progress: { total: 18, done: 18, doing: 0, startable: 0, blocked: 0 },
  }),
];

const meta = {
  title: "App/Initiatives/Initiatives index",
  component: InitiativesIndexPage,
  args: {
    initiatives,
    fresh: true,
    error: null,
    onRetry: () => {},
    onOpen: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InitiativesIndexPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ByState: Story = {};
export const Loading: Story = { args: { initiatives: [], fresh: false } };
export const Refreshing: Story = { args: { fresh: false } };
export const Empty: Story = { args: { initiatives: [] } };
export const Failed: Story = {
  args: {
    initiatives: [],
    fresh: false,
    error: "Failed to list Initiatives: the database is busy.",
  },
};
