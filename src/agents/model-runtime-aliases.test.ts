import { describe, expect, it } from "vitest";
import { isCliRuntimeAlias } from "./model-runtime-aliases.js";

describe("isCliRuntimeAlias", () => {
  it.each(["claude-cli", "codex-cli", "google-gemini-cli"])(
    "recognizes %s as a CLI runtime alias",
    (alias) => {
      expect(isCliRuntimeAlias(alias)).toBe(true);
    },
  );

  it.each(["pi", "auto", "default", "codex", "anthropic", ""])(
    "does not classify %s as a CLI runtime alias",
    (value) => {
      expect(isCliRuntimeAlias(value)).toBe(false);
    },
  );

  it("returns false for undefined", () => {
    expect(isCliRuntimeAlias(undefined)).toBe(false);
  });

  it("normalizes provider id casing", () => {
    expect(isCliRuntimeAlias("Claude-CLI")).toBe(true);
  });
});
