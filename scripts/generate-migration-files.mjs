/**
 * 生成迁移文件映射的构建脚本
 * 
 * 在构建前运行，读取 migrations/*.sql 文件，
 * 生成 src/db/migration-files.ts，供运行时加载。
 * 
 * 使用方法：
 *   node scripts/generate-migration-files.mjs
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");
const outputFile = join(__dirname, "..", "src", "db", "migration-files.ts");

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const entries = [];
for (const file of files) {
  const version = file.split("_")[0];
  const content = readFileSync(join(migrationsDir, file), "utf-8")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
  
  entries.push(`  "${version}": \`${content}\``);
}

const output = `// 此文件由 scripts/generate-migration-files.mjs 自动生成，不要手动编辑
export const MIGRATION_FILES: Record<string, string> = {
${entries.join(",\n")}
};
`;

writeFileSync(outputFile, output);
console.log(`[generate-migrations] Generated ${files.length} migration(s) into ${outputFile}`);
