import { baseUrl, request, textRequest } from "./http-client.mjs";

/*
 * eshop 只读 smoke。
 *
 * 用途：
 * - 验证 Worker、D1、商品接口、优惠码试算接口可用。
 * - 验证管理接口没有 token 时不会裸露。
 * - 验证 /admin 不会被 Static Assets 307 到 /，防止后台入口实际打开用户首页。
 *
 * 必填环境变量：
 * - 无。默认 BASE_URL=http://127.0.0.1:8790。
 *
 * 可选环境变量：
 * - BASE_URL：目标地址，例如 https://shop.example.com。
 * - ADMIN_PAGE_URL：后台页面验证地址。自定义域名有 WAF challenge 时，建议填 workers.dev 域名。
 * - RESOLVE_IP：强制 HTTPS 请求使用指定 IP，只用于排障。
 *
 * 常用命令：
 * - npm run smoke:readonly
 * - BASE_URL="https://shop.example.com" npm run smoke:readonly
 * - BASE_URL="https://your-worker.your-subdomain.workers.dev" npm run smoke:readonly
 */

const adminPageUrl = process.env.ADMIN_PAGE_URL || `${baseUrl}/admin`;

const health = await request("/api/health");
if (health.service !== "eshop" || (health.storage !== "d1" && health.storage !== "turso")) {
  throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
}

function assertNoStore(response, label) {
  const cacheControl = String(response.headers["cache-control"] || "").toLowerCase();
  if (!cacheControl.includes("no-store")) {
    throw new Error(`${label} must return Cache-Control no-store for live stock. got: ${cacheControl || "<missing>"}`);
  }
}

function parseJsonResponse(response, label) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed: HTTP ${response.statusCode} ${response.raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(response.raw);
  } catch {
    throw new Error(`${label} returned non-json: ${response.raw.slice(0, 200)}`);
  }
}

function countByCategory(items) {
  const counts = new Map();
  for (const item of items) {
    const category = String(item.category || "").trim();
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return counts;
}

function assertSameProductSummary(listProduct, detailProduct) {
  if (detailProduct?.id !== listProduct.id) {
    throw new Error(`Product detail id mismatch: list=${listProduct.id} detail=${detailProduct?.id || "<missing>"}`);
  }
  const fields = ["title", "priceCents", "currency", "issueMode", "fulfillmentMode", "category", "stockDisplayMode", "canPurchase", "isOutOfStock"];
  for (const field of fields) {
    const listValue = listProduct[field] ?? null;
    const detailValue = detailProduct?.[field] ?? null;
    if (listValue !== detailValue) {
      throw new Error(`Product list/detail ${field} mismatch for ${listProduct.id}: list=${listValue} detail=${detailValue}`);
    }
  }

  const mode = listProduct.stockDisplayMode || "exact";
  if (!["exact", "availability_only", "hidden"].includes(mode)) {
    throw new Error(`Invalid stockDisplayMode for ${listProduct.id}: ${mode}`);
  }
  if (mode === "exact") {
    for (const field of ["stock", "availableStock"]) {
      if (!Number.isFinite(Number(listProduct[field])) || Number(listProduct[field]) !== Number(detailProduct?.[field])) {
        throw new Error(`Exact stock field ${field} mismatch for ${listProduct.id}`);
      }
    }
    return;
  }

  for (const field of ["stock", "availableStock"]) {
    if (Object.hasOwn(listProduct, field) || Object.hasOwn(detailProduct || {}, field)) {
      throw new Error(`${mode} product ${listProduct.id} must not expose ${field}`);
    }
  }
  if (mode === "hidden" && (Object.hasOwn(listProduct, "isLowStock") || Object.hasOwn(detailProduct || {}, "isLowStock"))) {
    throw new Error(`Hidden-stock product ${listProduct.id} must not expose isLowStock`);
  }
}

const productsResponse = await textRequest("/api/products");
assertNoStore(productsResponse, "/api/products");
const products = parseJsonResponse(productsResponse, "/api/products");
if (!Array.isArray(products.products)) {
  throw new Error(`Products must be an array: ${JSON.stringify(products.products)}`);
}
const storefrontId = products.storefront?.id;
if (!storefrontId) {
  throw new Error(`Product catalog missing storefront identity: ${JSON.stringify(products.storefront)}`);
}
if (!Array.isArray(products.categories)) {
  throw new Error(`Product categories must be an array: ${JSON.stringify(products.categories)}`);
}

const product = products.products[0];
const categoryCounts = countByCategory(products.products);
if (products.products.length === 0 && products.categories.length > 0) {
  throw new Error(`Empty product list must not return non-empty categories: ${JSON.stringify(products.categories)}`);
}
for (const category of products.categories) {
  if (Number(category.count) !== Number(categoryCounts.get(category.name) || 0)) {
    throw new Error(`Product category count mismatch for ${category.name}: category=${category.count} products=${categoryCounts.get(category.name) || 0}`);
  }
}
for (const item of products.products) {
  const detailResponse = await textRequest(`/api/products/${encodeURIComponent(item.slug || item.id)}`);
  assertNoStore(detailResponse, `/api/products/${item.slug || item.id}`);
  const detail = parseJsonResponse(detailResponse, "/api/products/:slug");
  assertSameProductSummary(item, detail.product);
}
if (product) {
  // 用商品自己的 id 做 quote（不依赖特定优惠券，空 couponCode 也合法）
  const quote = await request("/api/coupons/quote", {
    method: "POST",
    // 报价和支付必须复用目录返回的稳定渠道 ID，不能由脚本根据 slug 重新推测。
    body: JSON.stringify({ storefrontId, productId: product.id, couponCode: "" })
  });
  if (typeof quote.payableCents !== "number") {
    throw new Error(`Unexpected coupon quote: ${JSON.stringify(quote)}`);
  }
}

let unauthorized = false;
try {
  await request("/api/admin/summary");
} catch (error) {
  unauthorized = String(error.message).includes("HTTP 401") || String(error.message).includes("HTTP 503");
}
if (!unauthorized) throw new Error("Admin API should reject missing token");

const adminPage = await textRequest(adminPageUrl);
const isCloudflareChallenge = adminPage.statusCode === 403 && String(adminPage.headers["cf-mitigated"] || "").includes("challenge");
const isSpaEntry = adminPage.statusCode >= 200 && adminPage.statusCode < 300 &&
  (adminPage.raw.includes('<div id="app">') || adminPage.raw.includes("_app/assets/"));
if (adminPage.statusCode >= 300 && adminPage.statusCode < 400) {
  throw new Error(`/admin should not redirect. got HTTP ${adminPage.statusCode} location=${adminPage.headers.location || ""}`);
}
if (!isSpaEntry && !isCloudflareChallenge) {
  throw new Error(`/admin did not return Vue SPA entry or Cloudflare challenge. got HTTP ${adminPage.statusCode}`);
}

// 验证公共系统配置接口
const sysConfig = await request("/api/system-config");
if (typeof sysConfig.config?.offline_pay_hint !== "string") {
  throw new Error(`Unexpected system-config: ${JSON.stringify(sysConfig)}`);
}

console.log(`eshop readonly smoke passed: ${baseUrl}`);
