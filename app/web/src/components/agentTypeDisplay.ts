import { MessageSquare, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { SessionAgentType } from "@assistant/shared";

/**
 * Per-persona display registry (label, icon, tone, description): the ONE place
 * an agent's identity glyph and color are defined. Shared by the composer's
 * persona picker, the new-session quick-start's agent row, and the Sessions
 * inbox cards, which use the icon INSTEAD of naming the persona in text.
 *
 * It lives in its own module rather than in `Composer.tsx` so the sidebar can
 * render an agent icon without pulling the composer into its chunk.
 */
export const AGENT_TYPE_DISPLAY: Record<
  SessionAgentType,
  {
    label: string;
    Icon: LucideIcon;
    pillColor: string;
    activeColor: string;
    desc: string;
  }
> = {
  assistant: {
    label: "Assistant",
    Icon: MessageSquare,
    pillColor: "text-faint",
    activeColor: "text-accent",
    desc: "General purpose chat and assistance",
  },
  workshop: {
    label: "Workshop",
    Icon: Wrench,
    pillColor: "text-amber-500/80",
    activeColor: "text-amber-500",
    desc: "Edit and modify this app (local dev only)",
  },
  developer: {
    label: "Developer",
    Icon: Terminal,
    pillColor: "text-emerald-500/80",
    activeColor: "text-emerald-500",
    desc: "General coding agent for your projects",
  },
  // The permanent singleton. Never appears in the persona picker
  // (`availableAgentTypes` excludes it), but the current-session label lookup
  // needs an entry when the Personal Assistant singleton is open.
  "personal-assistant": {
    label: "Personal Assistant",
    Icon: MessageSquare,
    pillColor: "text-faint",
    activeColor: "text-accent",
    desc: "Your permanent personal assistant",
  },
  "workflow-coordinator": {
    label: "Workflow coordinator",
    Icon: MessageSquare,
    pillColor: "text-faint",
    activeColor: "text-accent",
    desc: "Constrained workflow planning and post-review decisions",
  },
};
