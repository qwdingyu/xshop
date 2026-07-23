/**
 * 安全工具模块 — 提供 SHA-256 哈希、IP 哈希、管理员认证、Turnstile 人机验证。
 *
 * sha256 / constantTimeEqual / getIpHash 从 @usethink/cf-core 复用。
 * getBearerToken / requireAdmin / verifyTurnstile 因项目专属类型或业务逻辑保留本地。
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../bindings";
import { fail } from "./http";

import {
  sha256,
  constantTimeEqual,
  getIpHash,
} from "@usethink/cf-core";
import { readRuntimeConfig } from "./runtime-config";

export {
  sha256,
  constantTimeEqual,
  getIpHash,
};

/**
 * 从 Authorization 请求头中提取 Bearer Token。
 * 格式：Authorization: Bearer <token>
 * 不匹配格式或无请求头时返回空字符串。
 *
 * 类型包装：cf-core 版本接受 Context<any>，此处包装为 AppEnv 类型。
 */
export function getBearerToken(c: Context<AppEnv>): string {
  const auth = c.req.header("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function isAuthorizedSmokeRequest(
  c: Context<AppEnv>,
  dbConfig?: { allowTurnstileBypassForSmoke?: boolean },
): boolean {
  const enabled = dbConfig?.allowTurnstileBypassForSmoke || c.env?.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true";
  const smokeToken = c.req.header("x-smoke-admin-token") || "";
  const adminToken = c.env?.ADMIN_TOKEN || "";
  return Boolean(enabled && smokeToken && adminToken && constantTimeEqual(smokeToken, adminToken));
}

/**
 * Hono 中间件：管理员身份验证。
 *
 * 验证流程：
 * 1. 检查 ADMIN_TOKEN 是否已配置，未配置返回 503
 * 2. 安全检查：如果 ADMIN_TOKEN 仍是开发默认值且请求来自非本地地址，拒绝（防止生产环境泄露）
 * 3. 提取请求中的 Bearer Token
 * 4. 使用时序安全比较（constantTimeEqual）验证 Token，防止时序攻击
 */
export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return fail(c, "ADMIN_TOKEN 未配置", 503);
  // 生产环境安全检查：开发默认 Token 只能在本地使用
  const hostname = new URL(c.req.url).hostname;
  if (expected === "dev-only-change-me" && !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    return fail(c, "生产环境必须通过 wrangler secret 配置 ADMIN_TOKEN", 503);
  }
  const actual = getBearerToken(c);
  if (!actual) return fail(c, "未授权", 401);
  // 时序安全比较：防止通过响应时间差异推断 token 字符
  if (!constantTimeEqual(expected, actual)) return fail(c, "未授权", 401);
  await next();
}

/**
 * Cloudflare Turnstile 人机验证。
 *
 * 将前端提交的 Turnstile token 发送到 Cloudflare 验证端点。
 * 仅在 Turnstile 开关开启时执行强制校验；关闭时统一跳过。
 * 开启后若缺少 Secret Key，则视为配置不完整并拒绝请求。
 *
 * 远程 smoke 如需绕过，必须同时满足：
 * 1. ALLOW_TURNSTILE_BYPASS_FOR_SMOKE=true
 * 2. 请求头 x-smoke-admin-token 与 ADMIN_TOKEN 时序安全匹配
 *
 * @param c - Hono 上下文
 * @param token - 前端 Turnstile widget 返回的 token
 * @param dbConfig - 可选运行时配置，优先于 c.env
 * @returns 验证结果 { ok: boolean, message?: string, status?: number, smokeSkipped?: boolean }
 */
export async function verifyTurnstile(
  c: Context<AppEnv>,
  token?: string,
  dbConfig?: {
    turnstileEnabled?: boolean;
    turnstileSecretKey?: string;
    allowTurnstileBypassForSmoke?: boolean;
  },
) {
  const enabled = dbConfig?.turnstileEnabled === true;
  if (!enabled) return { ok: true };

  const secret = dbConfig?.turnstileSecretKey || c.env?.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: false, status: 503, message: "Turnstile 已启用，但后端 Secret Key 未配置" };
  }

  if (!token) {
    if (isAuthorizedSmokeRequest(c, dbConfig)) {
      return { ok: true, smokeSkipped: true };
    }
    return { ok: false, status: 403, message: "请完成人机验证" };
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = c.req.header("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });
  const data = await response.json<{ success?: boolean; "error-codes"?: string[] }>();
  if (!data.success) {
    console.warn("Turnstile verification failed", {
      cfRay: c.req.header("cf-ray") || null,
      ip: ip || null,
      errorCodes: data["error-codes"] || []
    });
    return { ok: false, status: 403, message: "Turnstile 校验失败" };
  }
  return { ok: true };
}
