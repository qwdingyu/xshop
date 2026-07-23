import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/*
 * cf-shop 轻量架构边界门禁。
 *
 * 借鉴飞鱼小铺的“自动化架构边界测试”，但保持 cf-shop 的 Cloudflare/libSQL free
 * 小而美定位：不拆多模块、不引入 ArchUnit/ESLint 依赖，只用 Node.js 扫描源码。
 */

const root = process.cwd();
const failures = [];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", ".git", "public/_app"].includes(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, acc);
    else if (/\.(ts|vue|mjs|sql)$/.test(name)) acc.push(path);
  }
  return acc;
}

function normalizePath(path) {
  return relative(root, path).split(sep).join("/");
}

function isTestFile(path) {
  return /\.(test|spec)\.(ts|mjs)$/.test(path) || path.includes("/test-utils/");
}

function importSpecifiers(source) {
  const specs = [];
  const importPattern = /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) specs.push(match[1]);
  return specs;
}

function fail(path, message) {
  failures.push(`${path}: ${message}`);
}

const files = walk(root).map((absolute) => ({ path: normalizePath(absolute), source: readFileSync(absolute, "utf8") }));

// 持久化/API 领域契约只能在 shared 中声明一次；边界层可导入或别名，但不得复制联合类型。
const contractDefinitions = [
  { owner: "shared/fulfillment-input.ts", pattern: /\btype\s+FulfillmentInputType\s*=/, name: "FulfillmentInputType" },
  { owner: "shared/fulfillment-input.ts", pattern: /\bFULFILLMENT_INPUT_TYPES\s*=\s*\[/, name: "fulfillment input values" },
  { owner: "shared/fulfillment-progress.ts", pattern: /\btype\s+FulfillmentProgressStage\s*=/, name: "FulfillmentProgressStage" },
  { owner: "shared/fulfillment-progress.ts", pattern: /\bFULFILLMENT_PROGRESS_STAGES\s*=\s*\[/, name: "fulfillment progress values" },
  { owner: "shared/product-contract.ts", pattern: /\btype\s+(?:IssueMode|FulfillmentMode|DeliveryVisibility|StockDisplayMode)\s*=/, name: "product contract type" },
  { owner: "shared/product-contract.ts", pattern: /\b(?:ISSUE_MODES|FULFILLMENT_MODES|DELIVERY_VISIBILITIES|STOCK_DISPLAY_MODES)\s*=\s*\[/, name: "product contract values" },
];

for (const file of files) {
  if (isTestFile(file.path)) continue;
  for (const contract of contractDefinitions) {
    if (file.path !== contract.owner && contract.pattern.test(file.source)) {
      fail(file.path, `${contract.name} must be imported from ${contract.owner}; do not redefine domain values at a boundary`);
    }
  }
  const specs = importSpecifiers(file.source);

  // cf-shop 允许同一运营主体下的 storefront 展示渠道，但不允许普通功能偷渡多租户数据模型。
  // 真正转向 SaaS 前必须先修改 036 决策文档和治理规则，再显式调整这道门禁。
  if (
    (file.path.startsWith("src/") || file.path.startsWith("frontend/src/") || file.path.startsWith("migrations/")) &&
    /\btenantId\b|\btenant_id\b/.test(file.source)
  ) {
    fail(file.path, "tenant fields are forbidden; model same-operator multi-page needs as storefronts and require an approved SaaS ADR before changing this boundary");
  }

  if (file.path.startsWith("src/db/") && specs.some((spec) => spec.includes("/routes") || spec.includes("/services"))) {
    fail(file.path, "db layer must not import routes or services");
  }

  if (file.path.startsWith("src/services/") && specs.some((spec) => spec.includes("/routes") || spec.startsWith("../routes") || spec.startsWith("./routes"))) {
    fail(file.path, "services layer must not import routes; keep business logic reusable from routes, scripts, and tests");
  }

  if (file.path.startsWith("src/lib/") && specs.some((spec) => spec.includes("/routes") || spec.includes("/services") || spec.startsWith("../routes") || spec.startsWith("../services"))) {
    fail(file.path, "lib layer must not import routes or services; keep utilities infrastructure-only");
  }

  if (file.path.startsWith("src/routes/") && specs.some((spec) => spec.startsWith("../routes/"))) {
    fail(file.path, "routes should be composed in src/index.ts instead of importing sibling route modules");
  }

  if (file.path.startsWith("frontend/src/") && file.source.includes("@/api/admin")) {
    const allowed = file.path === "frontend/src/views/AdminLoginView.vue" ||
      file.path.startsWith("frontend/src/views/admin/") ||
      file.path === "frontend/src/components/AdminProductSelect.vue";
    if (!allowed) fail(file.path, "admin API client must stay inside admin surfaces");
  }
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (!packageJson.scripts?.["verify:architecture"]) {
  failures.push("package.json: missing verify:architecture script");
}
if (!String(packageJson.scripts?.["verify:delivery"] || "").includes("npm run verify:architecture")) {
  failures.push("package.json: verify:delivery must include verify:architecture");
}

if (failures.length > 0) {
  console.error("cf-shop light architecture checks failed:");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log("cf-shop light architecture checks passed.");
