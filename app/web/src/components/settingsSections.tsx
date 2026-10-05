import type { ReactNode } from "react";
import {
  Activity,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Brain,
  Building2,
  Cable,
  Clock,
  Cloud,
  Cpu,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Globe,
  Info,
  KeyRound,
  MessageSquare,
  Mic,
  Radio,
  PackageOpen,
  Palette,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Users,
  WandSparkles,
} from "lucide-react";
import type { SettingsSection } from "../hooks/useSessionRouting.ts";
import { supportsNativePortForwarding } from "../lib/nativeShell.ts";

export interface SettingsSectionEntry {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  /**
   * Whether this client lists the section in its navigation. Every section
   * stays ROUTABLE everywhere — a shared link must land on a page that says
   * what the section needs rather than on nothing — so this hides only the
   * entry, never the route.
   */
  shownWhen?: () => boolean;
}

export interface SettingsSectionGroup {
  id:
    | "general"
    | "models-providers"
    | "assistant"
    | "developer"
    | "automation"
    | "integrations";
  label: string;
  sections: SettingsSectionEntry[];
}

/**
 * The single grouped settings navigation model, shared by the sidebar's
 * settings browser and the SettingsPage header. Section ids (and the routes
 * they map to) are owned by `hooks/useSessionRouting.ts`.
 */
export const SETTINGS_GROUPS: SettingsSectionGroup[] = [
  {
    id: "general",
    label: "General",
    sections: [
      { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
      { id: "profile", label: "Profile", icon: <UserRound size={15} /> },
      { id: "about", label: "About", icon: <Info size={15} /> },
    ],
  },
  {
    id: "models-providers",
    label: "Models & providers",
    sections: [
      { id: "models", label: "Models", icon: <SlidersHorizontal size={15} /> },
      { id: "claude-sdk", label: "Claude SDK", icon: <Bot size={15} /> },
      { id: "openai", label: "OpenAI", icon: <KeyRound size={15} /> },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible",
        icon: <Cpu size={15} />,
      },
    ],
  },
  {
    id: "assistant",
    label: "Assistant behavior",
    sections: [
      {
        id: "personal-assistant",
        label: "Personal Assistant",
        icon: <Bot size={15} />,
      },
      { id: "memory", label: "Memory", icon: <Sparkles size={15} /> },
      { id: "naming", label: "Session naming", icon: <Brain size={15} /> },
      {
        id: "refinement",
        label: "Prompt refinement",
        icon: <WandSparkles size={15} />,
      },
      { id: "dictation", label: "Dictation", icon: <Mic size={15} /> },
      { id: "notifications", label: "Notifications", icon: <Bell size={15} /> },
    ],
  },
  {
    id: "developer",
    label: "Developer workflow",
    sections: [
      { id: "worktrees", label: "Worktrees", icon: <GitBranch size={15} /> },
      { id: "skills", label: "Skills", icon: <Blocks size={15} /> },
      {
        id: "peer-runtimes",
        label: "Peer sessions",
        icon: <Users size={15} />,
      },
      {
        id: "background-processes",
        label: "Background processes",
        icon: <Activity size={15} />,
      },
      {
        id: "port-forwarding",
        label: "Port forwarding",
        icon: <Cable size={15} />,
        // Only the macOS app can listen on the laptop; a browser tab would be
        // offered a control that can never do anything.
        shownWhen: supportsNativePortForwarding,
      },
      {
        id: "commit",
        label: "Commit agent",
        icon: <GitCommitHorizontal size={15} />,
      },
      {
        id: "pull-request",
        label: "Pull request agent",
        icon: <GitPullRequestArrow size={15} />,
      },
    ],
  },
  {
    id: "automation",
    label: "Tasks & automation",
    sections: [
      {
        id: "task-intake",
        label: "Task intake agent",
        icon: <Bot size={15} />,
      },
      {
        id: "pdf-conversion",
        label: "PDF conversion",
        icon: <FileText size={15} />,
      },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: [
      {
        id: "browserTools",
        label: "Browser tools",
        icon: <PackageOpen size={15} />,
      },
      { id: "google", label: "Google Workspace", icon: <Cloud size={15} /> },
      { id: "slack", label: "Slack", icon: <MessageSquare size={15} /> },
      {
        id: "slack-huddles",
        label: "Slack Huddles",
        icon: <Radio size={15} />,
      },
      { id: "jira", label: "Jira", icon: <Building2 size={15} /> },
      { id: "confluence", label: "Confluence", icon: <FileText size={15} /> },
      { id: "tempo", label: "Tempo", icon: <Clock size={15} /> },
      { id: "github", label: "GitHub", icon: <GitBranch size={15} /> },
      {
        id: "forgejo",
        label: "Forgejo",
        icon: <GitPullRequestArrow size={15} />,
      },
      { id: "web-search", label: "Web Search", icon: <Globe size={15} /> },
      { id: "context7", label: "Context7", icon: <BookOpen size={15} /> },
    ],
  },
];

export const SETTINGS_SECTIONS: SettingsSectionEntry[] =
  SETTINGS_GROUPS.flatMap((group) => group.sections);

/** The groups as THIS client lists them: entries it cannot act on are left out. */
export function navigableSettingsGroups(): SettingsSectionGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter(
      (section) => section.shownWhen === undefined || section.shownWhen(),
    ),
  }));
}
