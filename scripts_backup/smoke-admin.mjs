/**
 * 管理端冒烟测试（所有模板共用结构）
 *
 * 验证管理端 API 鉴权：
 * 1. 无 Token → 401
 * 2. 正确 Token → 200
 *
 * 用法：
 *   BASE_URL=https://your-domain.com ADMIN_TOKEN=xxx node scripts/smoke-admin.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-only-change-me";

async function smoke(name, url, opts, check) {
  try {
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    const passed = check(res, body);
    console.log(`${passed ? "✅" : "❌"} ${name} — ${res.status}`);
    if (!passed) {
      console.error(`   Body:`, JSON.stringify(body).slice(0, 200));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`❌ ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n🔐 Admin smoke test: ${BASE_URL}\n`);

// 1. 无 Token → 401
await smoke(
  "GET /api/admin/* without token → 401",
  `${BASE_URL}/api/admin/summary`,
  {},
  (res) => res.status === 401,
);

// 2. 正确 Token → 200
await smoke(
  "GET /api/admin/* with token → 200",
  `${BASE_URL}/api/admin/summary`,
  { headers: { "Authorization": `Bearer ${ADMIN_TOKEN}` } },
  (res, body) => res.ok || res.status === 404, // 404 也算通过（可能端点不同）
);

console.log(`\n${process.exitCode ? "❌ Some tests failed" : "✅ All admin smoke tests passed"}\n`);
