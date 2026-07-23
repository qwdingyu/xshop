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
  "--admin-font-base:",
  "--admin-font-sm:",
  "--admin-cell-pad:",
]) {
  if (!baseCss.includes(token)) fail(`${baseCssPath} must define token ${token.trim()}`);
}

// 表格紧凑字号：禁止把 base 抬回 14px 行高过大
if (!/--admin-font-base:\s*13px/.test(baseCss)) {
  fail(`${baseCssPath} --admin-font-base must be 13px (compact admin tables)`);
}
if (!/--admin-font-sm:\s*11px/.test(baseCss)) {
  fail(`${baseCssPath} --admin-font-sm must be 11px`);
}

// 暗色 select：必须 color-scheme dark + 不透明底（避免选中/列表字发灰）
if (!/select\s*\{[^}]*color-scheme:\s*dark/s.test(baseCss)) {
  fail(`${baseCssPath} select must set color-scheme: dark`);
}
if (!/select\s*\{[^}]*background-color:\s*var\(--tg-secondary-bg/s.test(baseCss)) {
  fail(`${baseCssPath} select must use opaque background-color: var(--tg-secondary-bg)`);
}
if (!/option\s*\{[^}]*background-color:\s*var\(--tg-secondary-bg/s.test(baseCss)) {
  fail(`${baseCssPath} option must use opaque background-color for dark dropdown panels`);
}

// select / filters 垂直居中：固定高度时禁止上下 padding 挤爆行高
const filtersControlBlock =
  adminCss.match(
    /\.filters input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\),\s*\n\.filters select\s*\{[\s\S]*?\n\}/,
  )?.[0] || "";
if (!filtersControlBlock) {
  fail(`${adminCssPath} missing shared .filters input/select control block`);
} else {
  if (!/height:\s*34px/.test(filtersControlBlock)) {
    fail(`${adminCssPath} .filters select/input must use height: 34px`);
  }
  if (!/line-height:\s*32px/.test(filtersControlBlock)) {
    fail(`${adminCssPath} .filters select/input must use line-height: 32px for vertical centering`);
  }
  if (/padding:\s*8px/.test(filtersControlBlock)) {
    fail(`${adminCssPath} .filters select/input must not use vertical padding: 8px (clips text)`);
  }
  if (!/padding:\s*0\s+10px/.test(filtersControlBlock) && !/padding:\s*0\s/.test(filtersControlBlock)) {
    fail(`${adminCssPath} .filters select/input must use horizontal-only padding (padding: 0 …)`);
  }
}
// 桌面 media 不得把 filters 改回 padding: 8px …
if (/@media\s*\(min-width:\s*1024px\)[\s\S]{0,2500}?\.filters select[\s\S]{0,200}?padding:\s*8px/.test(adminCss)) {
  fail(`${adminCssPath} ≥1024px media must not reintroduce filters padding: 8px (breaks select centering)`);
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

// ── sticky 表头防透字（批量共性，禁止回归）────────────────────────
// 见 admin.css 表格段注释与 docs/049 §3.1
if (!adminCss.includes("border-collapse: separate")) {
  fail(`${adminCssPath} .admin-table must use border-collapse: separate for sticky header stacking`);
}
if (!/\.table-wrap\s*\{[^}]*isolation:\s*isolate/s.test(adminCss)) {
  fail(`${adminCssPath} .table-wrap must set isolation: isolate`);
}

// 合并 thead th + th 的权威规则块（紧跟「sticky 表头」注释之后的那一段）
const stickyMarker = adminCss.indexOf("sticky 表头：唯一权威实现");
const stickyWindow =
  stickyMarker >= 0
    ? adminCss.slice(stickyMarker, stickyMarker + 900)
    : adminCss.match(/\.admin-table\s+thead\s+th[\s\S]{0,50}\.admin-table\s+th\s*\{[\s\S]*?\n\}/)?.[0] || "";

if (!stickyWindow) {
  fail(`${adminCssPath} missing sticky header rule block (comment marker or .admin-table thead th)`);
} else {
  if (!/position:\s*sticky/.test(stickyWindow)) {
    fail(`${adminCssPath} sticky th must set position: sticky`);
  }
  if (!/top:\s*0/.test(stickyWindow)) {
    fail(`${adminCssPath} sticky th must set top: 0`);
  }
  if (!/background-color:\s*var\(--tg-secondary-bg/.test(stickyWindow)) {
    fail(`${adminCssPath} sticky th must set opaque background-color: var(--tg-secondary-bg)`);
  }
  const z = stickyWindow.match(/z-index:\s*(\d+)/);
  if (!z || Number(z[1]) < 5) {
    fail(`${adminCssPath} sticky th must use z-index >= 5 (got ${z ? z[1] : "missing"})`);
  }
  // 禁止「只有半透明 background:」且没有 background-color 实色
  if (/background:\s*var\(--surface-2/.test(stickyWindow) && !/background-color:/.test(stickyWindow)) {
    fail(`${adminCssPath} sticky th must not use surface-2-only semi-transparent background`);
  }
}

// 历史回归指纹：整文件不得再出现「th 上仅 surface-2 半透明 + sticky + z-index:1」旧模式
if (
  /\.admin-table\s+th\s*\{[^}]*background:\s*var\(--surface-2[^}]*position:\s*sticky[^}]*z-index:\s*1/s.test(
    adminCss,
  )
) {
  fail(`${adminCssPath} legacy semi-transparent sticky th (z-index:1) must not return`);
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
      { re: /^\.admin-table\s+th\s*\{/m, name: ".admin-table th (use admin.css sticky header)" },
      { re: /^\.table-wrap\s*\{/m, name: ".table-wrap" },
    ];
    for (const item of bannedFullBlocks) {
      if (item.re.test(body)) fail(`${file} scoped CSS redefines shared primitive ${item.name}; hoist to admin.css`);
    }

    // 弱蓝 info 字色
    if (/#93c5fd|#1d4ed8|rgba\(\s*96\s*,\s*165\s*,\s*250/i.test(body)) {
      fail(`${file} scoped CSS uses weak blue; use --admin-accent* / --admin-info* tokens`);
    }

    // 禁止页内把表头改成半透明或 transparent（会再次透字）
    if (/\.admin-table[^\n]*th[^{]*\{[^}]*(?:background(?:-color)?\s*:\s*(?:transparent|var\(--surface)|opacity\s*:\s*0\.)/i.test(body)) {
      fail(`${file} must not override sticky th with transparent/semi-transparent background`);
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
