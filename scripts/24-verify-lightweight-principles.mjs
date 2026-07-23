import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * cf-shop 轻量原则门禁。
 *
 * 目标：把“保持轻量、优先自动化门禁、延迟抽象、smoke 可审计”变成可执行约束。
 * 这不是通用 lint，也不引入新依赖；只保护 Cloudflare Workers + libSQL free 计划下最容易退化的边界。
 */

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const docsDecision = readFileSync("docs/023_飞鱼小铺代码审查借鉴评估_2026-07-09.md", "utf8");

const failures = [];

function fail(message) {
  failures.push(message);
}

const allowedRuntimeDependencies = new Set([
  "@libsql/client",
  "@usethink/cf-core",
  "drizzle-orm",
  "hono",
  "zod",
]);

const runtimeDependencies = Object.keys(packageJson.dependencies || {});
for (const dependency of runtimeDependencies) {
  if (!allowedRuntimeDependencies.has(dependency)) {
    fail(`runtime dependency ${dependency} is not in the lightweight allowlist; document why it lowers Cloudflare/libSQL free-plan risk before adding it`);
  }
}

if (packageJson.workspaces?.length !== 1 || packageJson.workspaces[0] !== "frontend") {
  fail("workspaces must stay limited to the Vue frontend unless a documented product constraint justifies more packages");
}

const delivery = String(packageJson.scripts?.["verify:delivery"] || "");
for (const required of ["npm run verify:core", "npm run verify:architecture", "npm run verify:lightweight"]) {
  if (!delivery.includes(required)) fail(`verify:delivery must include ${required}`);
}

if (packageJson.scripts?.["verify:lightweight"] !== "node scripts/24-verify-lightweight-principles.mjs") {
  fail("package.json must expose verify:lightweight");
}

const smokeEntrypoints = [
  "04-smoke-readonly.mjs",
  "05-smoke-admin.mjs",
  "06-smoke-write.mjs",
  "18-smoke-catalog-admin.mjs",
  "19-smoke-ops-crud.mjs",
  "20-smoke-legacy-guards.mjs",
  "21-smoke-inventory-closure.mjs",
  "26-smoke-frontend-assets.mjs",
];

for (const file of smokeEntrypoints) {
  const path = join("scripts", file);
  const source = readFileSync(path, "utf8");
  if (!source.includes("./http-client.mjs")) fail(`${path} must use the shared HTTP client for consistent remote smoke behavior`);
  if (/node:child_process|execFile|spawn\(/.test(source)) fail(`${path} must remain a direct user-flow smoke, not a script orchestrator`);
  if (/from ["']\.\/[^"']+(?:helpers|fixtures|factory|scenario|workflow)[^"']*["']/.test(source)) {
    fail(`${path} hides smoke flow behind helper abstractions; keep core smoke steps auditable in the entrypoint`);
  }
}

const legacySmokeFiles = readdirSync("scripts").filter((name) => /^smoke-(readonly|admin)\.mjs$/.test(name) || name === "smoke.sh");
if (legacySmokeFiles.length > 0) {
  fail(`legacy smoke wrappers ${legacySmokeFiles.join(", ")} must be removed; use numbered smoke scripts and package.json commands only`);
}

if (!docsDecision.includes("任何外部项目模式都必须先回答") || !docsDecision.includes("明确不借鉴")) {
  fail("docs/023 must preserve lightweight adoption rules and explicit rejection decisions");
}

if (failures.length > 0) {
  console.error("cf-shop lightweight principle checks failed:");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log("cf-shop lightweight principle checks passed.");
