import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/*
 * 将 Vue/Vite 构建产物发布到 Worker Static Assets 目录。
 *
 * Worker 运行时读取的是 public/_app/index.html 和 public/_app/assets/*，
 * 而 Vite 构建输出在 frontend/dist。没有这一步时，本地 build 虽然成功，
 * 线上仍会回退到旧 public/index.html，导致前端交付断层。
 */

const sourceDir = join("frontend", "dist");
const targetDir = join("public", "_app");

if (!existsSync(join(sourceDir, "index.html"))) {
  console.error("frontend/dist/index.html 不存在，请先执行 npm --workspace frontend run build");
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("frontend assets synced to public/_app");
