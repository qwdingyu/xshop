import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

/*
 * eshop 完整远程部署脚本。
 *
 * 核心职责：
 * - 默认使用 Turso/libSQL，执行远程 migration。
 * - 显式 DATABASE_PROVIDER=d1 时，兼容旧 D1 创建/迁移路径。
 * - 可选执行远程 seed。
 * - 插入默认 system_config（INSERT OR IGNORE，幂等）。
 * - 部署 Worker Static Assets + API（通过 --secrets-file 传入 Turso 和管理凭证）。
 * - 可选绑定 Workers Custom Domain。
 * - 最后运行 smoke（readonly + admin + write），证明发卡链路可用。
 *
 * 关键变量：
 * - CLOUDFLARE_API_TOKEN：Wrangler CLI 远程操作必需。
 * - APP_ORIGIN：唯一公网根地址，部署变量、域名绑定和 smoke 共用。
 * - ADMIN_TOKEN：管理后台 Token，首次登录凭证（后续可在 admin 后台修改）。
 * - TURSO_URL / TURSO_TOKEN：Turso 数据库连接，必须从环境变量传入。
 *
 * 可在 admin 后台系统配置中设置的（无需环境变量）：
 * - TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY：人机验证
 * - RESEND_API_KEY / EMAIL_FROM：邮件通知
 * - 以及其他所有 system-config-definitions.json 中的配置项
 *
 * 可选 Worker secrets（部署后用 wrangler secret put 设置，不影响首次部署）：
 * - CREDENTIALS_ENCRYPTION_KEY：支付配置加密密钥（64 位 hex），在 admin 后台配置支付渠道前必须设置
 * - RATE_LIMIT_SALT：IP 哈希盐值，不设时使用默认值
 *
 * 不变量：
 * - database_id 只能来自 wrangler d1 create 输出，不能猜。
 * - seed.sql 只能放演示数据，不能放真实卡密。
 * - system_config 使用 INSERT OR IGNORE，幂等安全。
 * - smoke 会真实消耗一条库存。
 * - secrets 通过 --secrets-file 传入 wrangler deploy，不依赖交互式命令。
 *
 * 常用命令：
 * - 完整部署但不重复 seed：
 *   CLOUDFLARE_API_TOKEN="<token>" ADMIN_TOKEN="<token>" ESHOP_SEED_REMOTE=false npm run deploy:full
 * - 部署并绑定正式域名：
 *   CLOUDFLARE_API_TOKEN="<token>" ADMIN_TOKEN="<token>" ESHOP_BIND_DOMAIN=true ESHOP_SEED_REMOTE=false npm run deploy:full
 *
 * 风险提示：
 * - 远程 seed 只适合演示数据。
 * - smoke 会真实发放一条卡密，库存不足时会失败。
 */

function readWrangler() {
  return readFileSync("wrangler.jsonc", "utf8");
}

function getWranglerWorkerName() {
  const match = readWrangler().match(/"name"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error('wrangler.jsonc 缺少 "name" 字段');
  return match[1];
}

function resolveWorkerName() {
  const wranglerName = getWranglerWorkerName();
  const requestedName = process.env.ESHOP_WORKER_NAME;
  if (requestedName && requestedName !== wranglerName) {
    throw new Error(`ESHOP_WORKER_NAME=${requestedName} 与 wrangler.jsonc name=${wranglerName} 不一致。请改 wrangler.jsonc 或移除 ESHOP_WORKER_NAME，避免部署和验证指向不同 Worker。`);
  }
  return wranglerName;
}

const workerName = resolveWorkerName();
const appOrigin = process.env.APP_ORIGIN || process.env.BASE_URL || "";
if (!appOrigin) {
  throw new Error("缺少 APP_ORIGIN：请传入实际可访问的 HTTPS 根地址");
}
const parsedAppOrigin = new URL(appOrigin);
if (parsedAppOrigin.protocol !== "https:" || parsedAppOrigin.pathname !== "/") {
  throw new Error("APP_ORIGIN 必须是 HTTPS 根地址，例如 https://shop.example.com");
}

const project = {
  workerName,
  databaseName: process.env.ESHOP_D1_DATABASE || "eshop-db",
  customDomain: process.env.ESHOP_CUSTOM_DOMAIN || parsedAppOrigin.hostname,
  appOrigin: parsedAppOrigin.origin,
  smokeUrl: parsedAppOrigin.origin,
  seedRemote: process.env.ESHOP_SEED_REMOTE !== "false",
  databaseProvider: process.env.DATABASE_PROVIDER || "turso",
};

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env || process.env
  });
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`缺少环境变量 ${name}`);
  }
}

