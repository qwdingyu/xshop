import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, textRequest } from "./http-client.mjs";

/*
 * 部署后前端资产完整性 smoke。
 *
 * 本地 public/_app 是本次 wrangler/pages deploy 的权威产物清单。脚本先确认线上
 * index.html 与本次构建引用相同，再逐一确认所有 hash JS/CSS 均可访问且使用
 * immutable 缓存，避免“首页正常、某个懒加载后台页面 404”的假成功。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(projectRoot, "public", "_app");

export function extractFrontendAssetPaths(html) {
  const paths = new Set();
  const attributePattern = /(?:src|href|data-src)=["'](\/_app\/assets\/[^"']+)["']/g;
  let match;
  while ((match = attributePattern.exec(html)) !== null) paths.add(match[1]);
  return [...paths].sort();
}

export function collectFrontendAssetPaths(root = appRoot) {
  const assetsRoot = join(root, "assets");
  if (!existsSync(assetsRoot)) return [];

  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolutePath = join(directory, name);
      if (statSync(absolutePath).isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const relativePath = relative(root, absolutePath).split(sep).map(encodeURIComponent).join("/");
      files.push(`/_app/${relativePath}`);
    }
  };
  visit(assetsRoot);
  return files.sort();
}

function assertSuccessful(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed: HTTP ${response.statusCode}`);
  }
}

function assertCacheDirective(response, directive, label) {
  const cacheControl = String(response.headers["cache-control"] || "").toLowerCase();
  if (!cacheControl.includes(directive)) {
    throw new Error(`${label} must return Cache-Control ${directive}. got: ${cacheControl || "<missing>"}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function normalizeMaxAttempts(configuredValue) {
  // 两次生产部署均观察到自定义域名的单文件传播可接近 50 秒；默认 12 轮
  // 提供约 60 秒的有界窗口，仍不允许无限等待或忽略持续缺包。
  const configuredAttempts = Number(configuredValue || 12);
  return Number.isInteger(configuredAttempts) && configuredAttempts > 0
    ? Math.min(configuredAttempts, 12)
    : 12;
}

function configuredMaxAttempts() {
  return normalizeMaxAttempts(process.env.FRONTEND_ASSET_SMOKE_ATTEMPTS);
}

async function requestAssetMetadata(path) {
  const head = await textRequest(path, { method: "HEAD" });
  if (head.statusCode !== 405 && head.statusCode !== 501) return head;
  return textRequest(path);
}

async function waitForCurrentEntry(localEntryAssets) {
  const maxAttempts = configuredMaxAttempts();
  let lastError;

  // 自定义域名可能在发布后短暂命中上一版本，因此入口版本需要有界重试。
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const remoteEntry = await textRequest("/_app/index.html");
      assertSuccessful(remoteEntry, "/_app/index.html");
      assertCacheDirective(remoteEntry, "no-store", "/_app/index.html");

      const remoteEntryAssets = extractFrontendAssetPaths(remoteEntry.raw);
      if (JSON.stringify(remoteEntryAssets) !== JSON.stringify(localEntryAssets)) {
        throw new Error(`线上 SPA 入口与本次构建不一致：local=${JSON.stringify(localEntryAssets)} remote=${JSON.stringify(remoteEntryAssets)}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      console.warn(`SPA 入口尚未传播到当前构建 (${attempt}/${maxAttempts})，5 秒后重试`);
      await sleep(5_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("线上 SPA 入口未传播到当前构建");
}

/**
 * 验证当前构建的全部 hash 资源已经通过自定义域名稳定可用。
 *
 * Cloudflare 发布时，HTML 与各个资源文件不保证在同一时刻传播到所有边缘节点。
 * 因此这里只重试上一轮失败的资源：已经成功的资源不重复请求；达到次数上限后，
 * 任何持续 404、非 immutable 响应或网络错误仍然会阻断部署，避免掩盖真实缺包。
 */
export async function verifyAssetSet(
  paths,
  {
    request = requestAssetMetadata,
    maxAttempts = configuredMaxAttempts(),
    retryDelayMs = 5_000,
    sleepForRetry = sleep,
    warn = console.warn,
  } = {},
) {
  let pendingPaths = [...paths];
  let failures = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    failures = [];
    for (const path of pendingPaths) {
      try {
        const response = await request(path);
        assertSuccessful(response, path);
        assertCacheDirective(response, "immutable", path);
      } catch (error) {
        failures.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (failures.length === 0) return;
    if (attempt === maxAttempts) break;

    pendingPaths = failures.map(({ path }) => path);
    warn(`仍有 ${pendingPaths.length} 个前端资源尚未传播 (${attempt}/${maxAttempts})，5 秒后只重试失败资源`);
    await sleepForRetry(retryDelayMs);
  }

  const details = failures.map(({ path, message }) => `- ${path}: ${message}`).join("\n");
  throw new Error(`前端资源在 ${maxAttempts} 次检查后仍不可用：\n${details}`);
}

export async function verifyDeployedFrontendAssets() {
  const localEntryPath = join(appRoot, "index.html");
  if (!existsSync(localEntryPath)) {
    throw new Error("public/_app/index.html 不存在，请先执行 npm run frontend:build");
  }

  const localEntry = readFileSync(localEntryPath, "utf8");
  const localEntryAssets = extractFrontendAssetPaths(localEntry);
  const builtAssets = collectFrontendAssetPaths();
  if (localEntryAssets.length === 0 || builtAssets.length === 0) {
    throw new Error("本次构建没有生成可验证的 /_app/assets 资源");
  }
  for (const path of localEntryAssets) {
    if (!builtAssets.includes(path)) throw new Error(`index.html 引用了本地不存在的构建资源：${path}`);
  }

  await waitForCurrentEntry(localEntryAssets);
  await verifyAssetSet(builtAssets);

  console.log(`cf-shop frontend asset smoke passed: ${baseUrl} (${builtAssets.length} assets)`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyDeployedFrontendAssets();
}
