import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Admin 共享样式门禁。
 *
 * 约束见 docs/049_Admin共享样式与开发约束规约_2026-07-23.md
 * 目标：阻止页面不 import admin.css、在 scoped 中整块重定义公共 primitives、引入弱蓝 info 字色。
 */

const failures = [];

function fail(message) {
  failures.push(message);
}

function walkVueFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkVueFiles(full, out);
    else if (name.endsWith(".vue")) out.push(full);
  }
  return out;
}

const adminViewsDir = "frontend/src/views/admin";
const adminViews = walkVueFiles(adminViewsDir);
const layoutPath = "frontend/src/views/AdminLayout.vue";
const adminCssPath = "frontend/src/assets/admin.css";
const baseCssPath = "frontend/src/assets/base.css";
const conventionPath = "docs/049_Admin共享样式与开发约束规约_2026-07-23.md";

const adminCss = readFileSync(adminCssPath, "utf8");
const baseCss = readFileSync(baseCssPath, "utf8");
const convention = readFileSync(conventionPath, "utf8");

for (const token of [
  "--admin-accent:",
  "--admin-accent-soft:",
  "--admin-accent-border:",
  "--admin-accent-text:",
  "--admin-info:",
  "--admin-success:",
  "--admin-danger:",
]) {
  if (!baseCss.includes(token)) fail(`${baseCssPath} must define token ${token.trim()}`);
}

for (const primitive of [
  ".quick-chip",
  ".action-chip",
  ".admin-tab-bar",
  ".notice-card",
  ".modal-actions",
  ".field-hint",
  ".page-title",
  ".status-banner",
  ".balance-card",
  ".segment-btn",
  ".generated-result",
  ".image-upload-row",
  ".relation-cell",
  ".stat-item",
  ".dir-btn",
  ".filters .filter-check",
]) {
  if (!adminCss.includes(primitive)) fail(`${adminCssPath} must define primitive ${primitive}`);
}

if (!convention.includes("强制规约") || !convention.includes("admin.css")) {
  fail(`${conventionPath} must remain the binding Admin style convention`);
}

// admin.css 自身禁止弱蓝 info / 选中行（忽略注释行）
const adminCssCodeOnly = adminCss
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
  .join("\n");
const weakBlueInAdminCss = [
  /color:\s*#93c5fd/i,
  /background:\s*rgba\(\s*96\s*,\s*165\s*,\s*250/i,
  /border-color:\s*rgba\(\s*96\s*,\s*165\s*,\s*250/i,
];
for (const re of weakBlueInAdminCss) {
  if (re.test(adminCssCodeOnly)) fail(`${adminCssPath} must not use weak blue for info/selection: ${re}`);
}

// 每个 Admin 业务页必须 import admin.css
for (const file of adminViews) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("@/assets/admin.css") && !src.includes("assets/admin.css")) {
    fail(`${file} must @import '@/assets/admin.css'`);
  }

  // 禁止在 scoped 中整块重定义高风险公共选择器（允许注释提及）
  const scopedMatch = src.match(/<style\s+scoped[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of scopedMatch) {
    const body = block.replace(/<style[^>]*>|<\/style>/gi, "");
    const bannedFullBlocks = [
      { re: /^\.modal-actions\s*\{[^}]*display\s*:\s*flex/m, name: ".modal-actions layout" },
      { re: /^\.generated-result\s*\{[^}]*display\s*:\s*flex/m, name: ".generated-result layout" },
      { re: /^\.relation-cell\s*\{[^}]*display\s*:\s*inline-flex/m, name: ".relation-cell layout" },
      { re: /^\.image-upload-button\s*\{[^}]*position\s*:\s*relative/m, name: ".image-upload-button" },
      { re: /^\.page-title\s*\{/m, name: ".page-title" },
      { re: /^\.field-hint\s*\{/m, name: ".field-hint" },
      { re: /^\.segment-btn\s*\{/m, name: ".segment-btn" },
      { re: /^\.quick-chip\s*\{/m, name: ".quick-chip" },
      { re: /^\.action-chip\s*\{/m, name: ".action-chip" },
      { re: /^\.notice-card\s*\{[^}]*background\s*:/m, name: ".notice-card colors" },
      { re: /^\.health-card\s*\{/m, name: ".health-card" },
      { re: /^\.status-banner-success\s*\{/m, name: ".status-banner-success" },
      { re: /^\.dir-btn\s*\{/m, name: ".dir-btn" },
      { re: /^\.stat-item\s*\{/m, name: ".stat-item" },
    ];
    for (const item of bannedFullBlocks) {
      if (item.re.test(body)) fail(`${file} scoped CSS redefines shared primitive ${item.name}; hoist to admin.css`);
    }

    // 弱蓝 info 字色
    if (/#93c5fd|#1d4ed8|rgba\(\s*96\s*,\s*165\s*,\s*250/i.test(body)) {
      fail(`${file} scoped CSS uses weak blue; use --admin-accent* / --admin-info* tokens`);
    }
  }
}

// 壳层应存在
try {
  readFileSync(layoutPath, "utf8");
} catch {
  fail(`${layoutPath} missing`);
}

if (failures.length > 0) {
  console.error("cf-shop admin style checks failed:");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log(`cf-shop admin style checks passed (${adminViews.length} admin views).`);
