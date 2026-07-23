import { describe, expect, it } from "vitest";
import { findSecretMatches, scanTrackedFiles } from "./25-scan-secrets.mjs";

describe("repository secret scanner", () => {
  it("detects credential shapes without returning the credential value", () => {
    const jwt = ["eyJ", "A".repeat(20), ".eyJ", "B".repeat(20), ".", "C".repeat(20)].join("");
    expect(findSecretMatches(`token=${jwt}`, "fixture.txt")).toEqual([
      { file: "fixture.txt", line: 1, kind: "Turso/libSQL JWT" },
    ]);
  });

  it("keeps the tracked working tree free of real credential shapes", () => {
    expect(scanTrackedFiles()).toEqual([]);
  });
});
