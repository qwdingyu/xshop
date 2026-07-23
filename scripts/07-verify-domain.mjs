import https from "node:https";

/*
 * eshop 域名和健康检查脚本。
 *
 * 用途：
 * - 验证正式域名是否能完成 HTTPS 握手。
 * - 验证 /api/health 是否能访问数据库并返回 eshop/turso 或 eshop/d1 标识。
 * - 支持 RESOLVE_IP，用于排查“Cloudflare 绑定已成功，但默认边缘解析路径异常”的情况。
 *
 * 关键变量：
 * - BASE_URL：要验证的实际部署地址。
 * - RESOLVE_IP：可选，强制把域名请求打到指定边缘 IP，同时保留 SNI/Host。
 * - VERIFY_ATTEMPTS：轮询次数。
 * - VERIFY_INTERVAL_MS：轮询间隔。
 *
 * 必填环境变量：
 * - BASE_URL：实际部署地址，例如 https://shop.example.com。
 *
 * 可选环境变量：
 * - BASE_URL：正式域名或 workers.dev，例如 https://shop.example.com。
 * - RESOLVE_IP：指定 Cloudflare 边缘 IP，只用于排障。
 * - VERIFY_ATTEMPTS=6：最多尝试次数。
 * - VERIFY_INTERVAL_MS=5000：每次重试间隔。
 *
 * 常用命令：
 * - 验证正式域名：
 *   BASE_URL="https://shop.example.com" npm run verify:domain
 * - 验证 workers.dev：
 *   BASE_URL="https://your-worker.your-subdomain.workers.dev" npm run verify:domain
 * - 指定边缘 IP 排障：
 *   RESOLVE_IP="<edge-ip>" BASE_URL="https://shop.example.com" npm run verify:domain
 *
 * 注意：
 * - RESOLVE_IP 只是排障手段，不是生产运行方式。
 * - 如果 RESOLVE_IP 成功而默认解析失败，优先判断为 DNS/边缘路径问题，不要误判 D1 或 Worker 失败。
 */

const baseUrl = process.env.BASE_URL;
if (!baseUrl) throw new Error("缺少 BASE_URL，拒绝猜测部署域名");
const resolveIp = process.env.RESOLVE_IP;
const attempts = Number.parseInt(process.env.VERIFY_ATTEMPTS || "6", 10);
const intervalMs = Number.parseInt(process.env.VERIFY_INTERVAL_MS || "5000", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(path, method = "GET") {
  const url = new URL(path, baseUrl);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: resolveIp || url.hostname,
        servername: url.hostname,
        path: url.pathname,
        method,
        headers: {
          host: url.hostname
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode, body });
        });
      }
    );

    req.on("error", (error) => resolve({ ok: false, error: error.message }));
    req.end();
  });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const head = await request("/", "HEAD");
  console.log(`Verify ${attempt}/${attempts}: ${baseUrl}/ -> ${head.ok ? `HTTP ${head.statusCode}` : head.error}`);

  if (head.ok) {
    const health = await request("/api/health");
    if (!health.ok) {
      throw new Error(`/api/health failed: ${health.error || health.statusCode}`);
    }

    const parsed = JSON.parse(health.body);
    if (parsed.service !== "eshop" || (parsed.storage !== "d1" && parsed.storage !== "turso")) {
      throw new Error(`Unexpected health response: ${health.body}`);
    }
    if (parsed.database && parsed.database !== "ok") {
      throw new Error(`Database health is not ok: ${health.body}`);
    }

    console.log(`eshop verify passed: ${baseUrl} storage=${parsed.storage}`);
    process.exit(0);
  }

  await sleep(intervalMs);
}

throw new Error(`Timed out verifying ${baseUrl}`);
