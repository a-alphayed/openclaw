import { Type } from "@sinclair/typebox";
import { logDebug } from "../../logger.js";
import { wrapExternalContent } from "../../security/external-content.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { truncateText } from "./web-fetch-utils.js";
import {
  type CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  resolveCacheTtlMs,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS_CAP = 100_000;

const TRANSCRIPT_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const YouTubeTranscriptSchema = Type.Object({
  url: Type.String({
    description:
      "YouTube video URL or video ID (e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ, https://youtu.be/dQw4w9WgXcQ, or dQw4w9WgXcQ).",
  }),
  language: Type.Optional(
    Type.String({
      description:
        'Preferred caption language code (e.g. "en", "ar", "es"). Defaults to first available track.',
    }),
  ),
  max_chars: Type.Optional(
    Type.Number({
      description: "Max characters to return (default 50000).",
      minimum: 1000,
      maximum: MAX_CHARS_CAP,
    }),
  ),
});

type TranscriptSegment = {
  start: number;
  duration: number;
  text: string;
};

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  name?: string;
  kind?: string;
};

type VideoDetails = {
  title?: string;
  lengthSeconds?: number;
};

/**
 * Extract video ID from various YouTube URL formats.
 */
function extractVideoId(input: string): string | null {
  const trimmed = input.trim();

  // Plain video ID (11 chars, alphanumeric + dash + underscore)
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // youtube.com/watch?v=ID
  if (url.hostname.includes("youtube.com") && url.searchParams.has("v")) {
    return url.searchParams.get("v");
  }

  // youtu.be/ID
  if (url.hostname === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id || null;
  }

  // youtube.com/embed/ID
  const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) {
    return embedMatch[1];
  }

  // youtube.com/shorts/ID
  const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) {
    return shortsMatch[1];
  }

  return null;
}

/**
 * Decode XML entities in caption text.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

/**
 * Extract the text from a YouTube label object which may use either
 * `{simpleText: "..."}` or `{runs: [{text: "..."}]}` format.
 */
function extractLabelText(obj: unknown): string {
  if (!obj || typeof obj !== "object") {
    return "";
  }
  const record = obj as Record<string, unknown>;
  if (typeof record.simpleText === "string") {
    return record.simpleText;
  }
  const runs = record.runs as Array<Record<string, string>> | undefined;
  if (Array.isArray(runs)) {
    return runs.map((r) => r.text ?? "").join("");
  }
  return "";
}

/**
 * Extract a balanced JSON object from `source` starting at `startIndex`.
 * Returns the JSON substring or null if brackets never balance.
 */
function extractJsonObject(source: string, startIndex: number): string | null {
  if (source.charCodeAt(startIndex) !== 123) {
    return null;
  } // '{'
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === 92 && inString) {
      // backslash inside string
      escape = true;
      continue;
    }
    if (ch === 34) {
      // double quote
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === 123) {
      depth++;
    } else if (ch === 125) {
      depth--;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

type FetchCaptionResult = {
  tracks: CaptionTrack[];
  videoDetails: VideoDetails;
};

/**
 * Fetch the video page and extract caption track metadata + video details.
 */
async function fetchCaptionTracks(
  videoId: string,
  signal: AbortSignal,
): Promise<FetchCaptionResult> {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch YouTube page: HTTP ${res.status}`);
  }

  const html = await res.text();

  // Find the start of ytInitialPlayerResponse and use bracket counting for robust extraction
  const marker = html.match(/ytInitialPlayerResponse\s*=\s*/);
  if (!marker || marker.index === undefined) {
    throw new Error(
      "Could not extract player response from YouTube page. The video may be private, age-restricted, region-locked, or unavailable.",
    );
  }

  const jsonStart = marker.index + marker[0].length;
  const jsonStr = extractJsonObject(html, jsonStart);
  if (!jsonStr) {
    throw new Error(
      "Could not extract player response from YouTube page. The video may be private, age-restricted, region-locked, or unavailable.",
    );
  }

  let playerResponse: Record<string, unknown>;
  try {
    playerResponse = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse YouTube player response JSON.");
  }

  // Extract video details (title, duration)
  const details = playerResponse.videoDetails as Record<string, unknown> | undefined;
  const videoDetails: VideoDetails = {
    title: typeof details?.title === "string" ? details.title : undefined,
    lengthSeconds:
      typeof details?.lengthSeconds === "string"
        ? Number.parseInt(details.lengthSeconds, 10)
        : undefined,
  };

  const captions = playerResponse.captions as Record<string, unknown> | undefined;
  const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const tracks = renderer?.captionTracks as Array<Record<string, string>> | undefined;

  if (!tracks || tracks.length === 0) {
    throw new Error(
      "No captions available for this video. The video may not have subtitles/captions.",
    );
  }

  return {
    tracks: tracks.map((track) => ({
      baseUrl: track.baseUrl ?? "",
      languageCode: track.languageCode ?? "",
      name: extractLabelText(track.name) || undefined,
      kind: track.kind || undefined,
    })),
    videoDetails,
  };
}

/**
 * Select the best caption track based on language preference.
 */
function selectCaptionTrack(tracks: CaptionTrack[], preferredLanguage?: string): CaptionTrack {
  if (preferredLanguage) {
    const lang = preferredLanguage.toLowerCase();
    // Exact match
    const exact = tracks.find((t) => t.languageCode.toLowerCase() === lang);
    if (exact) {
      return exact;
    }
    // Prefix match (e.g. "en" matches "en-US")
    const prefix = tracks.find((t) => t.languageCode.toLowerCase().startsWith(lang));
    if (prefix) {
      return prefix;
    }
  }

  // Prefer non-auto-generated English, then any English, then first track
  const manualEn = tracks.find((t) => t.languageCode.startsWith("en") && t.kind !== "asr");
  if (manualEn) {
    return manualEn;
  }

  const anyEn = tracks.find((t) => t.languageCode.startsWith("en"));
  if (anyEn) {
    return anyEn;
  }

  return tracks[0];
}

/**
 * Fetch and parse the XML caption track into transcript segments.
 */
async function fetchTranscriptSegments(
  captionUrl: string,
  signal: AbortSignal,
): Promise<TranscriptSegment[]> {
  const res = await fetch(captionUrl, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch caption track: HTTP ${res.status}`);
  }

  const xml = await res.text();
  const segments: TranscriptSegment[] = [];

  // Parse <text start="..." dur="...">...</text> elements
  const textRegex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const start = Number.parseFloat(match[1] || "0");
    const duration = Number.parseFloat(match[2] || "0");
    const rawText = match[3] || "";
    const text = decodeXmlEntities(rawText.replace(/<[^>]+>/g, "")).trim();
    if (text) {
      segments.push({ start, duration, text });
    }
  }

  return segments;
}

