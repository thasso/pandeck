import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  Tickets,
  X,
} from "lucide-react";
import type {
  TaskTicket,
  TicketSearchResponse,
  TicketSearchResult,
} from "@assistant/shared";
import { parseGithubIssueRef } from "@assistant/shared";
import { fetchGithubLinkedIssues } from "../lib/githubApi.ts";
import { fetchJiraLinkedIssues } from "../lib/jiraApi.ts";
import { searchTickets } from "../lib/ticketApi.ts";
import { IconButton } from "./common/IconButton.tsx";
import { ErrorNote, Spinner } from "./common/load.tsx";
import {
  beginLoad,
  dataOf,
  errorOf,
  failed,
  loading,
  ready,
  type LoadState,
} from "../lib/loadState.ts";
import { Button } from "./ui/button.tsx";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { PROPERTY_TRIGGER } from "./common/PropertyList.tsx";

/**
 * Where a ticket lives without asking its tracker: a GitHub issue's page, or a
 * Jira issue on the configured host.
 */
export function ticketFallbackUrl(
  ticket: TaskTicket,
  jiraHost?: string,
): string | undefined {
  if (ticket.source === "jira") {
    const host = jiraHost?.trim();
    if (!host) return undefined;
    const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    return `${base.replace(/\/$/, "")}/browse/${encodeURIComponent(ticket.ref)}`;
  }
  const parts = parseGithubIssueRef(ticket.ref);
  // `/issues/<n>` redirects to `/pull/<n>` when the number is a pull request.
  return parts
    ? `https://github.com/${parts.owner}/${parts.repo}/issues/${parts.number}`
    : undefined;
}

/** How long typing pauses before the search goes out. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * @component TaskTicketProperty
 * @purpose The Task's ticket as one property row in the inspector's Details:
 * the key and its title, a quiet link out, and a search popover over Jira and
 * GitHub to set, change or remove it.
 * @useWhen The Task inspector's Details list.
 * @intent One ticket per Task, picked rather than typed: the search is scoped
 * to the Task's Project (its Jira projects, its repository) and falls back to
 * the user's own work; an exact key, ref or pasted link resolves to itself.
 * Picking replaces whatever was linked.
 */
