import https from "node:https";
import http from "node:http";
import { randomUUID } from "node:crypto";

export const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8790";
export const resolveIp = process.env.RESOLVE_IP;

export function newIdempotencyKey() {
  return randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(raw);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

function msUntilNextFixedWindow(attempt) {
  const now = Date.now();
  const nextMinute = Math.ceil(now / 60_000) * 60_000;
  // 后端管理端限流是 60 秒固定窗口；没有 Retry-After 时等待到下一分钟后再重试。
  // 额外 buffer 用来吸收 GitHub Runner 与 Worker 之间的轻微时钟差。
  return Math.max(1_500, nextMinute - now + 1_500 + attempt * 1_000);
}

export async function request(path, options = {}) {
  const retry429 = options.retry429 !== false;
  const max429Retries = Number.isFinite(Number(options.max429Retries))
    ? Math.max(0, Math.trunc(Number(options.max429Retries)))
    : 2;

  for (let attempt = 0; attempt <= max429Retries; attempt += 1) {
    const response = await textRequest(path, options);
    let data;
    try {
      data = response.raw ? JSON.parse(response.raw) : {};
    } catch {
      throw new Error(`${path} returned non-json: ${response.raw.slice(0, 200)}`);
    }
    if (response.statusCode === 429 && retry429 && attempt < max429Retries) {
      const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"]);
      const delayMs = retryAfterMs > 0 ? retryAfterMs : msUntilNextFixedWindow(attempt);
      console.warn(`${path} hit HTTP 429; retrying in ${Math.ceil(delayMs / 1000)}s (${attempt + 1}/${max429Retries})`);
      await sleep(delayMs);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`${path} failed: HTTP ${response.statusCode} ${JSON.stringify(data)}`);
    }
    return data;
  }

  throw new Error(`${path} failed: exhausted HTTP 429 retries`);
}

export async function textRequest(path, options = {}) {
  const url = new URL(path, baseUrl);
  const payload = options.body;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: resolveIp || url.hostname,
        servername: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || "GET",
        headers: {
          host: url.host,
          "content-type": "application/json",
          ...(process.env.ADMIN_TOKEN ? { "x-smoke-admin-token": process.env.ADMIN_TOKEN } : {}),
          ...(options.headers || {}),
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            raw,
            statusCode: res.statusCode || 0,
            headers: res.headers,
            url: url.toString()
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
