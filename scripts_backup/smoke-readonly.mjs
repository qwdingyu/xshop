/**
 * 只读冒烟测试（所有模板共用结构）
 *
 * 验证部署后的基本功能：
 * 1. /api/health 返回 ok
 * 2. 公开 API 端点可访问
 *
 * 用法：
 *   BASE_URL=https://your-domain.com node scripts/smoke-readonly.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";

async function smoke(name, url, check) {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    const passed = check(res, body);
    console.log(`${passed ? "✅" : "❌"} ${name} — ${res.status}`);
    if (!passed) {
      console.error(`   Expected check failed. Body:`, JSON.stringify(body).slice(0, 200));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`❌ ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n🔍 Smoke test: ${BASE_URL}\n`);

// 1. 健康检查
await smoke("GET /api/health", `${BASE_URL}/api/health`, (res, body) => {
  return res.ok && body.ok === true;
});

// 2. 404 处理
await smoke("GET /api/nonexistent → 404", `${BASE_URL}/api/nonexistent`, (res) => {
  return res.status === 404;
});

console.log(`\n${process.exitCode ? "❌ Some tests failed" : "✅ All smoke tests passed"}\n`);
