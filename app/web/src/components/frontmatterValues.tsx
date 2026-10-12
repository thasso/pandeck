import type { ReactNode } from "react";
import {
  Archive,
  BookOpen,
  Bot,
  CalendarDays,
  CircleCheck,
  CircleDashed,
  Download,
  FileText,
  FolderKanban,
  ListChecks,
  Mail,
  MessageSquare,
  PenLine,
  StickyNote,
  Ticket,
  Users,
  Workflow,
} from "lucide-react";

/** A known frontmatter value: its glyph and the word a reader uses for it. */
interface KnownValue {
  icon: ReactNode;
  label: string;
}

const ICON = "size-3.5 shrink-0";

/**
 * The vocabularies the Knowledge Base writes (`status`, `type`, `source.kind`).
 * Nothing enforces them, so a value not listed here still shows, as its words.
 */
const KNOWN_VALUES: Record<string, Record<string, KnownValue>> = {
  status: {
    active: {
      icon: <CircleCheck className={`${ICON} text-success`} />,
      label: "Active",
    },
    draft: {
      icon: <CircleDashed className={`${ICON} text-muted-foreground`} />,
      label: "Draft",
    },
    archived: {
      icon: <Archive className={`${ICON} text-muted-foreground`} />,
      label: "Archived",
    },
  },
  type: {
    reference: { icon: <BookOpen className={ICON} />, label: "Reference" },
    note: { icon: <StickyNote className={ICON} />, label: "Note" },
    brief: { icon: <FileText className={ICON} />, label: "Brief" },
    plan: { icon: <ListChecks className={ICON} />, label: "Plan" },
    "daily-summary": {
      icon: <CalendarDays className={ICON} />,
      label: "Daily summary",
    },
    workflow: { icon: <Workflow className={ICON} />, label: "Workflow" },
  },
  kind: {
    agent: { icon: <Bot className={ICON} />, label: "Agent" },
    project: { icon: <FolderKanban className={ICON} />, label: "Project" },
    slack: { icon: <MessageSquare className={ICON} />, label: "Slack" },
    import: { icon: <Download className={ICON} />, label: "Import" },
    manual: { icon: <PenLine className={ICON} />, label: "Manual" },
    email: { icon: <Mail className={ICON} />, label: "Email" },
    meeting: { icon: <Users className={ICON} />, label: "Meeting" },
    jira: { icon: <Ticket className={ICON} />, label: "Jira" },
  },
};

/** Whether `key` is a field whose values have a known vocabulary. */
export function isVocabularyField(key: string): boolean {
  return key in KNOWN_VALUES;
}

/** `daily-summary` → "Daily summary". */
function words(value: string): string {
  const text = value.replace(/[-_]+/g, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : value;
}

/**
 * A vocabulary value as a reader sees it: its icon and word when the KB's
 * vocabulary knows it, else the value as words.
 */
export function FrontmatterValue({
  field,
  value,
}: {
  field: string;
  value: string;
}) {
  const known = KNOWN_VALUES[field]?.[value.trim().toLowerCase()];
  return (
    <span className="inline-flex items-center gap-1.5" title={value}>
      {known?.icon}
      {known?.label ?? words(value)}
    </span>
  );
}
