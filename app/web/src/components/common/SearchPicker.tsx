import { useState, type ReactElement, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

export interface SearchPickerItem {
  id: string;
  /** What the search box matches: the label plus any key or id. */
  search: string;
  icon: ReactNode;
  label: ReactNode;
  /** Quiet text at the row's end, like a project key. */
  detail?: ReactNode;
  current?: boolean;
}

/**
 * @component SearchPicker
 * @purpose Pick one of a list from a popover with a search box: icon, label,
 * a quiet detail and a check on the current one per row.
 * @useWhen A trigger (a property value, a header icon) chooses one item: the
 * Tasks and Projects project filters, the worktree panel's worktree.
 * @intent One look for every searchable single pick, so a project filter and a
 * worktree switcher read and work the same. Groups are divided by a gap, the
 * way "All projects" sits apart from the projects.
 */
export function SearchPicker({
  trigger,
  children,
  groups,
  placeholder,
  emptyLabel = "No matches.",
  align = "start",
  onSelect,
}: {
  /** The trigger element (a Button); `children` is drawn inside it. */
  trigger: ReactElement;
  children: ReactNode;
  groups: readonly (readonly SearchPickerItem[])[];
  placeholder: string;
  emptyLabel?: string;
  align?: "start" | "end";
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-0">
        <Command>
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {groups.map((items, index) => (
              <CommandGroup key={index}>
                {items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.search}
                    // The item's own trailing check marks the current one.
                    data-checked={item.current || undefined}
                    aria-current={item.current || undefined}
                    onSelect={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {item.detail ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.detail}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
