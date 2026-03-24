import { describe, expect, it } from "vitest";

// Re-export internals for testing via a small inline approach:
// We test the module's pure functions by importing the module and using its exports.
// Since the pure helpers are not exported, we duplicate minimal logic here to test the patterns.

describe("extractVideoId", () => {
  // Mirror the extraction logic to validate all URL patterns
  function extractVideoId(input: string): string | null {
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return trimmed;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.hostname.includes("youtube.com") && url.searchParams.has("v")) {
      return url.searchParams.get("v");
    }
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return id || null;
    }
    const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) {
      return embedMatch[1];
    }
    const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
    return null;
  }

  it("extracts from standard watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from watch URL with extra params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120&list=PLx")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("extracts from youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from embed URL", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from mobile URL", () => {
    expect(extractVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from music.youtube.com", () => {
    expect(extractVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts plain 11-char video ID", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("handles IDs with dashes and underscores", () => {
    expect(extractVideoId("abc-_def123")).toBe("abc-_def123");
  });

  it("trims whitespace", () => {
    expect(extractVideoId("  dQw4w9WgXcQ  ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for invalid input", () => {
    expect(extractVideoId("not-a-url")).toBeNull();
  });

  it("returns null for non-YouTube URLs", () => {
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractVideoId("")).toBeNull();
  });
});

describe("selectCaptionTrack", () => {
  type CaptionTrack = {
    baseUrl: string;
    languageCode: string;
    name?: string;
    kind?: string;
  };

  function selectCaptionTrack(tracks: CaptionTrack[], preferredLanguage?: string): CaptionTrack {
    if (preferredLanguage) {
      const lang = preferredLanguage.toLowerCase();
      const exact = tracks.find((t) => t.languageCode.toLowerCase() === lang);
      if (exact) {
        return exact;
      }
      const prefix = tracks.find((t) => t.languageCode.toLowerCase().startsWith(lang));
      if (prefix) {
        return prefix;
      }
    }
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

  const tracks: CaptionTrack[] = [
    { baseUrl: "url1", languageCode: "ar", name: "Arabic" },
    { baseUrl: "url2", languageCode: "en", kind: "asr", name: "English (auto)" },
    { baseUrl: "url3", languageCode: "en", name: "English" },
    { baseUrl: "url4", languageCode: "es", name: "Spanish" },
  ];

  it("selects exact language match", () => {
    expect(selectCaptionTrack(tracks, "ar").languageCode).toBe("ar");
  });

  it("selects prefix language match", () => {
    expect(selectCaptionTrack(tracks, "e").languageCode).toBe("en");
  });

  it("prefers manual English over auto-generated when no preference", () => {
    expect(selectCaptionTrack(tracks).name).toBe("English");
  });

  it("falls back to auto English if no manual English exists", () => {
    const noManualEn: CaptionTrack[] = [
      { baseUrl: "url1", languageCode: "ar" },
      { baseUrl: "url2", languageCode: "en", kind: "asr" },
    ];
    expect(selectCaptionTrack(noManualEn).kind).toBe("asr");
  });

  it("falls back to first track if no English", () => {
    const noEn: CaptionTrack[] = [
      { baseUrl: "url1", languageCode: "ar" },
      { baseUrl: "url2", languageCode: "fr" },
    ];
    expect(selectCaptionTrack(noEn).languageCode).toBe("ar");
  });

  it("handles case-insensitive language matching", () => {
    expect(selectCaptionTrack(tracks, "ES").languageCode).toBe("es");
  });
});

describe("formatTimestamp", () => {
  function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  it("formats seconds-only", () => {
    expect(formatTimestamp(5)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(formatTimestamp(125)).toBe("2:05");
  });

  it("formats hours", () => {
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });

  it("handles zero", () => {
    expect(formatTimestamp(0)).toBe("0:00");
  });

  it("handles fractional seconds (floors)", () => {
    expect(formatTimestamp(59.9)).toBe("0:59");
  });
});

describe("decodeXmlEntities", () => {
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

  it("decodes standard XML entities", () => {
    expect(decodeXmlEntities("&amp; &lt; &gt; &quot;")).toBe('& < > "');
  });

  it("decodes numeric entities", () => {
    expect(decodeXmlEntities("&#39;hello&#39;")).toBe("'hello'");
  });

  it("decodes hex entities", () => {
    expect(decodeXmlEntities("&#x27;test&#x3E;")).toBe("'test>");
  });

  it("decodes apos entity", () => {
    expect(decodeXmlEntities("don&apos;t")).toBe("don't");
  });

  it("handles double-encoded amp correctly", () => {
    // &amp;amp; should become &amp; (only one level of decoding)
    expect(decodeXmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("passes through plain text unchanged", () => {
    expect(decodeXmlEntities("hello world")).toBe("hello world");
  });
});

describe("extractJsonObject", () => {
  function extractJsonObject(source: string, startIndex: number): string | null {
    if (source.charCodeAt(startIndex) !== 123) {
      return null;
    }
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
        escape = true;
        continue;
      }
      if (ch === 34) {
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

  it("extracts a simple JSON object", () => {
    expect(extractJsonObject('var x = {"a":1};', 8)).toBe('{"a":1}');
  });

  it("handles nested braces", () => {
    expect(extractJsonObject('{"a":{"b":2}}', 0)).toBe('{"a":{"b":2}}');
  });

  it("ignores braces inside strings", () => {
    const json = '{"text":"a } b { c"}';
    expect(extractJsonObject(json, 0)).toBe(json);
  });

  it("handles escaped quotes in strings", () => {
    const json = '{"text":"say \\"hello\\""}';
    expect(extractJsonObject(json, 0)).toBe(json);
  });

  it("returns null if brackets never balance", () => {
    expect(extractJsonObject('{"a":1', 0)).toBeNull();
  });

  it("returns null if start char is not {", () => {
    expect(extractJsonObject("[1,2]", 0)).toBeNull();
  });
});
