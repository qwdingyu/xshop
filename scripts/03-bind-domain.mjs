#!/usr/bin/env node

/*
 * Cloudflare Workers 自定义域名脚本契约。
 *
 * 必填意图：
 * - CF_CUSTOM_DOMAIN 是要绑定的目标域名，例如 auth.eforge.xyz。
 * - 必须直接提供 CF_WORKER_SERVICE，或通过 CF_SOURCE_CUSTOM_DOMAIN 从已有绑定推导。
 * - 鉴权统一使用最小权限的 CLOUDFLARE_API_TOKEN。
 *
 * 核心不变量：
 * - Workers Custom Domains 不是 Pages CNAME 记录，不能混用 Pages 域名流程。
 * - Cloudflare 会为 Worker hostname 自动创建 DNS 记录和证书。
 * - 默认行为是增量绑定：绑定新域名，保留源域名。
 * - 删除源域名必须同时设置 CF_DELETE_SOURCE_CUSTOM_DOMAIN=true
 *   和 CF_REPLACE_CONFIRM="<源域名>-><目标域名>"。
 *
 * 必填环境变量：
 * - CF_CUSTOM_DOMAIN：要绑定到 Worker 的目标域名，例如 auth.eforge.xyz。
 * - Worker service 二选一：
 *   1. CF_WORKER_SERVICE：Worker 服务名，例如 eshop。
 *   2. CF_SOURCE_CUSTOM_DOMAIN：已有 Workers Custom Domain，脚本从它推导 Worker service。
 * - CLOUDFLARE_API_TOKEN：具备目标账号 Workers Scripts Edit 和目标 Zone 权限的 API Token。
 *
 * 可选定位变量：
 * - CF_ACCOUNT_ID：Cloudflare account id；未提供且账号唯一时自动推导。
 * - CF_ZONE_ID：Cloudflare zone id；未提供时从 CF_CUSTOM_DOMAIN 推导 zone name 再查询。
 * - CF_ZONE_NAME：Cloudflare zone name，例如 eforge.xyz。
 * - CF_WORKER_ENVIRONMENT：Worker 环境，默认 production。
 *
 * 可选等待和替换变量：
 * - CF_WAIT_ACTIVE=false：绑定后不等待 HTTPS 可访问。
 * - CF_WAIT_ATTEMPTS=24：等待次数。
 * - CF_WAIT_INTERVAL_MS=5000：等待间隔。
 * - CF_DELETE_SOURCE_CUSTOM_DOMAIN=true：删除源域名绑定，默认不删除。
 * - CF_REPLACE_CONFIRM="<源域名>-><目标域名>"：删除源域名时必须提供的防误删确认。
 *
 * 常用命令：
 * - 直接绑定 Worker 到新域名：
 *   CLOUDFLARE_API_TOKEN="<token>" CF_WORKER_SERVICE="my-worker" CF_CUSTOM_DOMAIN="shop.example.com" node scripts/03-bind-domain.mjs
 * - 从旧域名推导 Worker 并新增新域名：
 *   CLOUDFLARE_API_TOKEN="<token>" CF_SOURCE_CUSTOM_DOMAIN="old.example.com" CF_CUSTOM_DOMAIN="new.example.com" node scripts/03-bind-domain.mjs
 * - 新增新域名并删除旧域名：
 *   CLOUDFLARE_API_TOKEN="<token>" CF_SOURCE_CUSTOM_DOMAIN="old.example.com" CF_CUSTOM_DOMAIN="new.example.com" CF_DELETE_SOURCE_CUSTOM_DOMAIN=true CF_REPLACE_CONFIRM="old.example.com->new.example.com" node scripts/03-bind-domain.mjs
 */

import https from "node:https";

const env = process.env;
const required = [
  "CF_CUSTOM_DOMAIN"
];

const missing = required.filter((key) => !env[key]);
if (missing.length > 0) {
  console.error(`Missing required env: ${missing.join(", ")}`);
  process.exit(2);
}

const config = {
  accountId: env.CF_ACCOUNT_ID,
  zoneId: env.CF_ZONE_ID,
  zoneName: env.CF_ZONE_NAME,
  service: env.CF_WORKER_SERVICE,
  domain: env.CF_CUSTOM_DOMAIN,
  environment: env.CF_WORKER_ENVIRONMENT || "production",
  sourceDomain: env.CF_SOURCE_CUSTOM_DOMAIN,
  deleteSourceDomain: env.CF_DELETE_SOURCE_CUSTOM_DOMAIN === "true",
  replaceConfirm: env.CF_REPLACE_CONFIRM,
  waitActive: env.CF_WAIT_ACTIVE !== "false",
  waitAttempts: Number.parseInt(env.CF_WAIT_ATTEMPTS || "24", 10),
  waitIntervalMs: Number.parseInt(env.CF_WAIT_INTERVAL_MS || "5000", 10)
};

