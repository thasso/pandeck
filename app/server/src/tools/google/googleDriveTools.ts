import { open, statfs, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { defineAgentTool, type ToolCallContext } from "../../mcp/tool.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import {
  formatLocalDateTime,
  localDayRange,
  normalizeRfc3339,
} from "../../googleTime.ts";
import { stageSessionArtifactFile } from "../../mcp/toolGroups/packRuntime.ts";

type DriveUser = {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  exportLinks?: Record<string, string>;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

type DriveFilesPage = {
  nextPageToken?: string;
  files?: DriveFile[];
};

type SearchDriveFilesParams = {
  query?: string;
  name?: string;
  fullText?: string;
  folderId?: string;
  foldersOnly?: boolean;
  mimeType?: string;
  mimeTypes?: string[];
  date?: string;
  createdFrom?: string;
  createdTo?: string;
  modifiedFrom?: string;
  modifiedTo?: string;
  meetingArtifactsOnly?: boolean;
  includeTrashed?: boolean;
  maxResults?: number;
  pageToken?: string;
};

type GetDriveFileParams = {
  fileId: string;
  exportMimeType?: string;
  maxChars?: number;
  render?: boolean;
};

type DownloadDriveFileParams = {
  fileId: string;
  exportMimeType?: string;
  maxDownloadBytes?: number;
  maxFiles?: number;
};

type DriveDownloadPlan = {
  name: string;
  mimeType: string;
  apiPath: string;
  declaredSize: number | null;
};

type DriveContentSink = {
  /** Directory the bytes land in, checked for free space before streaming. */
  directory: string;
  write: (chunk: Uint8Array) => Promise<void>;
  progress?: (bytes: number) => void;
};

type DriveFolderDownloadState = {
  accessToken: () => Promise<string>;
  signal: AbortSignal | undefined;
  maxDownloadBytes: number;
  maxFiles: number;
  sourceBytes: number;
  fileCount: number;
  folderCount: number;
  zip: DriveZipWriter;
  directory: string;
  progress: (bytes: number) => void;
  activeFolderIds: Set<string>;
};

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_DOWNLOAD_BYTES = 1 * GIB;
const MAX_DOWNLOAD_BYTES = 20 * GIB;
// Stored ZIP without ZIP64: every offset must fit in 32 bits. The headroom
// covers local and central headers for the most entries a folder may hold.
const ZIP_MAX_OFFSET = 0xffffffff;
const MAX_FOLDER_DOWNLOAD_BYTES = 4 * GIB - 256 * MIB;
const MIN_FREE_DISK_BYTES = 2 * GIB;
// Re-checked while streaming, for exports and chunked responses of unknown size.
const DISK_CHECK_INTERVAL_BYTES = 64 * MIB;
const PROGRESS_INTERVAL_MS = 5_000;
const MAX_FOLDER_COUNT = 1_000;

const EXPORT_MIME_PREFERENCES: Record<string, string[]> = {
  "application/vnd.google-apps.document": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/pdf",
    "text/plain",
  ],
  "application/vnd.google-apps.spreadsheet": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/pdf",
    "text/csv",
  ],
  "application/vnd.google-apps.presentation": [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/pdf",
  ],
  "application/vnd.google-apps.drawing": [
    "application/pdf",
    "image/png",
    "image/svg+xml",
  ],
  "application/vnd.google-apps.script": [
    "application/vnd.google-apps.script+json",
  ],
  "application/vnd.google-apps.jam": ["application/pdf"],
  "application/vnd.google-apps.vid": ["video/mp4"],
};

const EXPORT_EXTENSION: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/vnd.google-apps.script+json": ".json",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/epub+zip": ".epub",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/html": ".html",
  "text/markdown": ".md",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
};

const driveFileFields =
  "id,name,mimeType,description,webViewLink,webContentLink,iconLink,createdTime,modifiedTime,size,parents,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),exportLinks,shortcutDetails";

const searchDriveFilesParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description:
        "Simple text query matched against Drive file name and full text. Best for titles, meeting names, or distinctive phrases.",
    },
    name: {
      type: "string",
      description: "Substring that must appear in the file name.",
    },
    fullText: {
      type: "string",
      description: "Text that must appear in indexed file content/full text.",
    },
    folderId: {
      type: "string",
      description:
        "Folder id or folder URL whose direct children are listed. Alone it enumerates the whole folder in natural name order; combined with the other filters it searches inside that folder only. Subfolders come back interleaved with files, as entries with the folder MIME type — list one of them to descend. Find a folder id with foldersOnly=true.",
    },
    foldersOnly: {
      type: "boolean",
      description:
        "Return only folders. Use it to locate a folder by name before listing it with folderId. Defaults to false.",
    },
    mimeType: {
      type: "string",
      description:
        "Restrict to one MIME type, e.g. application/vnd.google-apps.document.",
    },
    mimeTypes: {
      type: "array",
      items: { type: "string" },
      description: "Restrict to any of these MIME types.",
    },
    date: {
      type: "string",
      description:
        "User-local YYYY-MM-DD day. Searches files created or modified during that day.",
    },
    createdFrom: {
      type: "string",
      description: "RFC3339 lower bound for createdTime.",
    },
    createdTo: {
      type: "string",
      description: "RFC3339 upper bound for createdTime.",
    },
    modifiedFrom: {
      type: "string",
      description: "RFC3339 lower bound for modifiedTime.",
    },
    modifiedTo: {
      type: "string",
      description: "RFC3339 upper bound for modifiedTime.",
    },
    meetingArtifactsOnly: {
      type: "boolean",
      description:
        "Restrict to likely meeting notes/transcripts/recordings documents. Defaults to false.",
    },
    includeTrashed: {
      type: "boolean",
      description: "Include trashed files. Defaults to false.",
    },
    maxResults: {
      type: "number",
      description: "Maximum files to return. Defaults to 20, maximum 100.",
    },
    pageToken: {
      type: "string",
      description:
        "nextPageToken from a previous call, to continue enumerating with the same filters.",
    },
  },
} as const;

const getDriveFileParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fileId"],
  properties: {
    fileId: {
      type: "string",
      description: "Google Drive file id or file URL to retrieve/export.",
    },
    exportMimeType: {
      type: "string",
      description:
        "Export MIME type for Google Workspace files. Defaults to text/markdown with fallback to text/plain for Google Docs.",
    },
    maxChars: {
      type: "number",
      description:
        "Maximum extracted text characters to return. Defaults to 12000, maximum 100000.",
    },
    render: {
      type: "boolean",
      description:
        "Set true when the user explicitly asks to display/render the document nicely in the UI. The UI then shows a document preview: answer or summarize instead of repeating the full document in prose.",
    },
  },
} as const;

const downloadDriveFileParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fileId"],
  properties: {
    fileId: {
      type: "string",
      description:
        "Google Drive file or folder id, or its URL. Folders are downloaded recursively as a ZIP archive.",
    },
    exportMimeType: {
      type: "string",
      description:
        "Optional export MIME type for one Google Workspace file, e.g. application/pdf. Folder downloads use a conventional editable format for each Workspace file.",
    },
    maxDownloadBytes: {
      type: "number",
      description:
        "Maximum source bytes downloaded. Defaults to 1 GiB, maximum 20 GiB; a folder ZIP holds at most 3.75 GiB, so download larger files individually.",
    },
    maxFiles: {
      type: "number",
      description:
        "Maximum files in a folder download. Defaults to 250, maximum 1000.",
    },
  },
} as const;

