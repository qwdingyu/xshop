import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 只扫描 Git 已跟踪文件，避免把本机 .dev.vars、.credentials 和构建缓存误报为仓库泄漏。
const EXCLUDED_FILES = new Set([
  ".dev.vars.example",
  "package-lock.json",
  "worker-configuration.d.ts",
]);

const SECRET_PATTERNS = [
  ["Turso/libSQL JWT", /eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["Cloudflare API credential", /\b(?:cfat|cfk)_[A-Za-z0-9_-]{16,}\b/g],
  ["GitHub access token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ["Resend API key", /\bre_[A-Za-z0-9]{20,}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

export function findSecretMatches(source, file = "<memory>") {
  const matches = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      matches.push({ file, line, kind });
    }
  }
  return matches;
}

export function scanTrackedFiles(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_FILES.has(file));

  return files.flatMap((file) => {
    let source;
    try {
      source = readFileSync(`${root}/${file}`, "utf8");
    } catch {
      return [];
    }
    return source.includes("\0") ? [] : findSecretMatches(source, file);
  });
}

function main() {
  const matches = scanTrackedFiles();
  if (matches.length === 0) {
    console.log("Tracked-file secret scan passed.");
    return;
  }

  // 永远不打印命中的值，避免 CI 日志把一次仓库泄漏扩散成第二份日志泄漏。
  for (const match of matches) {
    console.error(`${match.file}:${match.line}: possible ${match.kind}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
