import { Hono } from "hono";
import { initDatabase } from "./db/database";
import type { AppEnv } from "./bindings";
import { fail } from "./lib/http";
import { requireAdmin } from "./lib/security";
import { cleanupExpiredOrders } from "./services/cleanup-service";
import { healthRoute } from "./routes/health";
import { productRoute } from "./routes/products";
import { orderRoute } from "./routes/orders";
import { payRoute } from "./routes/pay";
import { adminRoute, adminPublicRoute } from "./routes/admin";
import { systemConfigRoute } from "./routes/system-config";
import { redeemRoute } from "./routes/redeem";
import { voucherRoute } from "./routes/vouchers";
import { rechargeRoute } from "./routes/recharge";
import { emailAccessRoute } from "./routes/email-access";
import { tgBot } from "./telegram-bot";
import { mediaRoute } from "./routes/media";
import { getApiBodyLimitBytes } from "./lib/api-body-limit";
import { MEDIA_IMAGE_CACHE_CONTROL } from "./lib/media-image";

const api = new Hono<AppEnv>();

/** API 响应统一禁止浏览器、CDN 和反向代理缓存。订单、余额、库存、支付状态及管理数据
 * 都是动态共享状态，不能依赖调用方逐个设置响应头来保证新鲜度。 */
export function withApiNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 只有成功的不可变公开媒体响应允许缓存；媒体错误响应仍必须 no-store。 */
export function shouldApplyApiNoStore(path: string, response?: Response): boolean {
  if (!path.startsWith("/media/images/")) return true;
  return !(response?.status === 200 && response.headers.get("Cache-Control") === MEDIA_IMAGE_CACHE_CONTROL);
}

// 数据库初始化中间件：创建 libsql client + Drizzle ORM 实例，存入 Hono Context
// - DB 可用时：c.set("db", orm)，所有路由正常使用
// - DB 不可用时：health 路由 c.set("db", undefined) 自行降级；其他路由直接 503
// - 同时注入 executionCtx，供服务层使用 ctx.waitUntil() 异步发邮件（节省 CPU）
api.use("*", async (c, next) => {
  const isHealth = c.req.path === "/health";
  const isPublicMedia = c.req.path.startsWith("/media/images/");
  const executionCtx = c.executionCtx as ExecutionContext<unknown>;

  // 公开图片只依赖 R2。跳过 Turso 初始化可减少每次图片读取开销，并保证数据库故障时静态图片仍可用。
  if (isPublicMedia) {
    c.set("db", undefined);
    c.set("executionCtx", executionCtx);
    await next();
    return;
  }

  try {
    const { db } = initDatabase({ TURSO_URL: c.env.TURSO_URL, TURSO_TOKEN: c.env.TURSO_TOKEN });
    c.set("db", db);
    c.set("executionCtx", executionCtx);
    await next();
  } catch (err) {
    console.error("[db-init]", err);
    if (isHealth) { c.set("db", undefined); c.set("executionCtx", executionCtx); await next(); return; }
    return fail(c, "服务暂时不可用", 503);
  }
});

// 全局请求体限制：普通 API 保持 100KB；只有管理端图片上传允许 5MiB + multipart 开销。
api.use(async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0");
  const maxBytes = getApiBodyLimitBytes(c.req.path);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return fail(c, c.req.path === "/admin/media/images" ? "图片上传请求过大（图片最大 5MiB）" : "请求体过大（最大 100KB）", 413);
  }
  await next();
});

api.route("/", healthRoute);
api.route("/", productRoute);
api.route("/", orderRoute);
api.route("/", systemConfigRoute);
api.route("/", payRoute);
api.route("/", redeemRoute);
api.route("/", voucherRoute);
api.route("/", rechargeRoute);
api.route("/", emailAccessRoute);
api.route("/", mediaRoute);
// 公开 admin 路由（无需 ADMIN_TOKEN），在 requireAdmin 之前挂载
api.route("/admin", adminPublicRoute);
api.route("/admin", new Hono<AppEnv>().use("*", requireAdmin).route("/", adminRoute));

api.notFound((c) => fail(c, "API not found", 404));

api.onError((error, c) => {
  console.error("[onError]", error?.constructor?.name, error?.message, error?.stack);
  return fail(c, "服务暂时不可用", 500);
});

