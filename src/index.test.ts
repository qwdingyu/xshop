import { describe, expect, it, vi } from "vitest";
import worker, { shouldApplyApiNoStore, withApiNoStore } from "./index";
import type { Bindings } from "./bindings";

function mockEnv(files: Record<string, string>) {
  const assets = {
    fetch: vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      const body = files[pathname];
      return new Response(body ?? "not found", { status: body === undefined ? 404 : 200 });
    }),
  };

  return {
    env: { ASSETS: assets } as unknown as Bindings,
    assets,
  };
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("worker SPA routing", () => {
  it("overrides every API response with a no-store policy", async () => {
    const response = withApiNoStore(new Response(JSON.stringify({ ok: true }), {
      headers: { "Cache-Control": "public, max-age=3600" },
    }));

    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
  });

  it("keeps only successful immutable public media as the explicit cacheable API exception", () => {
    expect(shouldApplyApiNoStore("/products", new Response("ok"))).toBe(true);
    expect(shouldApplyApiNoStore("/orders/lookup", new Response("ok"))).toBe(true);
    expect(shouldApplyApiNoStore("/media/images/logo.webp", new Response("ok", {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }))).toBe(false);
    expect(shouldApplyApiNoStore("/media/images/missing.webp", new Response("missing", { status: 404 }))).toBe(true);
    expect(shouldApplyApiNoStore("/media/images/missing.webp", new Response("error", {
      status: 503,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }))).toBe(true);
  });

  it("applies the policy even when API initialization fails", async () => {
    const { env } = mockEnv({});
    const response = await worker.fetch(new Request("https://shop.example/api/products"), env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("applies no-store to Telegram webhook responses at the worker boundary", async () => {
    const { env } = mockEnv({});
    const response = await worker.fetch(new Request("https://shop.example/tg/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), env, ctx);

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  it("applies no-store to public media errors but preserves successful immutable media", async () => {
    const { env } = mockEnv({});
    const missingBinding = await worker.fetch(
      new Request("https://shop.example/api/media/images/123e4567-e89b-42d3-a456-426614174000.webp"),
      env,
      ctx,
    );
    expect(missingBinding.status).toBe(503);
    expect(missingBinding.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");

    const mediaEnv = {
      ...env,
      PRODUCT_MEDIA: {
        get: vi.fn().mockResolvedValue({
          body: new Blob(["image"]).stream(),
          httpEtag: '"etag"',
          writeHttpMetadata: vi.fn(),
        }),
      } as unknown as R2Bucket,
    } as unknown as Bindings;
    const success = await worker.fetch(
      new Request("https://shop.example/api/media/images/123e4567-e89b-42d3-a456-426614174000.webp"),
      mediaEnv,
      ctx,
    );
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(success.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it.each([
    "/",
    "/shop",
    "/s/software",
    "/redeem",
    "/lookup",
    "/order",
    "/admin",
    "/admin/cards",
    "/_app/admin/cards",
  ])("serves the same Vue entry for page route %s", async (path) => {
    const { env, assets } = mockEnv({ "/_app/index.html": "<div id=\"app\"></div>" });

    const res = await worker.fetch(new Request(`https://shop.example${path}`), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=\"app\"");
    expect(assets.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "https://shop.example/_app/index.html" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
  });

  it("serves the Vue entry for a named storefront route", async () => {
    const { env, assets } = mockEnv({ "/_app/index.html": "<div id=\"app\"></div>" });

    const res = await worker.fetch(new Request("https://shop.example/s/software"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=\"app\"");
    expect(assets.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "https://shop.example/_app/index.html" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });

  it("serves the Vue entry for /_app/redeem", async () => {
    const { env, assets } = mockEnv({ "/_app/index.html": "<div id=\"app\"></div>" });

    const res = await worker.fetch(new Request("https://shop.example/_app/redeem"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=\"app\"");
    expect(assets.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "https://shop.example/_app/index.html" }));
  });

  it("serves the Vue entry for /_app/admin/login", async () => {
    const { env, assets } = mockEnv({ "/_app/index.html": "<div id=\"app\"></div>" });

    const res = await worker.fetch(new Request("https://shop.example/_app/admin/login"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=\"app\"");
    expect(assets.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "https://shop.example/_app/index.html" }));
  });

  it("keeps /_app/assets/* as immutable static assets", async () => {
    const { env } = mockEnv({ "/_app/assets/app.js": "console.log('ok')" });

    const res = await worker.fetch(new Request("https://shop.example/_app/assets/app.js"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('ok')");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("does not cache a missing hashed asset as immutable", async () => {
    const { env } = mockEnv({});

    const res = await worker.fetch(new Request("https://shop.example/_app/assets/missing.js"), env, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
  });

  it("does not cache a missing SPA entry", async () => {
    const { env } = mockEnv({});
    const res = await worker.fetch(new Request("https://shop.example/shop"), env, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });
});