export const googleDriveSearchFilesTool =
  defineAgentTool<SearchDriveFilesParams>({
    name: "google_drive_search_files",
    label: "Google Drive: Search Files",
    description:
      "Search read-only Google Drive files, including Google Docs such as Meet notes and transcripts — use it to find documents, meeting minutes, notes, or recordings, and to list what a folder contains via folderId. Results are one page: follow nextPageToken to enumerate the rest. For minutes, prefer a known Calendar attachment first, otherwise search the meeting title with its user-local date and meetingArtifactsOnly=true. Search is index-based, so very new or inaccessible documents can be missing. Retrieve a chosen document with google_drive_get_file before summarizing it, and cite files with markdownLink/webViewLink, never a placeholder like [title](...).",
    parameters: searchDriveFilesParamsSchema,
    async execute(params) {
      const maxResults = clamp(params.maxResults, 20, 1, 100);
      const config = getGoogleToolConfig();
      const accessToken = await ensureGoogleAccessToken(config);
      const folderId = extractDriveId(params.folderId);
      const driveQuery = buildDriveQuery(params);
      const listing = folderId !== null && !hasTextCriteria(params);
      const { files, nextPageToken } = await searchFiles({
        accessToken,
        query: driveQuery,
        maxResults,
        orderBy: listing ? "name_natural" : "modifiedTime desc",
        pageToken: params.pageToken?.trim() || undefined,
      });
      const normalized = files.map(normalizeFileCompact);
      const payload = {
        query: params.query ?? null,
        driveQuery,
        folderId,
        date: params.date ?? null,
        meetingArtifactsOnly: params.meetingArtifactsOnly === true,
        fileCount: normalized.length,
        nextPageToken,
        presentationGuidance:
          "Use webViewLink/markdownLink for user-facing links. To read a document, call google_drive_get_file with its fileId; do not infer contents from the file name alone.",
        files: normalized,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

export const googleDriveGetFileTool = defineAgentTool<GetDriveFileParams>({
  name: "google_drive_get_file",
  label: "Google Drive: Get File",
  description:
    "Retrieve Drive file metadata and export/download readable document text into assistant context. Google Docs export as text/markdown (falling back to text/plain); other files download only when their MIME type is text-like. Use google_drive_download when the user wants the actual file or a folder ZIP. Cite the document with markdownLink/webViewLink, never a placeholder like [title](...).",
  parameters: getDriveFileParamsSchema,
  async execute(params) {
    const fileId = extractDriveId(params.fileId);
    if (!fileId) throw new Error("fileId is required.");
    const maxChars = clamp(params.maxChars, 12_000, 1_000, 100_000);
    const config = getGoogleToolConfig();
    const accessToken = await ensureGoogleAccessToken(config);
    const file = await getFileMetadata(fileId, accessToken);
    if (file.mimeType === GOOGLE_FOLDER_MIME)
      throw new Error(
        `${file.name ?? fileId} is a Drive folder. List its contents with google_drive_search_files folderId="${fileId}", or fetch the whole folder with google_drive_download.`,
      );
    const exported = await exportReadableFile(
      file,
      accessToken,
      params.exportMimeType,
    );
    const text =
      exported.text.length > maxChars
        ? `${exported.text.slice(0, maxChars)}…`
        : exported.text;
    const payload = {
      file: normalizeFile(file),
      exportMimeType: exported.mimeType,
      truncated: exported.text.length > maxChars,
      textCharCount: text.length,
      renderRequested: params.render === true,
      presentationGuidance:
        params.render === true
          ? "The UI will render this Drive document preview. Do not duplicate the full text in prose; summarize or answer the user's question. Use markdownLink/webViewLink for citation when needed."
          : "The text field is available as context. Summarize or answer from it, and cite markdownLink/webViewLink when useful.",
      text,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const googleDriveDownloadTool = defineAgentTool<DownloadDriveFileParams>(
  {
    name: "google_drive_download",
    label: "Google Drive: Download",
    description:
      "Download any Drive file as a session artifact and return a user-facing download link. Binary and text files retain their bytes; Google Workspace files are exported to an editable format by default or to exportMimeType when supplied. A folder is downloaded recursively as a ZIP. localPath is the saved file on this host. Always give the user the returned markdownDownloadLink rather than claiming the file was downloaded without linking it.",
    parameters: downloadDriveFileParamsSchema,
    async execute(params, ctx) {
      const fileId = extractDriveId(params.fileId);
      if (!fileId) throw new Error("fileId is required.");
      const maxDownloadBytes = clamp(
        params.maxDownloadBytes,
        DEFAULT_DOWNLOAD_BYTES,
        1,
        MAX_DOWNLOAD_BYTES,
      );
      const maxFiles = clamp(params.maxFiles, 250, 1, 1_000);
      const config = getGoogleToolConfig();
      // Re-read per request: a multi-GiB folder can outlive one access token.
      const accessToken = () => ensureGoogleAccessToken(config);
      const original = await getFileMetadata(
        fileId,
        await accessToken(),
        ctx.signal,
      );
      const file = await resolveDriveShortcut(
        original,
        await accessToken(),
        ctx.signal,
      );
      const isFolder = file.mimeType === GOOGLE_FOLDER_MIME;
      const plan = isFolder
        ? null
        : driveDownloadPlan(file, params.exportMimeType);
      const name = plan
        ? plan.name
        : withExportExtension(
            cleanDownloadName(file.name ?? "Google Drive folder"),
            "application/zip",
          );
      const progress = downloadProgress(ctx, name);

      let fileCount = 1;
      let folderCount = 0;
      let sourceBytes = 0;
      const { artifact, path } = await stageSessionArtifactFile(
        ctx.session.sessionId,
        {
          name,
          mimeType: plan?.mimeType ?? "application/zip",
          kind: "download",
          label: `Google Drive download: ${name}`,
          sourceTool: "google_drive_download",
          directory: "google-drive",
          download: true,
          write: async (target) => {
            const handle = await open(target, "w");
            try {
              if (plan) {
                let position = 0;
                sourceBytes = await streamDriveContent(
                  plan,
                  await accessToken(),
                  maxDownloadBytes,
                  {
                    directory: dirname(target),
                    write: async (chunk) => {
                      await writeAll(handle, chunk, position);
                      position += chunk.byteLength;
                    },
                    progress,
                  },
                  ctx.signal,
                );
                return;
              }
              const state: DriveFolderDownloadState = {
                accessToken,
                signal: ctx.signal,
                maxDownloadBytes: Math.min(
                  maxDownloadBytes,
                  MAX_FOLDER_DOWNLOAD_BYTES,
                ),
                maxFiles,
                sourceBytes: 0,
                fileCount: 0,
                folderCount: 1,
                zip: new DriveZipWriter(handle),
                directory: dirname(target),
                progress,
                activeFolderIds: new Set<string>(),
              };
              await collectDriveFolder(file, "", state);
              await state.zip.finish();
              fileCount = state.fileCount;
              folderCount = state.folderCount;
              sourceBytes = state.sourceBytes;
            } finally {
              await handle.close();
            }
          },
        },
      );
      const markdownDownloadLink = markdownLink(
        `Download ${name}`,
        artifact.url,
      );
      const payload = {
        status: "saved_artifact",
        file: normalizeFile(file),
        folder: isFolder,
        fileCount,
        folderCount,
        sourceBytes,
        archiveBytes: isFolder ? artifact.size : null,
        artifact,
        localPath: path,
        markdownDownloadLink,
        presentationGuidance:
          "Give the user markdownDownloadLink. It points to the authenticated session artifact and downloads with the original file name.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  },
);

export const assistantGoogleDriveTools = [
  googleDriveSearchFilesTool,
  googleDriveGetFileTool,
  googleDriveDownloadTool,
];

export async function getGoogleDriveFileTextPreview(
  fileId: string,
  maxChars = 20_000,
): Promise<{
  file: ReturnType<typeof normalizeFile>;
  exportMimeType: string;
  truncated: boolean;
  textCharCount: number;
  text: string;
}> {
  const cleanFileId = fileId.trim();
  if (!cleanFileId) throw new Error("fileId is required.");
  const config = getGoogleToolConfig();
  const accessToken = await ensureGoogleAccessToken(config);
  const file = await getFileMetadata(cleanFileId, accessToken);
  const exported = await exportReadableFile(file, accessToken);
  const limit = clamp(maxChars, 20_000, 1_000, 100_000);
  const text =
    exported.text.length > limit
      ? `${exported.text.slice(0, limit)}…`
      : exported.text;
  return {
    file: normalizeFile(file),
    exportMimeType: exported.mimeType,
    truncated: exported.text.length > limit,
    textCharCount: text.length,
    text,
  };
}

async function searchFiles({
  accessToken,
  query,
  maxResults,
  orderBy,
  pageToken: startPageToken,
}: {
  accessToken: string;
  query: string;
  maxResults: number;
  orderBy: string;
  pageToken?: string | undefined;
}): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
  const out: DriveFile[] = [];
  let pageToken = startPageToken;
  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: String(Math.min(100, maxResults - out.length)),
      fields: `nextPageToken,files(${driveFileFields})`,
      orderBy,
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleDriveGet<DriveFilesPage>(
      `files?${params}`,
      accessToken,
    );
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
    if (out.length >= maxResults)
      return {
        files: out.slice(0, maxResults),
        nextPageToken: pageToken ?? null,
      };
  } while (pageToken);
  return { files: out, nextPageToken: null };
}

async function getFileMetadata(
  fileId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<DriveFile> {
  return googleDriveGet<DriveFile>(
    `files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(driveFileFields)}&supportsAllDrives=true`,
    accessToken,
    signal,
  );
}

async function resolveDriveShortcut(
  file: DriveFile,
  accessToken: string,
  signal?: AbortSignal,
): Promise<DriveFile> {
  if (file.mimeType !== GOOGLE_SHORTCUT_MIME) return file;
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId)
    throw new Error(`Drive shortcut ${file.name ?? file.id} has no target id.`);
  const target = await getFileMetadata(targetId, accessToken, signal);
  const name = file.name ?? target.name;
  return { ...target, ...(name ? { name } : {}) };
}

async function listFolderChildren(
  folderId: string,
  accessToken: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${escapeDriveString(folderId)}' in parents and trashed = false`,
      pageSize: String(Math.min(1_000, maxResults - files.length)),
      fields: `nextPageToken,files(${driveFileFields})`,
      orderBy: "folder,name_natural",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleDriveGet<DriveFilesPage>(
      `files?${params}`,
      accessToken,
      signal,
    );
    for (const file of page.files ?? []) {
      files.push(file);
      if (files.length >= maxResults) return files;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function collectDriveFolder(
  folder: DriveFile,
  prefix: string,
  state: DriveFolderDownloadState,
): Promise<void> {
  const folderId = folder.id;
  if (!folderId)
    throw new Error("Google Drive returned a folder without an id.");
  if (state.activeFolderIds.has(folderId))
    throw new Error(
      `Drive folder shortcut cycle detected at ${folder.name ?? folderId}.`,
    );
  state.activeFolderIds.add(folderId);
  const remainingEntries =
    state.maxFiles - state.fileCount + (MAX_FOLDER_COUNT - state.folderCount);
  const children = await listFolderChildren(
    folderId,
    await state.accessToken(),
    remainingEntries + 1,
    state.signal,
  );
  if (children.length > remainingEntries)
    throw new Error(
      `Drive folder exceeds the ${state.maxFiles}-file or ${MAX_FOLDER_COUNT}-folder download limit.`,
    );
  const usedNames = new Set<string>();
  if (children.length === 0 && prefix)
    await state.zip.addEntry(`${prefix}/`, folder.modifiedTime);
  for (const child of children) {
    const resolved = await resolveDriveShortcut(
      child,
      await state.accessToken(),
      state.signal,
    );
    const rawName = cleanDownloadName(
      child.name ?? resolved.name ?? resolved.id ?? "file",
    );
    if (resolved.mimeType === GOOGLE_FOLDER_MIME) {
      if (state.folderCount >= MAX_FOLDER_COUNT)
        throw new Error(
          `Drive folder contains more than ${MAX_FOLDER_COUNT} folders.`,
        );
      const folderName = uniqueSiblingName(rawName, usedNames);
      state.folderCount += 1;
      await collectDriveFolder(
        resolved,
        prefix ? `${prefix}/${folderName}` : folderName,
        state,
      );
      continue;
    }
    if (state.fileCount >= state.maxFiles)
      throw new Error(
        `Drive folder contains more than ${state.maxFiles} files. Raise maxFiles to download it.`,
      );
    const plan = driveDownloadPlan({ ...resolved, name: rawName });
    const fileName = uniqueSiblingName(plan.name, usedNames);
    const before = state.sourceBytes;
    const accessToken = await state.accessToken();
    state.sourceBytes += await state.zip.addEntry(
      prefix ? `${prefix}/${fileName}` : fileName,
      resolved.modifiedTime,
      (write) =>
        streamDriveContent(
          plan,
          accessToken,
          state.maxDownloadBytes - before,
          {
            directory: state.directory,
            write,
            progress: (bytes) => state.progress(before + bytes),
          },
          state.signal,
        ),
    );
    state.fileCount += 1;
  }
  state.activeFolderIds.delete(folderId);
}

function driveDownloadPlan(
  file: DriveFile,
  requestedMimeType?: string,
): DriveDownloadPlan {
  const fileId = file.id;
  if (!fileId) throw new Error("Google Drive returned a file without an id.");
  const encodedId = encodeURIComponent(fileId);
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    const exportMimeType = chooseExportMimeType(file, requestedMimeType);
    return {
      name: withExportExtension(
        cleanDownloadName(file.name ?? fileId),
        exportMimeType,
      ),
      mimeType: exportMimeType,
      apiPath: `files/${encodedId}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
      declaredSize: null,
    };
  }
  const declaredSize = Number(file.size);
  return {
    name: cleanDownloadName(file.name ?? fileId),
    mimeType: file.mimeType || "application/octet-stream",
    apiPath: `files/${encodedId}?alt=media&supportsAllDrives=true`,
    declaredSize: Number.isFinite(declaredSize) ? declaredSize : null,
  };
}

function chooseExportMimeType(
  file: DriveFile,
  requestedMimeType?: string,
): string {
  const available = Object.keys(file.exportLinks ?? {});
  const requested = requestedMimeType?.trim();
  if (requested) {
    if (!available.includes(requested))
      throw new Error(
        `Google Drive cannot export ${file.name ?? file.id} as ${requested}. Available export MIME types: ${available.join(", ") || "none"}.`,
      );
    return requested;
  }
  const preferences = EXPORT_MIME_PREFERENCES[file.mimeType ?? ""] ?? [];
  const selected = preferences.find((mimeType) => available.includes(mimeType));
  if (selected) return selected;
  if (available[0]) return available[0];
  throw new Error(
    `Google Drive does not offer an export format for ${file.name ?? file.id}.`,
  );
}

/** Stream one Drive download into `sink`; returns the byte count. */
async function streamDriveContent(
  plan: DriveDownloadPlan,
  accessToken: string,
  maxBytes: number,
  sink: DriveContentSink,
  signal?: AbortSignal,
): Promise<number> {
  if (maxBytes < 0)
    throw new Error("The Drive download exceeds maxDownloadBytes.");
  if (plan.declaredSize !== null && plan.declaredSize > maxBytes)
    throw new Error(
      `Drive file ${plan.name} is ${plan.declaredSize} bytes, above the remaining ${maxBytes}-byte maxDownloadBytes limit.`,
    );
  const response = await fetch(`${DRIVE_API_BASE}${plan.apiPath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Google Drive API returned HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return 0;
  let total = 0;
  try {
    const contentLength = response.headers.get("content-length");
    const responseSize = contentLength ? Number(contentLength) : NaN;
    if (Number.isFinite(responseSize) && responseSize > maxBytes)
      throw new Error(
        `Google Drive download is ${responseSize} bytes, above the remaining ${maxBytes}-byte maxDownloadBytes limit.`,
      );
    const expectedSize = Number.isFinite(responseSize)
      ? responseSize
      : (plan.declaredSize ?? 0);
    await assertFreeDiskSpace(sink.directory, plan.name, expectedSize);
    let nextDiskCheck = DISK_CHECK_INTERVAL_BYTES;
    while (true) {
      const next = await reader.read();
      if (next.done) return total;
      if (total + next.value.byteLength > maxBytes)
        throw new Error(
          `Google Drive download exceeds the remaining ${maxBytes}-byte maxDownloadBytes limit.`,
        );
      await sink.write(next.value);
      total += next.value.byteLength;
      sink.progress?.(total);
      if (total >= nextDiskCheck) {
        await assertFreeDiskSpace(
          sink.directory,
          plan.name,
          Math.max(0, expectedSize - total),
        );
        nextDiskCheck = total + DISK_CHECK_INTERVAL_BYTES;
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

/** Refuse to write `pendingBytes` more when that would leave the disk under its reserve. */
async function assertFreeDiskSpace(
  directory: string,
  name: string,
  pendingBytes: number,
): Promise<void> {
  const disk = await statfs(directory);
  const available = disk.bavail * disk.bsize;
  if (pendingBytes + MIN_FREE_DISK_BYTES > available)
    throw new Error(
      `Not enough free disk space to save ${name}: ${formatMiB(available)} available, ${formatMiB(pendingBytes)} still to write, and ${formatMiB(MIN_FREE_DISK_BYTES)} must stay free.`,
    );
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    written += result.bytesWritten;
  }
}

function downloadProgress(
  ctx: ToolCallContext,
  name: string,
): (bytes: number) => void {
  let reportedAt = Date.now();
  return (bytes) => {
    if (!ctx.progress || Date.now() - reportedAt < PROGRESS_INTERVAL_MS) return;
    reportedAt = Date.now();
    ctx.progress({
      content: [
        {
          type: "text",
          text: `Downloading ${name} from Google Drive: ${formatMiB(bytes)} so far.`,
        },
      ],
    });
  };
}

function formatMiB(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

async function exportReadableFile(
  file: DriveFile,
  accessToken: string,
  requestedMimeType?: string,
): Promise<{ mimeType: string; text: string }> {
  const mimeType = file.mimeType ?? "";
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const exportTypes = unique(
      [requestedMimeType, "text/markdown", "text/plain"].filter(
        Boolean,
      ) as string[],
    );
    const errors: string[] = [];
    for (const exportMimeType of exportTypes) {
      try {
        return {
          mimeType: exportMimeType,
          text: await googleDriveText(
            `files/${encodeURIComponent(file.id ?? "")}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
            accessToken,
          ),
        };
      } catch (err) {
        errors.push(
          `${exportMimeType}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new Error(
      `Could not export Google Workspace file ${file.id}. Tried ${errors.join("; ")}`,
    );
  }

  if (isTextLikeMime(mimeType)) {
    return {
      mimeType,
      text: await googleDriveText(
        `files/${encodeURIComponent(file.id ?? "")}?alt=media&supportsAllDrives=true`,
        accessToken,
      ),
    };
  }

  throw new Error(
    `File ${file.name ?? file.id} has MIME type ${mimeType || "unknown"}, which is not readable as text. Use google_drive_download to retrieve the file, or open webViewLink.`,
  );
}

async function googleDriveGet<T>(
  pathOrUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${DRIVE_API_BASE}${pathOrUrl.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google Drive API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function googleDriveText(
  pathOrUrl: string,
  accessToken: string,
): Promise<string> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${DRIVE_API_BASE}${pathOrUrl.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/plain,text/markdown,text/html,*/*",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google Drive API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text;
}

function hasTextCriteria(params: SearchDriveFilesParams): boolean {
  return Boolean(
    params.query?.trim() || params.name?.trim() || params.fullText?.trim(),
  );
}

function extractDriveId(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!raw.includes("/") && !raw.includes("?")) return raw;
  const match =
    /\/(?:folders|d)\/([\w-]+)/.exec(raw) ?? /[?&]id=([\w-]+)/.exec(raw);
  if (!match?.[1])
    throw new Error(`Could not read a Google Drive id from "${raw}".`);
  return match[1];
}

function buildDriveQuery(params: SearchDriveFilesParams): string {
  const clauses: string[] = [];
  if (params.includeTrashed !== true) clauses.push("trashed = false");

  if (params.query?.trim()) {
    const q = escapeDriveString(params.query.trim());
    clauses.push(`(name contains '${q}' or fullText contains '${q}')`);
  }
  if (params.name?.trim())
    clauses.push(`name contains '${escapeDriveString(params.name.trim())}'`);
  if (params.fullText?.trim())
    clauses.push(
      `fullText contains '${escapeDriveString(params.fullText.trim())}'`,
    );

  const folderId = extractDriveId(params.folderId);
  if (folderId) clauses.push(`'${escapeDriveString(folderId)}' in parents`);
  if (params.foldersOnly === true)
    clauses.push(`mimeType = '${GOOGLE_FOLDER_MIME}'`);

  const mimeTypes = unique(
    [params.mimeType, ...(params.mimeTypes ?? [])].filter(Boolean) as string[],
  );
  if (mimeTypes.length === 1)
    clauses.push(`mimeType = '${escapeDriveString(mimeTypes[0]!)}'`);
  if (mimeTypes.length > 1)
    clauses.push(
      `(${mimeTypes.map((mimeType) => `mimeType = '${escapeDriveString(mimeType)}'`).join(" or ")})`,
    );

  if (params.meetingArtifactsOnly === true) {
    clauses.push(
      `(mimeType = '${GOOGLE_DOC_MIME}' or mimeType = 'application/pdf' or mimeType contains 'video/')`,
    );
    clauses.push(
      "(name contains 'notes' or name contains 'transcript' or name contains 'Transcript' or fullText contains 'Meeting notes' or fullText contains 'Transcript')",
    );
  }

  if (params.date && !ISO_DATE_RE.test(params.date))
    throw new Error("date must be a YYYY-MM-DD date.");
  const dateRange = params.date ? localDayRange(params.date) : null;
  if (dateRange)
    clauses.push(
      `((createdTime >= '${dateRange.from}' and createdTime < '${dateRange.to}') or (modifiedTime >= '${dateRange.from}' and modifiedTime < '${dateRange.to}'))`,
    );
  if (params.createdFrom)
    clauses.push(
      `createdTime >= '${normalizeRfc3339(params.createdFrom, "createdFrom")}'`,
    );
  if (params.createdTo)
    clauses.push(
      `createdTime < '${normalizeRfc3339(params.createdTo, "createdTo")}'`,
    );
  if (params.modifiedFrom)
    clauses.push(
      `modifiedTime >= '${normalizeRfc3339(params.modifiedFrom, "modifiedFrom")}'`,
    );
  if (params.modifiedTo)
    clauses.push(
      `modifiedTime < '${normalizeRfc3339(params.modifiedTo, "modifiedTo")}'`,
    );

  return clauses.length > 0 ? clauses.join(" and ") : "trashed = false";
}

function normalizeFileCompact(file: DriveFile) {
  return {
    id: file.id ?? null,
    name: file.name ?? "(untitled)",
    mimeType: file.mimeType ?? null,
    webViewLink: file.webViewLink ?? null,
    markdownLink: file.webViewLink
      ? markdownLink(file.name ?? "(untitled)", file.webViewLink)
      : null,
    modifiedTime: file.modifiedTime ?? null,
    localModified: formatLocalDateTime(file.modifiedTime),
    size: file.size ? Number(file.size) : null,
  };
}

function normalizeFile(file: DriveFile) {
  return {
    id: file.id ?? null,
    name: file.name ?? "(untitled)",
    mimeType: file.mimeType ?? null,
    description: file.description ?? null,
    webViewLink: file.webViewLink ?? null,
    webContentLink: file.webContentLink ?? null,
    markdownLink: file.webViewLink
      ? markdownLink(file.name ?? "(untitled)", file.webViewLink)
      : null,
    iconLink: file.iconLink ?? null,
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
    localCreated: formatLocalDateTime(file.createdTime),
    localModified: formatLocalDateTime(file.modifiedTime),
    size: file.size ? Number(file.size) : null,
    parents: file.parents ?? [],
    owners: (file.owners ?? []).map((owner) => ({
      displayName: owner.displayName ?? null,
      emailAddress: owner.emailAddress ?? null,
    })),
    lastModifyingUser: file.lastModifyingUser
      ? {
          displayName: file.lastModifyingUser.displayName ?? null,
          emailAddress: file.lastModifyingUser.emailAddress ?? null,
        }
      : null,
    exportMimeTypes: Object.keys(file.exportLinks ?? {}),
    shortcutTargetId: file.shortcutDetails?.targetId ?? null,
    shortcutTargetMimeType: file.shortcutDetails?.targetMimeType ?? null,
  };
}

function isTextLikeMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-ndjson",
    ].includes(mimeType)
  );
}

function cleanDownloadName(name: string): string {
  const cleaned = [...name]
    .map((char) => {
      const code = char.charCodeAt(0);
      return char === "/" || char === "\\" || code < 32 || code === 127
        ? "_"
        : char;
    })
    .join("")
    .trim()
    .replace(/^\.+$/, "");
  if (!cleaned) return "download";
  const characters = [...cleaned];
  if (characters.length <= 240) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot) : "";
  const extensionCharacters = [...extension];
  if (extensionCharacters.length > 20) return characters.slice(0, 240).join("");
  return `${characters.slice(0, 240 - extensionCharacters.length).join("")}${extension}`;
}

function uniqueSiblingName(name: string, used: Set<string>): string {
  const key = name.toLocaleLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    const candidateKey = candidate.toLocaleLowerCase();
    if (!used.has(candidateKey)) {
      used.add(candidateKey);
      return candidate;
    }
  }
}

function withExportExtension(name: string, mimeType: string): string {
  const extension = EXPORT_EXTENSION[mimeType] ?? ".bin";
  return name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())
    ? name
    : `${name}${extension}`;
}

/**
 * A stored (uncompressed) ZIP written straight to disk. Each entry's local
 * header is written first and patched with its CRC and size once the bytes are
 * down, so no entry is ever held in memory.
 */
class DriveZipWriter {
  private offset = 0;
  private readonly central: Buffer[] = [];
  private entryCount = 0;

  constructor(private readonly handle: FileHandle) {}

  /** Append one entry (a directory when `path` ends in `/`); returns its size. */
  async addEntry(
    path: string,
    modifiedTime: string | undefined,
    fill?: (write: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>,
  ): Promise<number> {
    const name = Buffer.from(path, "utf8");
    if (name.byteLength > 0xffff)
      throw new Error(`Drive ZIP path is too long: ${path.slice(0, 200)}`);
    const { date, time } = zipDosDateTime(modifiedTime);
    const headerOffset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    await writeAll(this.handle, Buffer.concat([local, name]), headerOffset);

    const dataOffset = headerOffset + local.byteLength + name.byteLength;
    let size = 0;
    let crc = 0;
    await fill?.(async (chunk) => {
      if (dataOffset + size + chunk.byteLength > ZIP_MAX_OFFSET)
        throw new Error(
          "The Drive folder ZIP would exceed 4 GiB. Download its large files individually.",
        );
      await writeAll(this.handle, chunk, dataOffset + size);
      crc = crc32(chunk, crc);
      size += chunk.byteLength;
    });
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc, 0);
    sizes.writeUInt32LE(size, 4);
    sizes.writeUInt32LE(size, 8);
    await writeAll(this.handle, sizes, headerOffset + 14);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(path.endsWith("/") ? 0x10 : 0, 38);
    central.writeUInt32LE(headerOffset, 42);
    this.central.push(central, name);
    this.entryCount += 1;
    this.offset = dataOffset + size;
    return size;
  }

  async finish(): Promise<void> {
    const centralDirectory = Buffer.concat(this.central);
    if (this.offset + centralDirectory.byteLength > ZIP_MAX_OFFSET)
      throw new Error(
        "The Drive folder ZIP would exceed 4 GiB. Download its large files individually.",
      );
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entryCount, 8);
    end.writeUInt16LE(this.entryCount, 10);
    end.writeUInt32LE(centralDirectory.byteLength, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);
    await writeAll(
      this.handle,
      Buffer.concat([centralDirectory, end]),
      this.offset,
    );
  }
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** CRC-32 of `bytes`, continuing from `previous` for a streamed entry. */
function crc32(bytes: Uint8Array, previous = 0): number {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index += 1)
    value = CRC32_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipDosDateTime(value?: string): { date: number; time: number } {
  const parsed = value ? new Date(value) : new Date();
  const source = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const year = Math.max(1980, Math.min(2107, source.getFullYear()));
  return {
    date:
      ((year - 1980) << 9) | ((source.getMonth() + 1) << 5) | source.getDate(),
    time:
      (source.getHours() << 11) |
      (source.getMinutes() << 5) |
      Math.floor(source.getSeconds() / 2),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function markdownLink(label: string, href: string): string {
  return `[${label.replace(/[\\[\]]/g, "\\$&")}](${href})`;
}

function escapeDriveString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function clamp(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