export function TaskTicketProperty({
  ticket,
  fallbackUrl,
  jiraProjects,
  repos,
  onChange,
}: {
  ticket: TaskTicket | null;
  /** Where the ticket lives when the lookup has not answered (or cannot). */
  fallbackUrl?: string | undefined;
  jiraProjects: string[];
  repos: string[];
  onChange: (ticket: TaskTicket | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const details = useTicketDetails(ticket);
  const url = details?.url ?? fallbackUrl;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-0.5">
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={ticket ? `Change ticket ${ticket.ref}` : "Set ticket"}
              className={`${PROPERTY_TRIGGER} min-w-0 flex-1 justify-start`}
            />
          }
        >
          {ticket ? (
            <>
              <TicketIcon source={ticket.source} details={details} />
              <span className="min-w-0 truncate">
                <span className="font-mono text-xs">{ticket.ref}</span>
                {details?.title ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {details.title}
                  </span>
                ) : null}
              </span>
            </>
          ) : (
            <>
              <Tickets className="text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">None</span>
            </>
          )}
        </PopoverTrigger>
        {ticket && url ? (
          <IconButton
            label={`Open ${ticket.ref}`}
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            <ArrowUpRight />
          </IconButton>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-80 p-0">
        {open ? (
          <TicketSearch
            current={ticket}
            jiraProjects={jiraProjects}
            repos={repos}
            onPick={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The popover's body: mounted per opening, so each one starts fresh. */
function TicketSearch({
  current,
  jiraProjects,
  repos,
  onPick,
}: {
  current: TaskTicket | null;
  jiraProjects: string[];
  repos: string[];
  onPick: (ticket: TaskTicket | null) => void;
}) {
  const [query, setQuery] = useState("");
  // A new query keeps the last results on screen while it runs (`refreshing`);
  // a failure drops them, since they answered another query.
  const [state, setState] = useState<LoadState<TicketSearchResponse>>(
    loading<TicketSearchResponse>,
  );
  // Strings, not the arrays: their identity changes on every render.
  const jiraScope = jiraProjects.join(",");
  const repoScope = repos.join(",");
  useEffect(() => {
    const controller = new AbortController();
    setState(beginLoad);
    const timer = window.setTimeout(() => {
      searchTickets(
        {
          q: query,
          jiraProjects: jiraScope ? jiraScope.split(",") : [],
          repos: repoScope ? repoScope.split(",") : [],
        },
        controller.signal,
      )
        .then((data) => setState(ready(data)))
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          setState(
            failed(error instanceof Error ? error.message : String(error)),
          );
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, jiraScope, repoScope]);

  const data = dataOf(state);
  const error = errorOf(state);
  const results = data?.results ?? [];
  const jira = results.filter((result) => result.source === "jira");
  const github = results.filter((result) => result.source === "github");
  const row = (result: TicketSearchResult) => (
    <CommandItem
      key={`${result.source}:${result.ref}`}
      value={`${result.source}:${result.ref}`}
      onSelect={() => onPick({ source: result.source, ref: result.ref })}
    >
      <TicketIcon source={result.source} details={result} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-xs">{result.ref}</span> {result.title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {result.status}
      </span>
    </CommandItem>
  );
  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search Jira and GitHub, or paste a link…"
      />
      <CommandList>
        {state.status === "loading" ? (
          <div
            role="status"
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          >
            <Spinner size="sm" />
            Searching…
          </div>
        ) : null}
        {error ? (
          <div className="p-2">
            <ErrorNote message={error} />
          </div>
        ) : null}
        {data && results.length === 0 && state.status === "ready" ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No tickets found.
          </p>
        ) : null}
        {jira.length ? (
          <CommandGroup heading="Jira">{jira.map(row)}</CommandGroup>
        ) : null}
        {github.length ? (
          <CommandGroup heading="GitHub">{github.map(row)}</CommandGroup>
        ) : null}
        {data?.errors.map((error) => (
          <p
            key={error.source}
            className="px-3 py-1.5 text-xs text-muted-foreground"
          >
            {error.source === "jira" ? "Jira" : "GitHub"} search failed:{" "}
            {error.message}
          </p>
        ))}
        {current ? (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="remove-ticket" onSelect={() => onPick(null)}>
                <X aria-hidden />
                Remove ticket
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </Command>
  );
}

interface TicketDetails {
  title: string;
  url: string;
  status: string;
  isPullRequest?: boolean | undefined;
}

/** The linked ticket's title, status and link, looked up when it changes. */
export function useTicketDetails(
  ticket: TaskTicket | null,
): TicketDetails | null {
  const [details, setDetails] = useState<TicketDetails | null>(null);
  // The ticket's identity as strings: the object is rebuilt per render.
  const source = ticket?.source;
  const ref = ticket?.ref;
  useEffect(() => {
    setDetails(null);
    if (!source || !ref) return;
    const controller = new AbortController();
    const lookup =
      source === "jira"
        ? fetchJiraLinkedIssues([ref], controller.signal).then(({ issues }) =>
            issues[0]
              ? { title: issues[0].summary, url: issues[0].url, status: "" }
              : null,
          )
        : fetchGithubLinkedIssues([ref], controller.signal).then(
            ({ issues }) =>
              issues[0]
                ? {
                    title: issues[0].title,
                    url: issues[0].url,
                    status: issues[0].state,
                    isPullRequest: issues[0].isPullRequest,
                  }
                : null,
          );
    lookup.then(setDetails).catch(() => {
      // The row keeps its bare ref; the link falls back to the stored one.
    });
    return () => controller.abort();
  }, [source, ref]);
  return details;
}

function TicketIcon({
  source,
  details,
}: {
  source: "jira" | "github";
  details: Pick<TicketDetails, "status" | "isPullRequest"> | null | undefined;
}) {
  if (source === "jira")
    return <Tickets className="text-primary" aria-hidden />;
  if (details?.status === "merged")
    return <GitMerge className="text-primary" aria-hidden />;
  if (details?.isPullRequest)
    return (
      <GitPullRequest
        className={
          details.status === "closed" ? "text-muted-foreground" : "text-primary"
        }
        aria-hidden
      />
    );
  if (details?.status === "closed")
    return <CircleCheck className="text-muted-foreground" aria-hidden />;
  return <CircleDot className="text-primary" aria-hidden />;
}