export default {
  async fetch(request: Request, env: AppEnv["Bindings"], ctx: ExecutionContext<unknown>) {
    let isApiRequest = false;
    let isDynamicRequest = false;
    try {
      const url = new URL(request.url);
      isApiRequest = url.pathname === "/api" || url.pathname.startsWith("/api/");
      isDynamicRequest = isApiRequest || url.pathname === "/tg" || url.pathname.startsWith("/tg/");
      // 全局安全响应头
      const responseHeaders = new Headers({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      // 用户端页面允许 Element Plus CDN 资源 + Telegram WebApp SDK
      // admin 页面用 Vue UMD 构建（vue.global.prod.js），内部 new Function() 编译模板，需要 unsafe-eval
      const isAdmin = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
      const csp = [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://unpkg.com",
        `script-src 'self' 'unsafe-inline'${isAdmin ? " 'unsafe-eval'" : ""} https://unpkg.com https://static.cloudflareinsights.com https://challenges.cloudflare.com https://telegram.org`,
        "img-src 'self' data: https:",
        "connect-src 'self' https://unpkg.com https://challenges.cloudflare.com",
        "frame-src 'self' https://challenges.cloudflare.com",
        "object-src 'none'",
        "base-uri 'self'",
      ].join("; ");
      responseHeaders.set("Content-Security-Policy", csp);

      // 给静态资源响应附加安全头（API 响应由 Hono 内置处理）
      type AssetCachePolicy = "preserve" | "immutable" | "entry";
      async function withHeaders(response: Response, cachePolicy: AssetCachePolicy = "preserve") {
        const headers = new Headers(response.headers);
        for (const [key, value] of responseHeaders) {
          headers.set(key, value);
        }
        // Vite 构建的 hash 文件设置长缓存（1 年），节省 Workers 请求配额
        // 只有成功返回的 hash 资源才允许长期缓存。若把 404 也标记为 immutable，
        // 浏览器会长期记住一次发布缺口，即使资源随后恢复也可能继续使用失败响应。
        if (cachePolicy === "immutable" && response.ok && url.pathname.startsWith("/_app/assets/")) {
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
        } else if (cachePolicy === "immutable") {
          headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
        }
        // SPA 入口必须每次重新验证；否则旧入口引用的 lazy chunk 在新部署清理后会永久 404。
        if (cachePolicy === "entry") {
          headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
          headers.set("Pragma", "no-cache");
          headers.set("Expires", "0");
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // ── Telegram Bot 路由（优先于 API，占用 /tg/* 命名空间）──
      // 自建 Hono 子应用，自管理 DB 连接和限流，不与主 API 共享中间件
      if (url.pathname === "/tg" || url.pathname.startsWith("/tg/")) {
        url.pathname = url.pathname.replace(/^\/tg/, "") || "/";
        return withApiNoStore(await tgBot.fetch(new Request(url, request), env, ctx));
      }

      // API 统一挂在 /api 下，进入 Hono 前去掉 /api 前缀，避免页面路径和接口路径混在一起。
      if (isApiRequest) {
        url.pathname = url.pathname.replace(/^\/api/, "") || "/";
        const response = await api.fetch(new Request(url, request), env, ctx);
        return shouldApplyApiNoStore(url.pathname, response) ? withApiNoStore(response) : response;
      }
      // ── Vue 单页应用入口 ──
      // 未上线阶段不保留旧 public/index.html/admin.html 兜底，避免新版用户端和 admin 后台代码被绕开。
      const isPageRoute =
        url.pathname === "/" ||
        url.pathname === "/shop" ||
        url.pathname.startsWith("/s/") ||
        url.pathname === "/redeem" ||
        url.pathname === "/lookup" ||
        url.pathname === "/order" ||
        url.pathname === "/admin" ||
        url.pathname.startsWith("/admin/") ||
        (url.pathname.startsWith("/_app/") && !url.pathname.startsWith("/_app/assets/"));

      if (isPageRoute) {
        const vueEntry = "/_app/index.html";
        const vueRes = await env.ASSETS.fetch(new Request(new URL(vueEntry, request.url), request));
        if (vueRes.ok) {
          return withHeaders(vueRes, "entry");
        }
        return withHeaders(
          new Response("Frontend assets are missing. Run npm run frontend:build before deploy.", { status: 503 }),
          "entry",
        );
      }

      // Vue3 静态资源（/_app/assets/*）— 设置长缓存，节省 Workers 请求配额
      if (url.pathname.startsWith("/_app/")) {
        return withHeaders(await env.ASSETS.fetch(request), "immutable");
      }

      // 其他静态资源交给 Static Assets。
      return withHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("[fetch]", err);
      const response = new Response(JSON.stringify({ ok: false, error: "服务暂时不可用" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
      return isDynamicRequest ? withApiNoStore(response) : response;
    }
  },

  /**
   * Cron Trigger 未启用 — Free 版支持 Cron 但仅 10ms CPU 时间，
   * cleanup 逻辑含多条 SQL + 邮件发送，CPU 不足。
   * 替代方案：GitHub Actions 定时调用 /admin/cleanup 接口。
   * 见 .github/workflows/cleanup-schedule.yml
   */
};
