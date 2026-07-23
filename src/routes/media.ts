import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok } from "../lib/http";
import {
  MEDIA_IMAGE_CACHE_CONTROL,
  createMediaImageKey,
  getManagedMediaImageContentType,
  validateMediaImage,
} from "../lib/media-image";
import { getIpHash } from "../lib/security";
import { writeAdminAudit } from "../services/audit-service";

export const mediaRoute = new Hono<AppEnv>();
export const adminMediaRoute = new Hono<AppEnv>();

function publicMediaUrl(key: string): string {
  // 保存站内相对 URL，避免本地 localhost 或生产域名进入数据库，迁移域名时也无需批量改数据。
  return `/api/media/${key}`;
}

function getMediaBucket(c: { env: AppEnv["Bindings"] }): R2Bucket | undefined {
  // 运行时检查用于给未完成 R2 初始化的部署返回明确错误，而不是抛出 undefined.put。
  return c.env.PRODUCT_MEDIA;
}

adminMediaRoute.post("/images", async (c) => {
  const bucket = getMediaBucket(c);
  if (!bucket) return fail(c, "图片存储未配置，请先创建并绑定 R2 Bucket", 503, { code: "MEDIA_STORAGE_UNAVAILABLE" });

  const contentType = c.req.header("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return fail(c, "图片上传必须使用 multipart/form-data", 415);
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return fail(c, "无法解析图片上传请求", 400);
  }

  // Workers 运行时会返回 File，但当前 FormData 类型声明在部分工具链中只暴露 string，先收窄 unknown。
  const entry: unknown = form.get("file");
  if (!entry || typeof entry !== "object" || !("arrayBuffer" in entry) || typeof entry.arrayBuffer !== "function") {
    return fail(c, "缺少图片文件", 400);
  }
  const file = entry as File;

  let bytes: Uint8Array;
  let image: ReturnType<typeof validateMediaImage>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    image = validateMediaImage(file, bytes);
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : "图片校验失败", 400);
  }

  const key = createMediaImageKey(image.extension);
  const stored = await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: image.contentType,
      contentDisposition: "inline",
      cacheControl: MEDIA_IMAGE_CACHE_CONTROL,
    },
  });
  if (!stored) return fail(c, "图片保存失败，请重试", 500);

  // 审计服务与其他管理操作一致采用非阻断策略，只记录类型和大小，不保存原文件名。
  await writeAdminAudit(getDb(c), {
    action: "upload_media_image",
    targetType: "media_image",
    targetId: key,
    metadata: { contentType: image.contentType, size: file.size },
    ipHash: await getIpHash(c),
  });

  return ok(c, {
    key,
    url: publicMediaUrl(key),
    contentType: image.contentType,
    size: file.size,
  });
});

mediaRoute.get("/media/images/:filename", async (c) => {
  const bucket = getMediaBucket(c);
  if (!bucket) return fail(c, "图片存储未配置", 503, { code: "MEDIA_STORAGE_UNAVAILABLE" });

  // 路由只开放 images 命名空间，避免未来同一 Bucket 中的其他对象被意外公开。
  const encodedKey = `images/${c.req.param("filename")}`;
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return fail(c, "图片地址无效", 404);
  }
  const safeContentType = getManagedMediaImageContentType(key);
  if (!safeContentType) return fail(c, "图片不存在", 404);

  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const edgeCache = typeof caches === "undefined" ? undefined : caches.default;
  const cached = await edgeCache?.match(cacheKey);
  if (cached) return cached;

  const object = await bucket.get(key);
  if (!object) return fail(c, "图片不存在", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", safeContentType);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", MEDIA_IMAGE_CACHE_CONTROL);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");

  const response = new Response(object.body, { headers });
  if (edgeCache) {
    c.executionCtx.waitUntil(edgeCache.put(cacheKey, response.clone()).catch((error) => {
      console.warn("[media-cache-put]", error instanceof Error ? error.message : String(error));
    }));
  }
  return response;
});
