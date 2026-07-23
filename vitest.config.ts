import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  plugins: [
    {
      name: "html-raw-loader-mock",
      resolveId(id) {
        if (id.includes("templates/*.html?raw")) {
          return "\0html-templates-mock";
        }
        return null;
      },
      load(id) {
        if (id === "\0html-templates-mock") {
          return `export default ${JSON.stringify({ "./order_issued.html": "<p>{{order_no}}</p><p>{{product_title}}</p><p>{{account_label}}</p><p>{{delivery_secret}}</p>", "./order_pending.html": "ORDER PENDING HTML", "./order_paid.html": "ORDER PAID HTML", "./order_expired.html": "ORDER EXPIRED HTML" })};`;
        }
        return null;
      },
    },
  ],
  test: {
    environment: "node",
    // WebCrypto secret-config tests can take several seconds under full-file parallelism.
    // Keep the timeout bounded while avoiding false failures from CI CPU contention.
    testTimeout: 15_000,
    include: ["src/**/*.test.ts", "frontend/src/**/*.test.ts", "shared/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        // “src/**/*.ts” 在 coverage glob 中也会匹配 frontend/src；后端门槛必须显式限定根目录 src。
        // 前端交互由独立组件/契约测试和 vue-tsc 生产构建验证，不与后端覆盖率分母混算。
        "frontend/**",
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/db/schema.ts",
        "src/db/client.ts",
        "src/db/database.ts",
        "src/bindings.ts",
        "src/index.ts",
        "src/routes/**/*.ts",
        // Template files are pure string exports; no logic to test.
        "src/services/templates/**/*.ts",
        // product-service has unit tests for pure functions (toPublicProduct);
        // DB-dependent functions (listProducts, getProduct) need integration tests.
        "src/services/product-service.ts",
        // telegram-bot is an integration-heavy module (Telegram API + DB);
        // its coverage is validated by smoke tests, not unit tests.
        "src/telegram-bot/**/*.ts",
        // Test utilities are not production code.
        "src/test-utils/**/*.ts",
      ],
      thresholds: {
        functions: 80,
        branches: 50,
        lines: 70,
      },
    },
  },
});
