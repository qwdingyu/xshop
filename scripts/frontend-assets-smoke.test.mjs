import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectFrontendAssetPaths,
  extractFrontendAssetPaths,
  normalizeMaxAttempts,
  verifyAssetSet,
} from "./26-smoke-frontend-assets.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("frontend asset smoke manifest", () => {
  it("uses a bounded 60-second propagation window by default", () => {
    expect(normalizeMaxAttempts(undefined)).toBe(12);
    expect(normalizeMaxAttempts("invalid")).toBe(12);
    expect(normalizeMaxAttempts("3")).toBe(3);
    expect(normalizeMaxAttempts("99")).toBe(12);
  });

  it("extracts modern, stylesheet and legacy entry assets without duplicates", () => {
    const html = `
      <script src="/_app/assets/index-a.js"></script>
      <link href="/_app/assets/index-b.css" rel="stylesheet">
      <script data-src="/_app/assets/index-legacy-c.js"></script>
      <script src="/_app/assets/index-a.js"></script>
    `;

    expect(extractFrontendAssetPaths(html)).toEqual([
      "/_app/assets/index-a.js",
      "/_app/assets/index-b.css",
      "/_app/assets/index-legacy-c.js",
    ]);
  });

  it("builds a deterministic URL manifest for every generated asset", () => {
    const root = mkdtempSync(join(tmpdir(), "cf-shop-assets-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "assets", "nested"), { recursive: true });
    writeFileSync(join(root, "assets", "main-a.js"), "");
    writeFileSync(join(root, "assets", "nested", "view b.css"), "");

    expect(collectFrontendAssetPaths(root)).toEqual([
      "/_app/assets/main-a.js",
      "/_app/assets/nested/view%20b.css",
    ]);
  });

  it("retries only assets that failed the previous attempt", async () => {
    const calls = [];
    const attempts = new Map();
    const request = async (path) => {
      calls.push(path);
      const attempt = (attempts.get(path) || 0) + 1;
      attempts.set(path, attempt);
      return {
        statusCode: path === "/_app/assets/late.js" && attempt === 1 ? 404 : 200,
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      };
    };

    await verifyAssetSet(
      ["/_app/assets/ready.js", "/_app/assets/late.js"],
      { request, maxAttempts: 3, retryDelayMs: 0, sleepForRetry: async () => {}, warn: () => {} },
    );

    expect(calls).toEqual([
      "/_app/assets/ready.js",
      "/_app/assets/late.js",
      "/_app/assets/late.js",
    ]);
  });

  it("fails after the configured retry limit and reports every persistent failure", async () => {
    const calls = [];
    const delays = [];
    const request = async (path) => {
      calls.push(path);
      return { statusCode: 404, headers: {} };
    };

    await expect(verifyAssetSet(
      ["/_app/assets/missing-a.js", "/_app/assets/missing-b.css"],
      {
        request,
        maxAttempts: 3,
        retryDelayMs: 25,
        sleepForRetry: async (delay) => delays.push(delay),
        warn: () => {},
      },
    )).rejects.toThrow(
      "/_app/assets/missing-a.js: /_app/assets/missing-a.js failed: HTTP 404\n- /_app/assets/missing-b.css",
    );

    expect(calls).toHaveLength(6);
    expect(delays).toEqual([25, 25]);
  });
});
