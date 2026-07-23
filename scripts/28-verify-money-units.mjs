import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * 金额单位闭环门禁。
 *
 * 约束见 docs/050_金额单位存储与界面主单位闭环_2026-07-24.md
 * 与 README「金额整数最小单位存储，界面用主单位录入与展示」。
 *
 * 目标：
 * 1. 系统配置充值限额 unit=cents，label 用「元」；
 * 2. Admin ConfigField 对 unit=cents 做元↔分转换；
 * 3. 商户可见文案不再出现「（分）」金额标签；
 * 4. 关键金额入口走 shared/money 或 currency 工具。
 */

const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function walkFiles(dir, predicate, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const definitionsPath = "src/lib/system-config-definitions.json";
const registryPath = "src/lib/system-config-registry.ts";
const configFieldPath = "frontend/src/components/admin/ConfigField.vue";
const adminTypesPath = "frontend/src/types/admin.ts";
const conventionPath = "docs/050_金额单位存储与界面主单位闭环_2026-07-24.md";
const moneyPath = "shared/money.ts";
const currencyPath = "frontend/src/utils/currency.ts";

const definitions = JSON.parse(read(definitionsPath));
const registry = read(registryPath);
const configField = read(configFieldPath);
const adminTypes = read(adminTypesPath);
const convention = read(conventionPath);
const money = read(moneyPath);
const currency = read(currencyPath);

// --- 约定文档必须存在 ---
for (const needle of [
  "最小整数单位存储",
  "主单位",
  "unit=cents",
  "ConfigField",
  "balance_recharge",
]) {
  if (!convention.includes(needle)) {
    fail(`${conventionPath} must document: ${needle}`);
  }
}

// --- 共享金额工具存在 ---
for (const fn of ["parseMajorToMinor", "minorToMajorString", "formatMoney"]) {
  if (!money.includes(`export function ${fn}`)) {
    fail(`${moneyPath} must export ${fn}`);
  }
}
for (const fn of ["formatCents", "parseYuanToCents"]) {
  if (!currency.includes(`export function ${fn}`)) {
    fail(`${currencyPath} must export ${fn}`);
  }
}

// --- 充值限额定义：unit=cents + label 元 ---
const moneyKeys = ["balance_recharge_min_cents", "balance_recharge_max_cents"];
for (const key of moneyKeys) {
  const def = definitions.find((item) => item.key === key);
  if (!def) {
    fail(`${definitionsPath} missing key ${key}`);
    continue;
  }
  if (def.type !== "integer") fail(`${key} type must be integer`);
  if (def.unit !== "cents") fail(`${key} unit must be "cents"`);
  if (!String(def.label || "").includes("元")) fail(`${key} label must use 元`);
  if (String(def.label || "").includes("（分）")) fail(`${key} label must not use （分）`);
  if (!/^-?\d+$/.test(String(def.defaultValue || ""))) {
    fail(`${key} defaultValue must be integer cents string`);
  }
}

// --- registry 支持 unit 与元界错误提示 ---
if (!registry.includes('SystemConfigIntegerUnit')) {
  fail(`${registryPath} must declare SystemConfigIntegerUnit`);
}
if (!registry.includes('formatCentsBoundForMessage') && !registry.includes("formatCentsBoundForMessage")) {
  fail(`${registryPath} must format cents bounds in user-facing normalize errors`);
}
if (!registry.includes('unit === "cents"')) {
  fail(`${registryPath} normalize must special-case unit=cents messages`);
}

// --- 前端类型与 ConfigField 闭环 ---
if (!adminTypes.includes("unit?: 'cents' | 'count'") && !adminTypes.includes('unit?: "cents" | "count"')) {
  fail(`${adminTypesPath} AdminSystemConfigDefinition must include unit?: 'cents' | 'count'`);
}
if (!configField.includes("unit === 'cents'") && !configField.includes('unit === "cents"')) {
  fail(`${configFieldPath} must branch on unit=cents`);
}
if (!configField.includes("parseYuanToCents")) {
  fail(`${configFieldPath} must convert yuan input via parseYuanToCents`);
}
if (!configField.includes("formatCents")) {
  fail(`${configFieldPath} must display cents via formatCents`);
}
if (!configField.includes("emitChange(String(cents))")) {
  fail(`${configFieldPath} must emit integer cents strings to save pipeline`);
}

// --- Admin 商户文案：禁止「价格/金额/面值/充值…（分）」 ---
const uiRoots = ["frontend/src/views", "frontend/src/components"];
const vueFiles = uiRoots.flatMap((root) => walkFiles(root, (p) => p.endsWith(".vue")));
const forbiddenLabel = /(价格|金额|面值|充值|立减|变动|余额)[^\n]{0,12}（分）/;
for (const file of vueFiles) {
  const src = read(file);
  // 去掉 HTML/脚本注释中的历史说明，只检查可见模板与字符串
  const withoutBlockComments = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (forbiddenLabel.test(withoutBlockComments)) {
    fail(`${file} contains merchant-facing （分） money label`);
  }
}

// --- 系统配置 JSON 全量：任何 unit=cents 的 label 不得含（分） ---
for (const def of definitions) {
  if (def.unit === "cents" && String(def.label || "").includes("（分）")) {
    fail(`${definitionsPath} ${def.key} label must not contain （分） when unit=cents`);
  }
}

if (failures.length > 0) {
  console.error("verify-money-units FAILED:");
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}

console.log("verify-money-units OK");
