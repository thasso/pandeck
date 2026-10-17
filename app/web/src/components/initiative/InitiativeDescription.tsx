import { useCallback } from "react";
import { ChevronRight } from "lucide-react";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { Markdown } from "../Markdown.tsx";
import { useMentionedPaObjectReferences } from "../PaObjectLinks.tsx";

// Shared, so a render without a link source hands Markdown the same array.
const NO_REFERENCES: PaObjectLinkResolution[] = [];

/**
 * @component InitiativeDescription
 * @purpose The Initiative's own Markdown description, as a band under the
 *   page's toolbar that both the Map and the List show.
 * @useWhen The Initiative page, once its read carries a description.
 * @intent The band folds to its heading so a long description never costs the
 *   map its room, and open it scrolls inside a bounded height. A `pa://` Task
 *   link opens that Task in the object panel, as selecting a node does; any
 *   other link opens where the app opens it.
 */
export function InitiativeDescription({
  text,
  open,
  onOpenChange,
  onSelectTask,
}: {
  text: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const linked = useMentionedPaObjectReferences(text);
  const openLink = linked.onOpen;
  const onOpenPaObject = useCallback(
    (link: PaObjectLinkResolution) => {
      if (link.objectType === "task") onSelectTask(link.id);
      else openLink?.(link);
    },
    [onSelectTask, openLink],
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<section aria-label="Description" />}
      className="border-b border-border"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          size={12}
          aria-hidden
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        Description
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-48 overflow-y-auto px-4 pb-3">
        <div className="max-w-prose">
          <Markdown
            text={text}
            density="compact"
            paObjectReferences={linked.references ?? NO_REFERENCES}
            onOpenPaObject={onOpenPaObject}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
