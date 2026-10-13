/**
 * @widget ProposalText
 * @purpose The reading surface every approval card shares for the prose it
 *   proposes (a ticket, a pull-request description, a comment, release notes):
 *   Markdown rendered as the target will show it, clipped to a card-sized
 *   preview, and a "Read full" dialog carrying the card's own Approve/Reject.
 *   An edit whose card recorded the text it replaces adds a Changes tab: the
 *   whole document with the edit marked, against that text as it was when the
 *   agent proposed the edit.
 * @payload Markdown strings from an `ApprovalCard.body`.
 * @useWhen An approval body renders proposed Markdown.
 */
import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, FileDiff, Maximize2, XCircle } from "lucide-react";
import type { ApprovalDecision } from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { PaneLoading } from "./common/load.tsx";
import { loadPrefs, type Prefs } from "../hooks/usePrefs.ts";
import { hashContent } from "../lib/worktrees.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DiffSurface = lazy(() =>
  import("./diff/DiffSurface.tsx").then((module) => ({
    default: module.DiffSurface,
  })),
);

/** Decision buttons offered while the card is pending; absent once it is not. */
export type ProposalDecide = ((decision: ApprovalDecision) => void) | undefined;

/**
 * Markdown clipped to a card-sized window. The fade only paints when there IS
 * more below the fold — a three-line description does not need to look cut.
 * Height is observed rather than measured once: a late image or lazily
 * highlighted code block grows the content after mount.
 */
export function ClippedMarkdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className="relative w-full">
      <div
        ref={ref}
        className="max-h-48 min-w-0 overflow-hidden text-foreground"
      >
        <Markdown text={text} density="compact" />
      </div>
      {clipped ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
      ) : null}
    </div>
  );
}

export function ReadFullButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Maximize2 />
      {label}
    </Button>
  );
}

export function DialogSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-4">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

/**
 * The full proposal at reading size. A dialog rather than the document viewer:
 * the text is not a file anywhere yet, it exists only on this card until the
 * target accepts it. The decision buttons are the card's, so approving from
 * here is the same act as approving on the card.
 */
export function ProposalDialog({
  title,
  open,
  onOpenChange,
  onDecide,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecide: ProposalDecide;
  children: ReactNode;
}) {
  const decide = (decision: ApprovalDecision) => {
    onDecide?.(decision);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={title}
        className="flex max-h-11/12 flex-col sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {children}
        </div>
        <DialogFooter>
          {onDecide ? (
            <>
              <Button variant="outline" onClick={() => decide("rejected")}>
                <XCircle />
                Reject
              </Button>
              <Button onClick={() => decide("approved")}>
                <CheckCircle2 />
                Approve
              </Button>
            </>
          ) : (
            <DialogClose render={<Button variant="outline" />}>
              Close
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ProposalTab = "preview" | "changes";

/**
 * Proposed Markdown on a card: the clipped rendering, and a dialog with the
 * whole of it. `previous` is the text an edit replaces, when the card recorded
 * it; with it the dialog also shows the change, and the card offers that view
 * directly. `empty` is how an empty `text` reads — clearing a description is
 * still a write — for a card that can propose one. `context` leads the dialog:
 * what the card says beside the text that approving from the dialog must not
 * hide, such as a warning about what the write destroys.
 */
export function ProposedMarkdown({
  text,
  previous,
  title,
  readLabel,
  empty = "No text.",
  context,
  onDecide,
}: {
  text: string;
  previous?: string | undefined;
  title: string;
  readLabel: string;
  empty?: string;
  context?: ReactNode;
  onDecide: ProposalDecide;
}) {
  const [open, setOpen] = useState<ProposalTab | null>(null);
  const changed = previous !== undefined && previous !== text;
  return (
    <div className="flex w-full flex-col items-start gap-2">
      {text ? (
        <ClippedMarkdown text={text} />
      ) : (
        <p className="text-muted-foreground">{empty}</p>
      )}
      {previous !== undefined && !changed ? (
        <p className="text-muted-foreground">Same as the current text.</p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {text ? (
          <ReadFullButton
            label={readLabel}
            onClick={() => setOpen("preview")}
          />
        ) : null}
        {changed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen("changes")}
          >
            <FileDiff />
            Show changes
          </Button>
        ) : null}
      </div>
      <ProposalDialog
        open={open !== null}
        title={title}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        onDecide={onDecide}
      >
        {context ? (
          <div className="mb-3 flex flex-col gap-2">{context}</div>
        ) : null}
        {changed && previous !== undefined ? (
          <Tabs
            value={open ?? "preview"}
            onValueChange={(value) => setOpen(value as ProposalTab)}
            className="min-h-0 flex-1"
          >
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="changes">Changes</TabsTrigger>
            </TabsList>
            <TabsContent value="preview">
              {text ? (
                <Markdown text={text} />
              ) : (
                <p className="text-muted-foreground">{empty}</p>
              )}
            </TabsContent>
            <TabsContent value="changes" className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Against the text when the agent proposed this.
              </p>
              <ProposedChanges previous={previous} text={text} />
            </TabsContent>
          </Tabs>
        ) : (
          <Markdown text={text} />
        )}
      </ProposalDialog>
    </div>
  );
}

/**
 * The edit as a diff of the Markdown source. The reader's own diff settings
 * apply except the three prose needs: one column, wrapped lines, and the whole
 * document rather than hunks, so the change reads in its context.
 */
function ProposedChanges({
  previous,
  text,
}: {
  previous: string;
  text: string;
}) {
  const prefs = useMemo<Prefs>(
    () => ({
      ...loadPrefs(),
      diffStyle: "unified",
      diffWrap: true,
      diffExpandContext: true,
    }),
    [],
  );
  // Both sides end in a newline so a last line edited reads as that edit, not
  // as an extra "no newline at end of file" change.
  const terminated = (value: string) =>
    value === "" || value.endsWith("\n") ? value : `${value}\n`;
  return (
    <Suspense fallback={<PaneLoading label="Loading changes…" />}>
      <div className="min-h-0 overflow-hidden rounded-lg border">
        <DiffSurface
          prefs={prefs}
          oldFile={{ name: "description.md", contents: terminated(previous) }}
          newFile={{ name: "description.md", contents: terminated(text) }}
          cacheKey={`proposal:${hashContent(previous, "\0", text)}`}
        />
      </div>
    </Suspense>
  );
}
