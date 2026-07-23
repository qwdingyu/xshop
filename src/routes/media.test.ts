import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { adminMediaRoute, mediaRoute } from "./media";

const writeAdminAudit = vi.hoisted(() => vi.fn());

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: (...args: unknown[]) => writeAdminAudit(...args),
}));

vi.mock("../lib/security", () => ({
  getIpHash: vi.fn().mockResolvedValue("ip-hash"),
}));

function createAdminApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api/admin/media", adminMediaRoute);
  return app;
}

function createPublicApp() {
  const app = new Hono<AppEnv>();
  app.route("/api", mediaRoute);
  return app;
}

function pngFile(type = "image/png") {
  return new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  ], "cover.png", { type });
}

describe("media routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAdminAudit.mockResolvedValue(undefined);
  });

  it("uploads a validated image with immutable R2 metadata", async () => {
    const put = vi.fn().mockResolvedValue({ key: "stored" });
    const form = new FormData();
    form.append("file", pngFile());

    const response = await createAdminApp().request("https://shop.example.com/api/admin/media/images", {
      method: "POST",
      body: form,
    }, { PRODUCT_MEDIA: { put } as unknown as R2Bucket });

    expect(response.status).toBe(200);
    const body = await response.json<{ url: string; contentType: string; size: number }>();
    expect(body.url).toMatch(/^\/api\/media\/images\/[0-9a-f-]+\.png$/);
    expect(body.contentType).toBe("image/png");
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^images\/[0-9a-f-]+\.png$/), expect.any(Uint8Array), {
      httpMetadata: {
        contentType: "image/png",
        contentDisposition: "inline",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "upload_media_image",
      metadata: { contentType: "image/png", size: 12 },
    }));
  });

  it("rejects spoofed content before writing to R2", async () => {
    const put = vi.fn();
    const form = new FormData();
    form.append("file", pngFile("image/jpeg"));

    const response = await createAdminApp().request("/api/admin/media/images", {
      method: "POST",
      body: form,
    }, { PRODUCT_MEDIA: { put } as unknown as R2Bucket });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "图片内容与文件类型不一致" });
    expect(put).not.toHaveBeenCalled();
  });

  it("returns a clear capability error when the R2 binding is absent", async () => {
    const response = await createAdminApp().request("/api/admin/media/images", { method: "POST" }, {} as AppEnv["Bindings"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "图片存储未配置，请先创建并绑定 R2 Bucket",
      details: { code: "MEDIA_STORAGE_UNAVAILABLE" },
    });
  });

  it("serves only managed image keys with immutable and nosniff headers", async () => {
    const key = "images/123e4567-e89b-42d3-a456-426614174000.webp";
    const get = vi.fn().mockResolvedValue({
      body: new Blob(["image"]).stream(),
      httpEtag: '"etag"',
      httpMetadata: { contentType: "text/html" },
      writeHttpMetadata(headers: Headers) { headers.set("Content-Type", "text/html"); },
    });
    const response = await createPublicApp().request(`/api/media/${key}`, undefined, {
      PRODUCT_MEDIA: { get } as unknown as R2Bucket,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBe('"etag"');
    expect(get).toHaveBeenCalledWith(key);
  });

  it("rejects paths outside the managed image namespace without reading R2", async () => {
    const get = vi.fn();
    const response = await createPublicApp().request("/api/media/../private.zip", undefined, {
      PRODUCT_MEDIA: { get } as unknown as R2Bucket,
    });
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});
