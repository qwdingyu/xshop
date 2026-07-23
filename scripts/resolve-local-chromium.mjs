import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const EXECUTABLE_OVERRIDE = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionOfCacheEntry(name) {
  const match = name.match(/^(?:chromium|chromium_headless_shell)-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function cacheRoots(env) {
  const roots = [];
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured && configured !== "0") roots.push(configured);

  if (process.platform === "darwin") {
    roots.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  } else if (process.platform === "win32") {
    roots.push(join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright"));
  } else {
    roots.push(join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright"));
  }
  return [...new Set(roots)];
}

function cachedCandidates(root) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && versionOfCacheEntry(entry.name) >= 0)
    // 同版本优先完整 Chromium；它同时支持有头和无头验收，复用范围更广。
    .sort((left, right) => versionOfCacheEntry(right.name) - versionOfCacheEntry(left.name)
      || Number(left.name.includes("headless_shell")) - Number(right.name.includes("headless_shell")));

  const relativeExecutables = process.platform === "darwin"
    ? [
        ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
        ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
        ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
      ]
    : process.platform === "win32"
      ? [
          ["chrome-win64", "chrome.exe"],
          ["chrome-win", "chrome.exe"],
          ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
        ]
      : [
          ["chrome-linux64", "chrome"],
          ["chrome-linux", "chrome"],
          ["chrome-headless-shell-linux64", "chrome-headless-shell"],
        ];

  return entries.flatMap((entry) => relativeExecutables.map((parts) => join(root, entry.name, ...parts)));
}

function systemCandidates(env) {
  const pathCandidates = (env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
      .map((name) => join(directory, process.platform === "win32" ? `${name}.exe` : name)));

  if (process.platform !== "darwin") return pathCandidates;
  return [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...pathCandidates,
  ];
}

/**
 * 浏览器验收只复用已经安装的 Chromium，禁止在测试过程中隐式下载大体积浏览器。
 * CI 或特殊机器可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 提供确定路径。
 */
export function resolveLocalChromiumExecutable(env = process.env) {
  const override = env[EXECUTABLE_OVERRIDE]?.trim();
  if (override) {
    if (isExecutable(override)) return override;
    throw new Error(`${EXECUTABLE_OVERRIDE} 指向的文件不存在或不可执行：${override}`);
  }

  const candidates = [
    ...cacheRoots(env).flatMap(cachedCandidates),
    ...systemCandidates(env),
  ];
  const executable = candidates.find(isExecutable);
  if (executable) return executable;

  throw new Error(
    `未找到可复用的 Chromium。请安装一次浏览器，或设置 ${EXECUTABLE_OVERRIDE}；项目不会自动下载浏览器。`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${resolveLocalChromiumExecutable()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
