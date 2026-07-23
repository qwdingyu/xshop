import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { fail, ok, getDb } from "../lib/http";
import { toStorefrontProduct } from "../services/product-service";
import { getSellableStorefrontProduct, getStorefrontCatalog, resolvePublicStorefront } from "../services/storefront-service";

export const productRoute = new Hono<AppEnv>();

function withLiveStockHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  // 商品列表/详情包含动态库存和分类数量，不能被浏览器或边缘缓存复用。
  // 下单接口会用实时库存做最终校验；这里禁缓存是为了让前端展示尽量贴近真实可售状态。
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

productRoute.get("/products", async (c) => {
  const db = getDb(c);
  const catalog = await getStorefrontCatalog(db, c.req.query("storefront"));
  if (!catalog) return withLiveStockHeaders(fail(c, "展示渠道不存在或已停用", 404, { code: "STOREFRONT_NOT_FOUND" }));
  return withLiveStockHeaders(ok(c, {
    storefront: catalog.storefront,
    products: catalog.products.map(toStorefrontProduct),
    categories: catalog.categories,
  }));
});

productRoute.get("/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = getDb(c);
  const storefront = await resolvePublicStorefront(db, c.req.query("storefront"));
  if (!storefront) return withLiveStockHeaders(fail(c, "展示渠道不存在或已停用", 404, { code: "STOREFRONT_NOT_FOUND" }));
  const result = await getSellableStorefrontProduct(db, storefront.id, slug);
  if (!result) return withLiveStockHeaders(fail(c, "商品不属于当前展示渠道或已下架", 404, { code: "PRODUCT_NOT_IN_STOREFRONT" }));

  return withLiveStockHeaders(ok(c, { storefront, product: toStorefrontProduct(result.product) }));
});
