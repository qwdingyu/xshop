import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";
import { baseUrl, request } from "./http-client.mjs";
import { launchModeDescription, normalizeLaunchMode, shouldFailLaunchGate } from "./launch-gate.mjs";
import { signJwt } from "@usethink/cf-core/auth/jwt";

/*
 * eshop 公开上线门禁。
 *
 * 用途：
 * - 区分“本地交付可构建”和“远程生产可上线”。
 * - 默认按公开正式上线模式执行：任何 WARN 都会导致失败。
 * - 如果只是受控试运营验收，必须显式设置 LAUNCH_MODE=trial。
 * - 串联远程 health、只读/管理/写入 smoke、Turnstile 强制校验、
 *   支付渠道、邮件发送和备份准备状态。
 *
 * 必填环境变量：
 * - BASE_URL：生产 Worker 地址，默认 localhost 只允许 ALLOW_LOCAL_LAUNCH_VERIFY=true。
 * - ADMIN_TOKEN：生产 Worker 管理 token。
 * - TURSO_URL + TURSO_TOKEN。
 * - TURNSTILE_SECRET_KEY：公开站点必须配置。
 * - CREDENTIALS_ENCRYPTION_KEY：支付配置加密密钥，64 位 hex。
 * - LAUNCH_MODE：public（默认，严格）或 trial（允许显式豁免警告）。
 *
 * 邮件门禁：
 * - 邮件凭据可来自 Worker Secrets 或后台系统配置；默认要求 LAUNCH_TEST_EMAIL_TO，并通过远程接口真实发送测试邮件。
 * - 显式设置 LAUNCH_SKIP_EMAIL=true 可跳过邮件门禁，但会输出警告。
 *
 * 支付门禁：
 * - 默认要求管理端已启用至少一个支付渠道。
 * - 如果生产使用 wrangler secret 配置 provider，需要显式设置 LAUNCH_ACK_ENV_PAYMENT_READY=true。
 * - 显式设置 LAUNCH_ALLOW_OFFLINE_ONLY=true 可允许只用线下收款试运营。
 *
 * 备份门禁：
 * - LAUNCH_RUN_BACKUP=true 会实际执行 Turso 加密快照备份；除现有 TURSO_URL/TURSO_TOKEN 外，还需 TURSO_API_TOKEN、TURSO_DB_NAME、BACKUP_ENCRYPTION_PASSPHRASE。
 * - 或设置 LAUNCH_ACK_BACKUP_READY=true 表示已在外部完成备份验证。
 *
 * 注意：
 * - 本脚本会执行 smoke:admin 和 smoke:write，会创建 smoke 商品/订单并消耗测试卡密。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(projectRoot);

const checks = [];

function pass(label, detail = "") {
  checks.push({ status: "PASS", label, detail });
}

function warn(label, detail = "") {
  checks.push({ status: "WARN", label, detail });
}

function fail(label, detail = "") {
  checks.push({ status: "FAIL", label, detail });
}

function isTrue(name) {
  return process.env[name] === "true";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  if (!process.env[name]) {
    fail(`缺少环境变量 ${name}`);
    return false;
  }
  pass(`环境变量 ${name} 已提供`);
  return true;
}

function runNodeScript(script, label) {
  execFileSync(process.execPath, [script], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  pass(label);
}

async function resolveRemoteAdminToken() {
  if (!process.env.TURSO_TOKEN || !process.env.TG_OWNER_ID) return process.env.ADMIN_TOKEN || "";
  try {
    const jwt = await signJwt(process.env.TG_OWNER_ID, "", process.env.TURSO_TOKEN, 60);
    const response = await textRequestWithoutSmoke("/api/admin/verify-jwt", {
      method: "POST",
      body: JSON.stringify({ jwt }),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return process.env.ADMIN_TOKEN || "";
    const data = JSON.parse(response.raw || "{}");
    return data.adminToken || process.env.ADMIN_TOKEN || "";
  } catch {
    return process.env.ADMIN_TOKEN || "";
  }
}

function runNodeScriptWithAdminToken(script, label, adminToken) {
  execFileSync(process.execPath, [script], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ADMIN_TOKEN: adminToken || process.env.ADMIN_TOKEN || "",
    },
  });
  pass(label);
}

async function textRequestWithoutSmoke(path, options = {}) {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const payload = options.body;

  return new Promise((resolveResult, reject) => {
    const req = transport.request(
      {
        hostname: process.env.RESOLVE_IP || url.hostname,
        servername: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || "GET",
        headers: {
          host: url.host,
          "content-type": "application/json",
          ...(options.headers || {}),
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolveResult({ raw, statusCode: res.statusCode || 0, headers: res.headers });
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function checkRemoteHealth() {
  const health = await request("/api/health");
  if (health.service !== "eshop") {
    fail("远程 health 服务名异常", JSON.stringify(health));
    return;
  }
  if (health.storage !== "turso") {
    fail("远程数据库引擎不是 Turso/libSQL", `storage=${health.storage}`);
    return;
  }
  if (health.error) {
    fail("远程 health 带有数据库错误", String(health.error));
    return;
  }
  if (health.database && health.database !== "ok") {
    fail("远程数据库健康状态异常", `database=${health.database}`);
    return;
  }
  pass("远程 health 通过", `storage=${health.storage}`);
}

async function checkTurnstileStrictness() {
  if (isTrue("LAUNCH_SKIP_TURNSTILE")) {
    warn("已显式跳过 Turnstile 上线门禁", "公开售卖前不建议跳过");
    return;
  }
  // Turnstile Secret Key 可在 admin 后台系统配置中设置，不是环境变量硬要求
  if (!process.env.TURNSTILE_SECRET_KEY) {
    warn("缺少 TURNSTILE_SECRET_KEY", "请在部署后通过 admin 后台系统配置设置");
    return;
  }
  const response = await textRequestWithoutSmoke("/api/vouchers/redeem", {
    method: "POST",
    body: JSON.stringify({ code: "launch-check-invalid", email: "launch-check@example.test" }),
  });
  if (response.statusCode !== 403) {
    fail("Turnstile 缺 token 未被拒绝", `HTTP ${response.statusCode}`);
    return;
  }
  pass("Turnstile 生产强制校验通过", "缺 token 的充值码兑换返回 403");
}

async function checkPaymentReadiness(adminHeaders) {
  if (isTrue("LAUNCH_ALLOW_OFFLINE_ONLY")) {
    warn("已允许线下收款试运营", "线上支付正式开放前仍需完成 provider 小额回调验收");
    return;
  }

  const data = await request("/api/admin/payment/providers", { headers: adminHeaders });
  const online = Array.isArray(data.providers)
    ? data.providers.filter((provider) => provider.configured && provider.enabled)
    : [];
  if (online.length === 0) {
    if (isTrue("LAUNCH_ACK_ENV_PAYMENT_READY")) {
      pass("已确认生产环境使用 wrangler secret 配置支付渠道", "LAUNCH_ACK_ENV_PAYMENT_READY=true");
      return;
    }
    fail("未发现管理端已启用的线上支付渠道", "可在管理端配置 provider；若使用 wrangler secret 配置支付，设置 LAUNCH_ACK_ENV_PAYMENT_READY=true；线下试运营设置 LAUNCH_ALLOW_OFFLINE_ONLY=true");
    return;
  }
  pass("线上支付渠道已启用", online.map((provider) => provider.name).join(", "));
}

async function checkPaymentSecretReadiness(adminHeaders) {
  const response = await textRequestWithoutSmoke("/api/admin/payment/health", { headers: adminHeaders });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    fail("支付配置加密密钥远程检查失败", `HTTP ${response.statusCode}`);
    return;
  }
  let data;
  try {
    data = JSON.parse(response.raw || "{}");
  } catch {
    fail("支付配置加密密钥远程检查失败", "/api/admin/payment/health 返回非 JSON");
    return;
  }
  const status = data.credentialsEncryptionKey || {};
  if (!status.valid) {
    fail("生产 CREDENTIALS_ENCRYPTION_KEY 未配置或格式无效", `configured=${!!status.configured}, valid=${!!status.valid}`);
    return;
  }
  pass("生产 CREDENTIALS_ENCRYPTION_KEY 远程检查通过");
}

async function checkEmailReadiness(adminHeaders) {
  if (isTrue("LAUNCH_SKIP_EMAIL")) {
    warn("已显式跳过邮件门禁", "余额查询、余额支付、精确查单和 email_only 商品将不可用；公开上线前必须完成真实发信验证");
    return;
  }
  const to = process.env.LAUNCH_TEST_EMAIL_TO;
  if (!to) {
    warn("缺少 LAUNCH_TEST_EMAIL_TO", "上线门禁需要通过远程运行时配置真实发送一封测试邮件，未提供时跳过");
    return;
  }

  const data = await request("/api/admin/test-email", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ to }),
  });
  if (!data.ok) {
    fail("测试邮件发送失败", JSON.stringify(data));
    return;
  }
  pass("远程运行时邮件配置可用", data.resendId ? `resendId=${data.resendId}` : to);
}

function checkBackupReadiness() {
  if (isTrue("LAUNCH_RUN_BACKUP")) {
    execFileSync("bash", ["scripts/12-ops-maintenance.sh", "backup-remote"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
      },
    });
    pass("Turso 加密快照备份命令已跑通");
    return;
  }
  if (isTrue("LAUNCH_ACK_BACKUP_READY")) {
    pass("备份准备状态已确认", "LAUNCH_ACK_BACKUP_READY=true");
    return;
  }
  fail("缺少备份上线门禁", "设置 LAUNCH_RUN_BACKUP=true 跑一次备份，或 LAUNCH_ACK_BACKUP_READY=true 确认已外部验证");
}

async function checkStorefrontCleanliness() {
  let lastSmokeProducts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await textRequestWithoutSmoke("/api/products");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      fail("前台商品清洁度检查失败", `HTTP ${response.statusCode}`);
      return;
    }
    let data;
    try {
      data = JSON.parse(response.raw || "{}");
    } catch {
      fail("前台商品清洁度检查失败", "/api/products 返回非 JSON");
      return;
    }
    const products = Array.isArray(data.products) ? data.products : [];
    lastSmokeProducts = products.filter((product) => /(^|-)smoke-/.test(String(product.id || "")));
    if (lastSmokeProducts.length === 0) {
      pass("前台 smoke 测试商品清理通过", `activeSmokeProducts=0, attempts=${attempt}`);
      return;
    }
    if (attempt < 5) await sleep(500);
  }
  fail("前台仍存在 smoke 测试商品", lastSmokeProducts.map((product) => product.id).join(", "));
}

async function checkStorefrontCatalogReadiness() {
  const response = await textRequestWithoutSmoke("/api/products");
  if (response.statusCode < 200 || response.statusCode >= 300) {
    fail("前台商品目录上线检查失败", `HTTP ${response.statusCode}`);
    return;
  }
  let data;
  try {
    data = JSON.parse(response.raw || "{}");
  } catch {
    fail("前台商品目录上线检查失败", "/api/products 返回非 JSON");
    return;
  }
  const products = Array.isArray(data.products) ? data.products : [];
  if (products.length === 0) {
    if (isTrue("LAUNCH_ALLOW_EMPTY_CATALOG")) {
      warn("已允许空商品目录上线", "LAUNCH_ALLOW_EMPTY_CATALOG=true；正式售卖前必须上架至少一个可售商品");
      return;
    }
    fail("前台没有任何上架商品", "正式上线前必须至少有一个真实商品；临时空壳部署需显式设置 LAUNCH_ALLOW_EMPTY_CATALOG=true");
    return;
  }
  const salableProducts = products.filter((product) => Number(product.stock || 0) > 0);
  if (salableProducts.length === 0) {
    fail("前台没有可售库存商品", `activeProducts=${products.length}, salableProducts=0`);
    return;
  }
  const invalidProducts = products.filter((product) => !product.id || !product.title || !Number.isFinite(Number(product.priceCents)) || !product.currency);
  if (invalidProducts.length > 0) {
    fail("前台商品基础字段不完整", invalidProducts.map((product) => product.id || "<missing-id>").join(", "));
    return;
  }
  pass("前台商品目录上线检查通过", `activeProducts=${products.length}, salableProducts=${salableProducts.length}`);
}

async function main() {
  const launchMode = normalizeLaunchMode(process.env.LAUNCH_MODE);
  console.log(`cf-shop launch verification: ${baseUrl}`);
  console.log(launchModeDescription(launchMode));

  const url = new URL(baseUrl);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!isTrue("ALLOW_LOCAL_LAUNCH_VERIFY") && isLocal) {
    fail("BASE_URL 仍是本地地址", "公开上线门禁必须指向真实 Worker；本地调试请设置 ALLOW_LOCAL_LAUNCH_VERIFY=true");
  } else {
    pass("BASE_URL 已设置", baseUrl);
  }
  if (!isTrue("ALLOW_LOCAL_LAUNCH_VERIFY") && url.protocol !== "https:") {
    fail("BASE_URL 不是 HTTPS", "公开站点必须通过 HTTPS 验收");
  } else {
    pass("BASE_URL 协议检查通过", url.protocol);
  }

  requireEnv("ADMIN_TOKEN");
  requireEnv("TURSO_URL");
  requireEnv("TURSO_TOKEN");

  const remoteAdminToken = await resolveRemoteAdminToken();
  if (remoteAdminToken && remoteAdminToken !== process.env.ADMIN_TOKEN) {
    pass("已通过远程 JWT 换取生产 ADMIN_TOKEN", "仅用于本次上线门禁，不输出密钥");
  }
  const adminHeaders = { authorization: `Bearer ${remoteAdminToken || process.env.ADMIN_TOKEN || ""}` };

  try {
    await checkRemoteHealth();
  } catch (error) {
    fail("远程 health 检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    await checkTurnstileStrictness();
  } catch (error) {
    fail("Turnstile 远程门禁检查失败", error instanceof Error ? error.message : String(error));
  }

  const smokeScripts = [
    ["scripts/26-smoke-frontend-assets.mjs", "前端部署资产完整性 smoke 通过"],
    ["scripts/04-smoke-readonly.mjs", "只读 smoke 通过"],
    ["scripts/05-smoke-admin.mjs", "管理端 smoke 通过"],
    ["scripts/06-smoke-write.mjs", "写入/发卡 smoke 通过"],
    ["scripts/20-smoke-legacy-guards.mjs", "旧入口禁用 smoke 通过"],
    ["scripts/21-smoke-inventory-closure.mjs", "库存闭环 smoke 通过"],
    ["scripts/18-smoke-catalog-admin.mjs", "目录/自动编号 smoke 通过"],
    ["scripts/19-smoke-ops-crud.mjs", "后台运营 CRUD smoke 通过"],
  ];

  for (let index = 0; index < smokeScripts.length; index += 1) {
    const [script, label] = smokeScripts[index];
    try {
      if (script === "scripts/26-smoke-frontend-assets.mjs") runNodeScript(script, label);
      else runNodeScriptWithAdminToken(script, label, remoteAdminToken);
      if (script === "scripts/06-smoke-write.mjs" || script === "scripts/21-smoke-inventory-closure.mjs") {
        warn("写入 smoke 限流冷却", "已完成高强度库存闭环验证，等待 65 秒避免后续运营 smoke 被 pay_unified 每分钟限流误伤");
        await sleep(65_000);
      }
    } catch (error) {
      fail(`${label}失败`, error instanceof Error ? error.message : String(error));
    }
  }

  try {
    await checkStorefrontCleanliness();
  } catch (error) {
    fail("前台商品清洁度检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    await checkStorefrontCatalogReadiness();
  } catch (error) {
    fail("前台商品目录上线检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    await checkPaymentReadiness(adminHeaders);
  } catch (error) {
    fail("支付上线门禁检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    await checkPaymentSecretReadiness(adminHeaders);
  } catch (error) {
    fail("支付配置加密密钥远程检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    await checkEmailReadiness(adminHeaders);
  } catch (error) {
    fail("邮件上线门禁检查失败", error instanceof Error ? error.message : String(error));
  }

  try {
    checkBackupReadiness();
  } catch (error) {
    fail("备份上线门禁检查失败", error instanceof Error ? error.message : String(error));
  }

  console.log("\n上线门禁结果：");
  for (const item of checks) {
    const suffix = item.detail ? ` — ${item.detail}` : "";
    console.log(`[${item.status}] ${item.label}${suffix}`);
  }

  const failures = checks.filter((item) => item.status === "FAIL");
  const warnings = checks.filter((item) => item.status === "WARN");
  console.log(`\n汇总：${failures.length} 个失败，${warnings.length} 个警告；模式=${launchMode}。`);
  if (shouldFailLaunchGate({ failures: failures.length, warnings: warnings.length, mode: launchMode })) {
    if (failures.length === 0 && warnings.length > 0 && launchMode === "public") {
      console.error("公开正式上线模式不允许警告；若只是受控试运营，请显式设置 LAUNCH_MODE=trial 并保留验收记录。");
    }
    process.exit(1);
  }
}

await main();
