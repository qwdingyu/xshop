import { describe, expect, it } from "vitest";
import { launchModeDescription, normalizeLaunchMode, shouldFailLaunchGate } from "./launch-gate.mjs";

describe("launch gate mode", () => {
  it("defaults to strict public launch mode", () => {
    expect(normalizeLaunchMode(undefined)).toBe("public");
    expect(shouldFailLaunchGate({ failures: 0, warnings: 1 })).toBe(true);
  });

  it("allows warnings only for explicit trial mode", () => {
    expect(shouldFailLaunchGate({ failures: 0, warnings: 1, mode: "trial" })).toBe(false);
  });

  it("never allows failures in trial mode", () => {
    expect(shouldFailLaunchGate({ failures: 1, warnings: 0, mode: "trial" })).toBe(true);
  });

  it("rejects unknown launch modes", () => {
    expect(shouldFailLaunchGate({ failures: 0, warnings: 0, mode: "staging" })).toBe(true);
    expect(launchModeDescription("staging")).toContain("未知上线模式");
  });
});
