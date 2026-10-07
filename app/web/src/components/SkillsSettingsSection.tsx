/**
 * The skills library ([Task-531](pa://task/531), `docs/skills.md`): what the
 * server's fresh scan found, and which of those skills the user has turned on.
 *
 * The user authors `DATA_DIR/skills` by hand and owns its Git repository, so
 * the library itself is only reported here. Two lists, and the second one is
 * the point: a folder that cannot be injected is shown WITH its reason rather
 * than dropped, because a silently missing skill is the failure a
 * hand-authored library actually produces. A broken folder has no toggle —
 * there is no valid name to turn on.
 *
 * Opening the section is what asks for the scan (`skills` topic), so the states
 * here are the ordinary five: a first load, a refresh that keeps the rows on
 * screen, an authoritative empty library, and a failed read that adds a note
 * beside whatever was already there.
 *
 * A toggle holds NO state of its own ([Task-613](pa://task/613)): it renders
 * `settings.skills` and asks `useAssistant` to turn one name on or off, so what
 * it shows is only ever what the settings say. A local "on" flipped by the
 * click would claim a skill is enabled before anything was written, and a save
 * that failed would leave that claim standing over settings that never changed.
 *
 * It also does not BUILD the replacement map. The section is replaced whole, so
 * the next write has to start from the one last sent while a save is still in
 * flight — state this surface deliberately cannot see — and that map belongs to
 * `useAssistant` with the rest of the protocol state.
 *
 * Opening a row reads that skill's `SKILL.md` ([Task-614](pa://task/614)). The
 * body is NOT in the list — it is fetched per selection over
 * `/api/skills/detail` and keyed by the selected NAME through `useFetchState`,
 * which is what makes the important guarantee structural rather than
 * remembered: switching rows drops the previous answer during render, so one
 * skill's instructions can never be read under another skill's name. The
 * library is hand-authored, so a fresh scan can also disagree with what is on
 * screen; a rescan therefore re-reads the open skill in place rather than
 * leaving a body that no longer matches the file an agent would be given.
 */
import {
  Download,
  ExternalLink,
  File,
  FileText,
  Folder,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isSkillEnabled,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_FILE_PREVIEW_BYTES,
  MAX_SKILL_TREE_DEPTH,
  MAX_SKILL_TREE_ENTRIES,
  MAX_SKILL_TREE_METADATA_BYTES,
  type AppSettings,
  type SkillDetail,
  type SkillDetailResponse,
  type SkillDiagnostic,
  type SkillFilePreviewResponse,
  type SkillFileTreeEntry,
  type SkillLibraryList,
  type SkillSummary,
  type SkillToggles,
} from "@assistant/shared";
import { useFetchState } from "../hooks/useFetchState.ts";
import type { LoadState } from "../lib/loadState.ts";
import { dataOf, errorOf, isInitialLoad, isPending } from "../lib/loadState.ts";
import {
  fetchSkillDetail,
  fetchSkillFilePreview,
  skillFileUrl,
} from "../lib/skillsApi.ts";
import { Markdown } from "./Markdown.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Field, FieldTitle } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { IconButton } from "./common/IconButton.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { CodeBlock } from "./common/CodeBlock.tsx";
import { Tree, type TreeNode } from "./common/Tree.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
} from "./common/load.tsx";

