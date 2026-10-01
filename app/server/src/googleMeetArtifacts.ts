import { errorText } from "./errors.ts";
import { formatLocalDateTime } from "./googleTime.ts";
const MEET_API_BASE = "https://meet.googleapis.com/v2/";

type MeetArtifactKind = "transcript" | "recording";

export type MeetArtifact = {
  kind: MeetArtifactKind;
  name: string | null;
  state: string | null;
  startTime: string | null;
  endTime: string | null;
  localStart: string | null;
  localEnd: string | null;
  driveFileId: string | null;
  documentId: string | null;
  webViewLink: string | null;
  exportUri: string | null;
  destination: unknown;
  entryCount?: number | null;
  textPreview?: string | null;
};

export type MeetArtifactsResult = {
  artifacts: MeetArtifact[];
  errors: string[];
};

type MeetTranscript = {
  name?: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: {
    document?: string;
    exportUri?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type MeetRecording = {
  name?: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  driveDestination?: {
    file?: string;
    exportUri?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type MeetTranscriptEntry = {
  name?: string;
  text?: string;
  startTime?: string;
  endTime?: string;
  languageCode?: string;
  participant?: string;
  [key: string]: unknown;
};

type MeetListPage<T> = {
  transcripts?: T[];
  recordings?: T[];
  transcriptEntries?: T[];
  nextPageToken?: string;
};

export async function listMeetArtifactsForConferenceRecord({
  accessToken,
  recordName,
  includeTranscriptEntries = false,
  transcriptPreviewChars = 2000,
}: {
  accessToken: string;
  recordName: string | null | undefined;
  includeTranscriptEntries?: boolean;
  transcriptPreviewChars?: number;
}): Promise<MeetArtifactsResult> {
  if (!recordName) return { artifacts: [], errors: [] };
  const artifacts: MeetArtifact[] = [];
  const errors: string[] = [];

  try {
    const transcripts = await listAllMeet<MeetTranscript>(
      `${recordName}/transcripts?pageSize=100`,
      "transcripts",
      accessToken,
    );
    for (const transcript of transcripts) {
      artifacts.push(
        await normalizeTranscript(
          transcript,
          accessToken,
          includeTranscriptEntries,
          transcriptPreviewChars,
        ),
      );
    }
  } catch (err) {
    errors.push(`transcripts: ${errorText(err)}`);
  }

  try {
    const recordings = await listAllMeet<MeetRecording>(
      `${recordName}/recordings?pageSize=100`,
      "recordings",
      accessToken,
    );
    for (const recording of recordings)
      artifacts.push(normalizeRecording(recording));
  } catch (err) {
    errors.push(`recordings: ${errorText(err)}`);
  }

  return { artifacts, errors };
}

async function normalizeTranscript(
  transcript: MeetTranscript,
  accessToken: string,
  includeEntries: boolean,
  previewChars: number,
): Promise<MeetArtifact> {
  let entryCount: number | null = null;
  let textPreview: string | null = null;
  if (includeEntries && transcript.name) {
    try {
      const entries = await listAllMeet<MeetTranscriptEntry>(
        `${transcript.name}/entries?pageSize=100`,
        "transcriptEntries",
        accessToken,
      );
      entryCount = entries.length;
      const text = entries
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n");
      textPreview =
        text.length > previewChars ? `${text.slice(0, previewChars)}…` : text;
    } catch (err) {
      textPreview = `Could not load transcript entries: ${errorText(err)}`;
    }
  }

  const document = transcript.docsDestination?.document ?? null;
  const exportUri = transcript.docsDestination?.exportUri ?? null;
  const driveFileId =
    extractDriveFileId(document) ?? extractDriveFileId(exportUri);
  return {
    kind: "transcript",
    name: transcript.name ?? null,
    state: transcript.state ?? null,
    startTime: transcript.startTime ?? null,
    endTime: transcript.endTime ?? null,
    localStart: formatLocalDateTime(transcript.startTime),
    localEnd: formatLocalDateTime(transcript.endTime),
    driveFileId,
    documentId: driveFileId,
    webViewLink: driveFileId
      ? `https://docs.google.com/document/d/${driveFileId}/edit`
      : exportUri,
    exportUri,
    destination: transcript.docsDestination ?? null,
    entryCount,
    textPreview,
  };
}

function normalizeRecording(recording: MeetRecording): MeetArtifact {
  const file = recording.driveDestination?.file ?? null;
  const exportUri = recording.driveDestination?.exportUri ?? null;
  const driveFileId = extractDriveFileId(file) ?? extractDriveFileId(exportUri);
  return {
    kind: "recording",
    name: recording.name ?? null,
    state: recording.state ?? null,
    startTime: recording.startTime ?? null,
    endTime: recording.endTime ?? null,
    localStart: formatLocalDateTime(recording.startTime),
    localEnd: formatLocalDateTime(recording.endTime),
    driveFileId,
    documentId: null,
    webViewLink: driveFileId
      ? `https://drive.google.com/file/d/${driveFileId}/view`
      : exportUri,
    exportUri,
    destination: recording.driveDestination ?? null,
  };
}

async function listAllMeet<T>(
  path: string,
  field: "transcripts" | "recordings" | "transcriptEntries",
  accessToken: string,
): Promise<T[]> {
  const out: T[] = [];
  let next = path;
  while (next) {
    const page = await meetGet<MeetListPage<T>>(next, accessToken);
    out.push(...(page[field] ?? []));
    next = page.nextPageToken
      ? `${path}${path.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(page.nextPageToken)}`
      : "";
  }
  return out;
}

async function meetGet<T>(pathOrUrl: string, accessToken: string): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${MEET_API_BASE}${pathOrUrl.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Google Meet API returned HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function extractDriveFileId(value: string | null | undefined): string | null {
  if (!value) return null;
  const patterns = [
    /\/document\/d\/([^/?#]+)/,
    /\/file\/d\/([^/?#]+)/,
    /[?&]id=([^&#]+)/,
    /(?:^|\/)files\/([^/?#]+)/,
    /(?:^|\/)documents\/([^/?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value;
  return null;
}
