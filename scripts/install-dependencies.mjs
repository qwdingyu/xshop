import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (mode !== "install" && mode !== "ci") {
  console.error("用法：node scripts/install-dependencies.mjs <install|ci> [npm 参数]");
  process.exit(1);
}

// 依赖安装与浏览器资产是两个生命周期：日常 npm 安装不得顺带下载 Playwright 浏览器。
// 浏览器验收统一复用 resolve-local-chromium.mjs 找到的现有可执行文件。
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, [mode, ...process.argv.slice(3)], {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
