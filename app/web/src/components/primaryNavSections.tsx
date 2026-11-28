import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  ClipboardList,
  FolderKanban,
  Gauge,
  GitPullRequest,
  List,
  MessageSquarePlus,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import type { NavSlot } from "../hooks/useSidebarSection.ts";

/**
 * Label and icon per navigation-bar slot — the display registry shared by the
 * sidebar's navigation bar and the Settings order editor. Sections and the
 * app-level actions that share the bar are one flat table here, because in the
 * bar they are one flat row: same slot width, same treatment, one user order.
 *
 * Slots carry no counts, with ONE exception: Schedules overlays the number
 * whose last occurrence failed (`docs/schedules.md`, Web), because nothing
 * else surfaces a failure that happened while nobody watched. The count is an
 * overlay like the unread dot, so slot widths stay uniform and the bar's
 * overflow math exact (see `shell/navOverflow.ts`).
 * Order is a user preference (`prefs.navSlots`), not a property of this registry,
 * and the Personal Assistant's label is overridden with its configured name by
 * the host that knows it.
 */
export const PRIMARY_NAV_SLOTS: Record<
  NavSlot,
  { label: string; icon: ReactNode }
> = {
  "new-session": {
    label: "New Session",
    icon: <MessageSquarePlus size={17} />,
  },
  assistant: { label: "Personal Assistant", icon: <Bot size={17} /> },
  sessions: { label: "Sessions", icon: <List size={17} /> },
  tasks: { label: "Tasks", icon: <ClipboardList size={17} /> },
  "pull-requests": {
    label: "Pull Requests",
    icon: <GitPullRequest size={17} />,
  },
  projects: { label: "Projects", icon: <FolderKanban size={17} /> },
  knowledge: { label: "Knowledge", icon: <BookOpen size={17} /> },
  schedules: { label: "Schedules", icon: <CalendarClock size={17} /> },
  settings: { label: "Settings", icon: <Settings size={17} /> },
  usage: { label: "Usage", icon: <Gauge size={17} /> },
  "background-tasks": {
    label: "Background",
    icon: <Activity size={17} />,
  },
};
