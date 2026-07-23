import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { ok, getDb } from "../lib/http";
import { systemConfig } from "../db/schema";
import { inArray } from "drizzle-orm";
import { PUBLIC_SYSTEM_CONFIG_KEYS, buildSystemConfigMap } from "../lib/system-config-registry";

/**
 * 公共系统配置接口——无需鉴权，用户端读取热生效参数。
 *
 * 设计原则：
 * - 只返回 white-list 的公开参数，不泄漏敏感数据。
 * - 配置开关直接读取数据库，保证所有 Cloudflare 数据中心立即看到最新值。
 * - 响应禁止浏览器缓存；支付弹窗会在使用前主动刷新公开配置。
 * - 使用 Drizzle ORM 查询，避免原始 SQL。
 */
export const systemConfigRoute = new Hono<AppEnv>();

systemConfigRoute.get("/system-config", async (c) => {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  const db = getDb(c);
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(inArray(systemConfig.key, PUBLIC_SYSTEM_CONFIG_KEYS));

  const config = buildSystemConfigMap(rows, PUBLIC_SYSTEM_CONFIG_KEYS);
  if (!config.turnstile_site_key && c.env?.TURNSTILE_SITE_KEY) {
    config.turnstile_site_key = c.env.TURNSTILE_SITE_KEY;
  }
  
  return ok(c, { config });
});