export function SkillsSettingsSection({
  library,
  settings,
  onToggleSkill,
}: {
  library: LoadState<SkillLibraryList>;
  settings: AppSettings;
  onToggleSkill: (name: string, on: boolean) => void;
}) {
  const list = dataOf(library);
  const error = errorOf(library);
  const refreshing = isPending(library) && list !== undefined;
  const toggles = settings.skills;

  const [selected, setSelected] = useState<string | null>(null);
  const detail = useFetchState<SkillDetailResponse>(selected, fetchSkillDetail);
  const { reload } = detail;

  // A rescan is authoritative over the open body too. Reloading the SAME key
  // keeps it on screen while it refetches (R2); a selection made in the same
  // pass is already loading its own answer, so only a NEW list reloads.
  const lastList = useRef(list);
  useEffect(() => {
    if (lastList.current === list) return;
    lastList.current = list;
    reload();
  }, [list, reload]);

  const select = useCallback((name: string) => {
    setSelected((current) => (current === name ? null : name));
  }, []);
  const close = useCallback(() => setSelected(null), []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">Skills</h2>
        {refreshing ? <RefreshIndicator label="Rescanning skills" /> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Reusable agent skills you write yourself. Each skill is a folder with a{" "}
        <code>SKILL.md</code> whose frontmatter declares a name and a
        description. The library is read here and never written: you own the
        files and their Git history.
      </p>
      {list ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Library folder: <code>{list.libraryPath}</code>
        </p>
      ) : null}

      {error ? <ErrorNote className="mt-4" message={error} /> : null}

      {isInitialLoad(library) ? (
        <PaneLoading className="mt-6" label="Scanning the skills library…" />
      ) : null}

      {list ? (
        <SkillList
          list={list}
          toggles={toggles}
          onToggle={onToggleSkill}
          selected={selected}
          onSelect={select}
        />
      ) : null}

      {selected !== null ? (
        <SkillDetailPane
          key={selected}
          name={selected}
          state={detail.state}
          onReload={reload}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function SkillList({
  list,
  toggles,
  onToggle,
  selected,
  onSelect,
}: {
  list: SkillLibraryList;
  toggles: SkillToggles;
  onToggle: (name: string, on: boolean) => void;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const empty = list.skills.length === 0 && list.diagnostics.length === 0;
  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Available skills</CardTitle>
          <CardDescription>
            A skill you turn on here is on everywhere; a new skill starts off
            until you say otherwise. Per-project and per-session choices come
            later, as does handing the enabled skills to a running agent. Select
            a skill to read its <code>SKILL.md</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyBox>
              No skills yet. Add a folder with a <code>SKILL.md</code> inside
              the library folder above.
            </EmptyBox>
          ) : list.skills.length === 0 ? (
            <EmptyBox>
              No usable skills. Every folder in the library has a problem listed
              below.
            </EmptyBox>
          ) : (
            <ItemGroup className="gap-2">
              {list.skills.map((skill) => (
                <SkillRow
                  key={skill.path}
                  skill={skill}
                  on={isSkillEnabled(toggles, skill.name)}
                  onToggle={onToggle}
                  open={selected === skill.name}
                  onSelect={onSelect}
                />
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      {list.diagnostics.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Folders that need a fix</CardTitle>
            <CardDescription>
              These folders cannot be used as skills. They stay listed here so a
              typo does not simply make a skill disappear.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ItemGroup className="gap-2">
              {list.diagnostics.map((diagnostic) => (
                <DiagnosticRow
                  key={`${diagnostic.path}:${diagnostic.code}`}
                  diagnostic={diagnostic}
                />
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/**
 * One available skill. The metadata is a BUTTON that opens the body: a whole
 * clickable row would nest the toggle inside a control, and the toggle is a
 * different decision from reading the instructions.
 */
function SkillRow({
  skill,
  on,
  onToggle,
  open,
  onSelect,
}: {
  skill: SkillSummary;
  on: boolean;
  onToggle: (name: string, on: boolean) => void;
  open: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <div role="listitem" className="flex items-center gap-3">
      <Item
        variant={open ? "muted" : "outline"}
        className="min-w-0 flex-1"
        render={
          <button
            type="button"
            onClick={() => onSelect(skill.name)}
            aria-expanded={open}
            aria-controls="skill-detail"
          />
        }
      >
        <ItemContent className="min-w-0">
          <ItemTitle>
            <span className="truncate">{skill.name}</span>
          </ItemTitle>
          <ItemDescription>{skill.description}</ItemDescription>
          <ItemDescription>
            <code>{skill.path}</code>
          </ItemDescription>
        </ItemContent>
      </Item>
      <Field orientation="horizontal" className="w-auto">
        <Switch
          checked={on}
          onCheckedChange={(checked) => onToggle(skill.name, checked)}
          aria-label={`Enable skill ${skill.name}`}
        />
        <FieldTitle>On</FieldTitle>
      </Field>
    </div>
  );
}

/**
 * The open skill's `SKILL.md`.
 *
 * The heading is the name that was ASKED for, and the body may only ever be the
 * answer to that ask: `useFetchState` drops the previous skill's document when
 * the key changes, so a slow read shows this skill's placeholder rather than the
 * last one's instructions. A read that failed keeps nothing under the new name
 * either — the error stands alone, because the last good body belonged to
 * another skill.
 *
 * An `invalid` answer is not an error state: the library moved (the folder was
 * renamed, broken, or its name became ambiguous) and the reason is the content.
 */
function SkillDetailPane({
  name,
  state,
  onReload,
  onClose,
}: {
  name: string;
  state: LoadState<SkillDetailResponse>;
  onReload: () => void;
  onClose: () => void;
}) {
  const detail = dataOf(state);
  const error = errorOf(state);
  const rereading = isPending(state) && detail !== undefined;
  const [selectedPath, setSelectedPath] = useState("SKILL.md");

  return (
    <Card id="skill-detail" className="mt-4">
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        {/* The source path comes from the answer: a skill's folder need not
            be named after it, so there is nothing honest to show before. */}
        {detail?.path ? (
          <CardDescription>
            <code>{detail.path}</code>
          </CardDescription>
        ) : null}
        <CardAction className="flex items-center gap-1">
          {rereading ? <RefreshIndicator label="Rereading SKILL.md" /> : null}
          <IconButton label={`Reread ${name}`} onClick={onReload}>
            <RefreshCw />
          </IconButton>
          <IconButton label={`Close ${name}`} onClick={onClose}>
            <X />
          </IconButton>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? <ErrorNote message={error} /> : null}

        {isInitialLoad(state) ? (
          <PaneLoading label={`Reading ${name}/SKILL.md…`} />
        ) : null}

        {detail?.kind === "invalid" ? (
          <SkillNote>{detail.error}</SkillNote>
        ) : null}

        {detail?.kind === "skill" ? (
          <>
            <p className="text-sm text-muted-foreground">
              {detail.description}
            </p>
            <SkillFileBrowser
              detail={detail}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface SkillBrowserNode {
  entry: SkillFileTreeEntry;
}

function SkillFileBrowser({
  detail,
  selectedPath,
  onSelectPath,
}: {
  detail: SkillDetail;
  selectedPath: string;
  onSelectPath: (path: string) => void;
}) {
  const nodes = useMemo(() => skillTreeNodes(detail.files.entries), [detail]);
  const selectedEntry = findSkillFile(detail.files.entries, selectedPath);
  const expanded = useMemo(
    () =>
      detail.files.entries
        .filter((entry) => entry.type === "directory")
        .map((entry) => entry.path),
    [detail],
  );

  return (
    <div className="mt-3 overflow-hidden rounded-lg border">
      <div className="border-b p-3">
        <div className="text-sm font-medium">Files</div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          {detail.files.entryCount}{" "}
          {detail.files.entryCount === 1 ? "entry" : "entries"}
          {detail.files.truncated ? ", bounded listing" : ""}
        </div>
        {detail.files.truncated ? (
          <SkillNote>{skillTreeLimitDiagnostic(detail.files.limits)}</SkillNote>
        ) : null}
        {detail.files.diagnostics.map((diagnostic) => (
          <SkillNote key={diagnostic}>{diagnostic}</SkillNote>
        ))}
      </div>
      {nodes.length === 0 ? (
        <EmptyBox className="m-3">No files could be listed.</EmptyBox>
      ) : (
        <Tree
          items={nodes}
          defaultExpandedIds={expanded}
          selectedIds={[selectedPath]}
          onSelectionChange={(ids) => {
            const path = ids.at(-1);
            if (!path) return;
            const entry = findSkillFile(detail.files.entries, path);
            if (entry?.type === "file") onSelectPath(path);
          }}
          compact
          showGuides
          aria-label={`${detail.name} files`}
          className="max-h-64 overflow-y-auto p-1"
          getRowClassName={(node) =>
            node.data.entry.type === "symlink" ? "text-muted-foreground" : ""
          }
          renderNode={(node) => <SkillFileTreeRow entry={node.data.entry} />}
        />
      )}
      <SkillFileViewer
        detail={detail}
        entry={selectedEntry}
        path={selectedPath}
      />
    </div>
  );
}

function SkillFileTreeRow({ entry }: { entry: SkillFileTreeEntry }) {
  const Icon =
    entry.type === "directory"
      ? Folder
      : entry.type === "symlink"
        ? ExternalLink
        : File;
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
      {entry.type === "file" && entry.bytes !== undefined ? (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {formatBytes(entry.bytes)}
        </span>
      ) : null}
    </div>
  );
}

function SkillFileViewer({
  detail,
  entry,
  path,
}: {
  detail: SkillDetail;
  entry: SkillFileTreeEntry | undefined;
  path: string;
}) {
  if (!entry || entry.type !== "file") {
    return (
      <div className="border-t p-3">
        <EmptyBox>
          This file is no longer present in the bounded listing.
        </EmptyBox>
      </div>
    );
  }
  const rawUrl = skillFileUrl(detail.name, path);
  const image = entry.mimeType?.startsWith("image/") === true;
  const textLike = isTextMimeType(entry.mimeType);

  return (
    <div className="border-t">
      <PageHeader
        density="compact"
        icon={<FileText size={15} />}
        title={entry.name}
        subtitle={path}
        objectOverflow={false}
        actions={
          <div className="flex items-center gap-1">
            <LinkButton
              label={`Open raw ${path}`}
              variant="ghost"
              size="icon-sm"
              href={rawUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink />
            </LinkButton>
            <LinkButton
              label={`Download ${path}`}
              variant="ghost"
              size="icon-sm"
              href={rawUrl}
              download={entry.name}
            >
              <Download />
            </LinkButton>
          </div>
        }
      />
      {path === "SKILL.md" ? (
        <SkillMarkdown detail={detail} />
      ) : image ? (
        <div className="flex min-h-48 items-center justify-center p-4">
          <img
            src={rawUrl}
            alt={entry.name}
            className="max-h-96 max-w-full rounded-lg border object-contain"
          />
        </div>
      ) : textLike ? (
        <SkillTextFile name={detail.name} entry={entry} />
      ) : (
        <UnsupportedSkillFile entry={entry} rawUrl={rawUrl} />
      )}
    </div>
  );
}

function SkillMarkdown({ detail }: { detail: SkillDetail }) {
  return (
    <div className="p-3">
      {detail.truncated ? (
        <div className="mb-3 text-sm text-muted-foreground">
          Showing the first {formatBytes(MAX_SKILL_BODY_BYTES)} of this{" "}
          {formatBytes(detail.bytes)} file. Open it raw to read the rest.
        </div>
      ) : null}
      {detail.markdown ? (
        <Markdown text={detail.markdown} />
      ) : (
        <EmptyBox>
          This <code>SKILL.md</code> has nothing below its frontmatter.
        </EmptyBox>
      )}
    </div>
  );
}

function SkillTextFile({
  name,
  entry,
}: {
  name: string;
  entry: SkillFileTreeEntry;
}) {
  const key = `${name}\0${entry.path}`;
  const { state, reload } = useFetchState<SkillFilePreviewResponse>(
    key,
    fetchSkillFilePreview,
  );
  const lastEntry = useRef(entry);
  useEffect(() => {
    const previous = lastEntry.current;
    lastEntry.current = entry;
    // A different path already changes the fetch key and starts its first
    // request. Only reload when the same path was rebuilt by a rescan.
    if (previous.path !== entry.path || previous === entry) return;
    reload();
  }, [entry, reload]);
  const preview = dataOf(state);
  const error = errorOf(state);

  if (isInitialLoad(state)) {
    return <PaneLoading className="m-3" label={`Loading ${entry.path}…`} />;
  }
  if (!preview) {
    return (
      <ErrorNote
        className="m-3"
        message={error ?? "File not loaded."}
        onRetry={reload}
      />
    );
  }
  if (preview.kind === "binary") {
    return (
      <UnsupportedSkillFile
        entry={entry}
        rawUrl={skillFileUrl(name, entry.path)}
      />
    );
  }
  const markdown = preview.mimeType.startsWith("text/markdown");
  return (
    <div className="space-y-3 p-3">
      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {preview.truncated ? (
        <div className="text-sm text-muted-foreground">
          Showing the first {formatBytes(MAX_SKILL_FILE_PREVIEW_BYTES)} of this{" "}
          {formatBytes(preview.bytes)} file.
        </div>
      ) : null}
      {markdown ? (
        preview.text ? (
          <Markdown text={preview.text} />
        ) : (
          <EmptyBox>This file is empty.</EmptyBox>
        )
      ) : (
        <CodeBlock
          code={preview.text}
          filename={entry.name}
          showLineNumbers
          collapsedLines={Number.MAX_SAFE_INTEGER}
        />
      )}
    </div>
  );
}

function UnsupportedSkillFile({
  entry,
  rawUrl,
}: {
  entry: SkillFileTreeEntry;
  rawUrl: string;
}) {
  return (
    <EmptyBox
      className="m-3"
      action={
        <LinkButton variant="default" href={rawUrl} download={entry.name}>
          <Download /> Download
        </LinkButton>
      }
    >
      This file type cannot be previewed safely. Open it raw or download it.
    </EmptyBox>
  );
}

function skillTreeNodes(
  entries: SkillFileTreeEntry[],
): TreeNode<SkillBrowserNode>[] {
  return entries.map((entry) => ({
    id: entry.path,
    data: { entry },
    ...(entry.children ? { children: skillTreeNodes(entry.children) } : {}),
  }));
}

function findSkillFile(
  entries: SkillFileTreeEntry[],
  path: string,
): SkillFileTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const nested = entry.children && findSkillFile(entry.children, path);
    if (nested) return nested;
  }
  return undefined;
}

function skillTreeLimitDiagnostic(
  limits: SkillDetail["files"]["limits"],
): string {
  const labels = limits.map((limit) => {
    switch (limit) {
      case "entries":
        return `${MAX_SKILL_TREE_ENTRIES.toLocaleString()} entries`;
      case "depth":
        return `${MAX_SKILL_TREE_DEPTH} levels`;
      case "metadata-bytes":
        return `${formatBytes(MAX_SKILL_TREE_METADATA_BYTES)} of path metadata`;
    }
    return limit;
  });
  return `The file tree was truncated at ${labels.join(", ")}.`;
}

function isTextMimeType(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType?.startsWith("text/") ||
    mimeType?.startsWith("application/json") ||
    mimeType?.startsWith("application/x-ndjson"),
  );
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function DiagnosticRow({ diagnostic }: { diagnostic: SkillDiagnostic }) {
  return (
    <Item variant="outline" role="listitem" className="items-start">
      <ItemMedia variant="icon">
        <TriangleAlert />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          <span className="truncate">{diagnostic.folder}</span>
        </ItemTitle>
        <ItemDescription>{diagnostic.error}</ItemDescription>
        <ItemDescription>
          <code>{diagnostic.path}</code>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** A non-failure notice about the open skill: the reason IS the content. */
function SkillNote({ children }: { children: ReactNode }) {
  return (
    <Alert variant="warning" role="note" className="mt-2">
      <TriangleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