function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        path,
        method,
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error(`Invalid JSON from Cloudflare ${method} ${path}: ${raw}`));
            return;
          }
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders() {
  if (env.CLOUDFLARE_API_TOKEN) {
    return { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  }
  throw new Error("Missing auth: set CLOUDFLARE_API_TOKEN");
}

function assertSuccess(response, label) {
  if (response.json?.success) return response.json;
  throw new Error(`${label} failed: HTTP ${response.statusCode} ${JSON.stringify(response.json?.errors || response.json)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferZoneName(domain) {
  if (config.zoneName) return config.zoneName;

  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) {
    throw new Error(`Cannot infer zone from invalid domain: ${domain}`);
  }

  config.zoneName = labels.slice(-2).join(".");
  return config.zoneName;
}

async function resolveAccountId() {
  if (config.accountId) return config.accountId;

  const accounts = assertSuccess(
    await request("GET", "/client/v4/accounts"),
    "List accounts"
  ).result || [];

  if (accounts.length === 1) {
    config.accountId = accounts[0].id;
    console.log(`Inferred account: ${accounts[0].name} (${config.accountId})`);
    return config.accountId;
  }

  const names = accounts.map((account) => `${account.name} (${account.id})`).join(", ");
  throw new Error(`Multiple or zero Cloudflare accounts found; set CF_ACCOUNT_ID. Accounts: ${names}`);
}

async function resolveZoneId() {
  if (config.zoneId) return config.zoneId;

  const zoneName = inferZoneName(config.domain);
  const zones = assertSuccess(
    await request("GET", `/client/v4/zones?name=${encodeURIComponent(zoneName)}`),
    "Find zone"
  ).result || [];

  if (zones.length === 1) {
    config.zoneId = zones[0].id;
    console.log(`Inferred zone: ${zones[0].name} (${config.zoneId})`);
    return config.zoneId;
  }

  throw new Error(`Cannot infer unique zone for ${zoneName}; set CF_ZONE_ID.`);
}

async function listDomains() {
  await resolveAccountId();
  return assertSuccess(
    await request("GET", `/client/v4/accounts/${config.accountId}/workers/domains`),
    "List Workers custom domains"
  ).result || [];
}

async function resolveServiceFromSourceDomain(domains) {
  if (config.service) return;
  if (!config.sourceDomain) {
    throw new Error("Missing worker service: set CF_WORKER_SERVICE or CF_SOURCE_CUSTOM_DOMAIN");
  }

  const source = domains.find((item) => item.hostname === config.sourceDomain);
  if (!source) {
    throw new Error(`Cannot infer Worker service: source domain not found: ${config.sourceDomain}`);
  }

  config.service = source.service;
  config.environment = source.environment || config.environment;
  config.zoneId ||= source.zone_id;
  config.zoneName ||= source.zone_name;
  console.log(`Inferred Worker service from ${config.sourceDomain}: ${config.service} (${config.environment})`);
}

async function bindDomain(domains) {
  await resolveZoneId();

  const existing = domains.find((item) => item.hostname === config.domain);
  if (existing) {
    console.log(`Workers custom domain exists: ${existing.hostname} -> ${existing.service} (${existing.environment})`);
    if (existing.service !== config.service || existing.environment !== config.environment) {
      console.log("Existing binding differs; updating it with PUT.");
    } else {
      console.log("Existing binding is already correct.");
      return existing;
    }
  }

  const result = assertSuccess(
    await request("PUT", `/client/v4/accounts/${config.accountId}/workers/domains`, {
      environment: config.environment,
      hostname: config.domain,
      service: config.service,
      zone_id: config.zoneId
    }),
    "Bind Workers custom domain"
  );

  console.log(`Bound Workers custom domain: ${result.result.hostname} -> ${result.result.service}`);
  return result.result;
}

async function maybeDeleteSourceDomain(domains) {
  if (!config.deleteSourceDomain) return;

  if (!config.sourceDomain) {
    throw new Error("CF_DELETE_SOURCE_CUSTOM_DOMAIN=true requires CF_SOURCE_CUSTOM_DOMAIN");
  }

  const expectedConfirm = `${config.sourceDomain}->${config.domain}`;
  if (config.replaceConfirm !== expectedConfirm) {
    throw new Error(`Refusing to delete source domain. Set CF_REPLACE_CONFIRM="${expectedConfirm}"`);
  }

  const source = domains.find((item) => item.hostname === config.sourceDomain);
  if (!source) {
    console.log(`Source domain already absent: ${config.sourceDomain}`);
    return;
  }

  assertSuccess(
    await request("DELETE", `/client/v4/accounts/${config.accountId}/workers/domains/${source.id}`),
    "Delete source Workers custom domain"
  );
  console.log(`Deleted source Workers custom domain: ${config.sourceDomain}`);
}

async function probeHttps() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: config.domain,
        path: "/",
        method: "HEAD"
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
      }
    );

    req.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    req.end();
  });
}

async function waitForHttps() {
  if (!config.waitActive) return;

  for (let attempt = 1; attempt <= config.waitAttempts; attempt += 1) {
    const result = await probeHttps();
    const detail = result.ok ? `HTTP ${result.statusCode}` : result.error;
    console.log(`HTTPS poll ${attempt}/${config.waitAttempts}: https://${config.domain}/ -> ${detail}`);

    if (result.ok) return;
    await sleep(config.waitIntervalMs);
  }

  throw new Error(`Timed out waiting for https://${config.domain}/ to become reachable`);
}

async function main() {
  const domains = await listDomains();
  await resolveServiceFromSourceDomain(domains);
  await bindDomain(domains);
  await maybeDeleteSourceDomain(domains);
  await waitForHttps();

  console.log(`Verify with: curl -I https://${config.domain}/`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