/**
 * Format seconds as HH:MM:SS or MM:SS.
 */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format transcript segments into readable text with timestamps.
 */
function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    lines.push(`[${formatTimestamp(seg.start)}] ${seg.text}`);
  }
  return lines.join("\n");
}

type TranscriptRuntimeParams = {
  videoId: string;
  language?: string;
  maxChars: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
};

async function runYouTubeTranscript(
  params: TranscriptRuntimeParams,
): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `yt-transcript:${params.videoId}:${params.language ?? "auto"}:${params.maxChars}`,
  );
  const cached = readCache(TRANSCRIPT_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const signal = withTimeout(undefined, params.timeoutSeconds * 1000);

  logDebug(`[youtube-transcript] fetching captions for videoId=${params.videoId}`);
  const { tracks, videoDetails } = await fetchCaptionTracks(params.videoId, signal);
  const selectedTrack = selectCaptionTrack(tracks, params.language);

  logDebug(
    `[youtube-transcript] selected track: lang=${selectedTrack.languageCode} kind=${selectedTrack.kind ?? "manual"}`,
  );
  const segments = await fetchTranscriptSegments(selectedTrack.baseUrl, signal);

  if (segments.length === 0) {
    throw new Error("Caption track returned no text segments.");
  }

  const rawTranscript = formatTranscript(segments);
  const truncated = truncateText(rawTranscript, params.maxChars);
  const wrappedText = wrapExternalContent(truncated.text, {
    source: "web_fetch",
    includeWarning: false,
  });

  const availableLanguages = tracks.map((t) => ({
    code: t.languageCode,
    name: t.name,
    autoGenerated: t.kind === "asr",
  }));

  const payload: Record<string, unknown> = {
    videoId: params.videoId,
    videoUrl: `https://www.youtube.com/watch?v=${params.videoId}`,
    title: videoDetails.title,
    durationSeconds: videoDetails.lengthSeconds,
    durationFormatted: videoDetails.lengthSeconds
      ? formatTimestamp(videoDetails.lengthSeconds)
      : undefined,
    language: selectedTrack.languageCode,
    autoGenerated: selectedTrack.kind === "asr",
    segmentCount: segments.length,
    availableLanguages,
    externalContent: {
      untrusted: true,
      source: "youtube_transcript",
      wrapped: true,
    },
    truncated: truncated.truncated,
    length: wrappedText.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
    transcript: wrappedText,
  };

  writeCache(TRANSCRIPT_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createYouTubeTranscriptTool(options?: {
  sandboxed?: boolean;
}): AnyAgentTool | null {
  if (options?.sandboxed) {
    return null;
  }

  return {
    label: "YouTube Transcript",
    name: "youtube_transcript",
    description:
      "Extract the transcript (captions/subtitles) from a YouTube video. " +
      "Returns timestamped text segments. Useful for summarizing video content, " +
      "finding specific quotes, or analyzing what was said in a video.",
    parameters: YouTubeTranscriptSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const urlOrId = readStringParam(params, "url", { required: true });
      const language = readStringParam(params, "language", { required: false }) ?? undefined;
      const maxCharsParam = readNumberParam(params, "max_chars", { integer: true });

      const videoId = extractVideoId(urlOrId);
      if (!videoId) {
        throw new Error(
          `Invalid YouTube URL or video ID: "${urlOrId}". ` +
            "Supported formats: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, or a plain 11-character video ID.",
        );
      }

      const maxChars = Math.min(Math.max(1000, maxCharsParam ?? DEFAULT_MAX_CHARS), MAX_CHARS_CAP);

      const result = await runYouTubeTranscript({
        videoId,
        language,
        maxChars,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        cacheTtlMs: resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
      });

      return jsonResult(result);
    },
  };
}