function requireWranglerAuth() {
  if (process.env.CLOUDFLARE_API_TOKEN) return;
  try {
    run("npx", ["wrangler", "whoami"], { capture: true });
  } catch {
    throw new Error("缺少 Cloudflare 鉴权：请设置 CLOUDFLARE_API_TOKEN，或先运行 npx wrangler login");
  }
}

function getTursoUrl() {
  return process.env.TURSO_URL;
}

function getTursoToken() {
  return process.env.TURSO_TOKEN;
}

function appendSecret(lines, name, value) {
  if (value) lines.push(`${name}=${value}`);
}

function sqlString(value) {
  return String(value).replace(/'/g, "''");
}

function buildSystemConfigSeedSql() {
  const definitions = JSON.parse(readFileSync("src/lib/system-config-definitions.json", "utf8"));
  const values = definitions.map((definition) =>
    `('${sqlString(definition.key)}', '${sqlString(definition.defaultValue)}', datetime('now'))`
  );
  return `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES\n      ${values.join(",\n      ")};`;
}

function getCurrentDatabaseId() {
  const match = readWrangler().match(/"database_id"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

function setDatabaseId(databaseId) {
  const current = readWrangler();
  const next = current.replace(
    /"database_id"\s*:\s*"[^"]+"/,
    `"database_id": "${databaseId}"`
  );
  if (next === current) {
    throw new Error("没有找到 wrangler.jsonc 中的 database_id 字段");
  }
  writeFileSync("wrangler.jsonc", next);
}

function createDatabase() {
  requireEnv("CLOUDFLARE_API_TOKEN");
  const output = run("npx", ["wrangler", "d1", "create", project.databaseName], { capture: true });
  console.log(output);
  const match = output.match(/"database_id"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error("无法从 wrangler d1 create 输出中提取 database_id");
  }
  setDatabaseId(match[1]);
  console.log(`已写入 wrangler.jsonc database_id=${match[1]}`);
}

function ensureDatabaseId() {
  const current = getCurrentDatabaseId();
  if (current && current !== "REPLACE_WITH_D1_DATABASE_ID") {
    console.log(`复用已有 D1 database_id=${current}`);
    return current;
  }

  createDatabase();
  return getCurrentDatabaseId();
}

function insertSystemConfig() {
  requireEnv("CLOUDFLARE_API_TOKEN");
  console.log("\n→ 插入默认 system_config ...");
  run("npx", [
    "wrangler", "d1", "execute", project.databaseName, "--remote", "--command",
    buildSystemConfigSeedSql()
  ]);
  console.log("✅ system_config 已插入");
}

/**
 * 通过 wrangler deploy --secrets-file 传入 secrets。
 * 这是 wrangler 官方推荐方式，比 Cloudflare API 更可靠：
 * - 不需要 Worker 已存在（首次部署也适用）
 * - 不需要查脚本 ID
 * - 与 deploy 原子操作
 */
function deployWithSecrets() {
  requireWranglerAuth();
  requireEnv("ADMIN_TOKEN");
  const adminToken = process.env.ADMIN_TOKEN;
  const secrets = [];

  appendSecret(secrets, "TURSO_URL", getTursoUrl());
  appendSecret(secrets, "TURSO_TOKEN", getTursoToken());
  appendSecret(secrets, "ADMIN_TOKEN", adminToken);
  appendSecret(secrets, "RATE_LIMIT_SALT", process.env.RATE_LIMIT_SALT);
  appendSecret(secrets, "JWT_SECRET", process.env.JWT_SECRET);
  appendSecret(secrets, "CREDENTIALS_ENCRYPTION_KEY", process.env.CREDENTIALS_ENCRYPTION_KEY);
  appendSecret(secrets, "TURNSTILE_SECRET_KEY", process.env.TURNSTILE_SECRET_KEY);
  appendSecret(secrets, "RESEND_API_KEY", process.env.RESEND_API_KEY);

  if (secrets.length > 0) {
    // 创建临时 secrets 文件 (.env 格式)
    const secretsFile = ".deploy-secrets.env";
    writeFileSync(secretsFile, `${secrets.join("\n")}\n`, { mode: 0o600 });
    try {
      console.log(`\n→ 通过 --secrets-file 部署 (${secrets.length} 个 secrets) ...`);
      const deployArgs = ["wrangler", "deploy", `--secrets-file=${secretsFile}`, "--var", `APP_ORIGIN:${project.appOrigin}`];
      if (process.env.EMAIL_FROM) deployArgs.push("--var", `EMAIL_FROM:${process.env.EMAIL_FROM}`);
      run("npx", deployArgs);
    } finally {
      if (existsSync(secretsFile)) {
        writeFileSync(secretsFile, "");
        unlinkSync(secretsFile);
      }
    }
    console.log("✅ 部署完成 (secrets 已上传)");
  } else {
    console.log("\n⚠️  未设置任何 secrets，线上数据库和管理后台将不可用");
    run("npx", ["wrangler", "deploy"]);
    console.log("✅ 部署完成");
  }
}

function assertSmokePrerequisites() {
  if (!process.env.ADMIN_TOKEN) {
    throw new Error("deploy:full 会运行管理端 smoke，必须提供 ADMIN_TOKEN");
  }

  const turnstileEnabled = Boolean(process.env.TURNSTILE_SECRET_KEY);
  const hasSmokeToken = Boolean(process.env.SMOKE_TURNSTILE_TOKEN);
  const hasSmokeBypass = process.env.ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true";
  if (turnstileEnabled && !hasSmokeToken && !hasSmokeBypass) {
    throw new Error("已提供 TURNSTILE_SECRET_KEY，但远程 smoke 无法完成人机验证。请提供 SMOKE_TURNSTILE_TOKEN，或在受控上线窗口设置 ALLOW_TURNSTILE_BYPASS_FOR_SMOKE=true（请求仍需 x-smoke-admin-token 匹配 ADMIN_TOKEN）。");
  }
}

function main() {
  assertSmokePrerequisites();
  run("npm", ["run", "frontend:build"]);

  if (project.databaseProvider === "turso") {
    const tursoUrl = getTursoUrl();
    const tursoToken = getTursoToken();
    if (!tursoUrl || !tursoToken) {
      throw new Error("Turso 模式缺少 TURSO_URL/TURSO_TOKEN");
    }
    const resetTurso = process.env.RESET_TURSO === "true";
    if (resetTurso) {
      console.log("Turso 模式：重置数据库（清空重建）...");
      run("npm", ["run", "db:migrate", "--", "--reset"], {
        env: { ...process.env, TURSO_URL: tursoUrl, TURSO_TOKEN: tursoToken }
      });
    } else {
      console.log("Turso 模式：执行 libSQL 迁移");
      run("npm", ["run", "db:migrate:turso"], {
        env: { ...process.env, TURSO_URL: tursoUrl, TURSO_TOKEN: tursoToken }
      });
    }
  } else {
    ensureDatabaseId();
    run("npm", ["run", "db:migrate:remote"]);
    if (project.seedRemote) {
      run("npm", ["run", "db:seed:remote"]);
    } else {
      console.log("跳过远程 seed：ESHOP_SEED_REMOTE=false");
    }
    insertSystemConfig();
  }

  deployWithSecrets();

  if (process.env.ESHOP_BIND_DOMAIN === "true") {
    process.env.CF_WORKER_SERVICE ||= project.workerName;
    process.env.CF_CUSTOM_DOMAIN ||= project.customDomain;
    process.env.CF_WAIT_ACTIVE ||= "true";
    run("npm", ["run", "domain:bind"]);
  }

  const smokeUrl = process.env.ESHOP_BIND_DOMAIN === "true"
    ? `https://${process.env.CF_CUSTOM_DOMAIN || project.customDomain}`
    : project.smokeUrl;
  const smokeEnv = { ...process.env, BASE_URL: smokeUrl };

  console.log("\n── Smoke 测试 ──");
  run("npm", ["run", "smoke:frontend-assets"], { env: smokeEnv });
  run("npm", ["run", "smoke:admin"], { env: smokeEnv });
  run("npm", ["run", "smoke:readonly"], { env: smokeEnv });
  run("npm", ["run", "smoke:write"], { env: smokeEnv });
  console.log("\n✅ 全部 smoke 测试通过");
}

main();
