import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { createDb, type DbType } from "../db/client";
import { runMigrations } from "../db/migrations";
import { orders, products, storefrontProducts, storefronts } from "../db/schema";
import { eq, ne } from "drizzle-orm";
import {
  createStorefront,
  deleteStorefront,
  getSellableStorefrontProduct,
  getStorefrontCatalog,
  listAdminStorefronts,
  replaceStorefrontProducts,
  setDefaultStorefront,
  updateStorefrontProductMapping,
  updateStorefront,
} from "./storefront-service";
import { createProduct, updateProduct } from "./admin-service";

describe("storefront-service with libSQL", () => {
  let client: Client;
  let db: DbType;

  beforeAll(async () => {
    // 事务可能使用另一连接；整个测试文件共享同一个内存数据库和迁移结果。
    client = createClient({ url: "file::memory:?cache=shared" });
    db = createDb(client);
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(orders);
    await db.delete(storefrontProducts);
    await db.delete(products);
    await db.delete(storefronts).where(ne(storefronts.id, "sf_default"));
    await db.update(storefronts).set({ active: 1, isDefault: 1 }).where(eq(storefronts.id, "sf_default"));
    const now = new Date().toISOString();
    await db.insert(products).values({
      id: "prod-1",
      slug: "product-one",
      title: "Product One",
      priceCents: 100,
      currency: "CNY",
      fulfillmentMode: "virtual",
      issueMode: "manual",
      active: 1,
      category: "Software",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(storefrontProducts).values({
      storefrontId: "sf_default",
      productId: "prod-1",
      visible: 1,
      sortOrder: 10,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(() => client.close());

  it("returns a scoped default catalog and canonical home path", async () => {
    const catalog = await getStorefrontCatalog(db);
    expect(catalog?.storefront).toMatchObject({ id: "sf_default", slug: "shop", templateKey: "catalog", homePath: "/shop", isDefault: true });
    expect(catalog?.products.map((product) => product.id)).toEqual(["prod-1"]);
  });

  it("defaults new channels to compact and persists an explicit template change", async () => {
    const storefrontId = await createStorefront(db, { slug: "codes", name: "Codes" });
    expect((await listAdminStorefronts(db)).find((item) => item.id === storefrontId)).toMatchObject({ templateKey: "compact" });

    await expect(updateStorefront(db, storefrontId, { templateKey: "catalog" })).resolves.toEqual({ updated: true });
    expect((await listAdminStorefronts(db)).find((item) => item.id === storefrontId)).toMatchObject({ templateKey: "catalog" });
  });

  it("persists a product cover and exposes it through the default storefront catalog", async () => {
    await updateProduct(db, "prod-1", { coverUrl: "https://cdn.example.test/product.webp" });

    const catalog = await getStorefrontCatalog(db);
    expect(catalog?.products[0]?.coverUrl).toBe("https://cdn.example.test/product.webp");
  });

  it("does not sell a globally active product without a visible mapping", async () => {
    const storefrontId = await createStorefront(db, { slug: "accounts", name: "Accounts" });
    expect(await getSellableStorefrontProduct(db, storefrontId, "prod-1")).toBeNull();
    await replaceStorefrontProducts(db, storefrontId, [{ productId: "prod-1", visible: true, sortOrder: 1 }]);
    expect((await getSellableStorefrontProduct(db, storefrontId, "prod-1"))?.product.id).toBe("prod-1");
  });

  it("switches the single default atomically and protects historical storefronts", async () => {
    const storefrontId = await createStorefront(db, { slug: "software", name: "Software" });
    expect(await setDefaultStorefront(db, storefrontId)).toEqual({ updated: true });
    expect((await getStorefrontCatalog(db))?.storefront).toMatchObject({ id: storefrontId, homePath: "/shop" });
    expect(await deleteStorefront(db, storefrontId)).toEqual({ deleted: false, reason: "默认展示渠道不可删除" });
  });

  it("does not set an inactive storefront as default", async () => {
    const storefrontId = await createStorefront(db, { slug: "inactive", name: "Inactive", active: false });

    expect(await setDefaultStorefront(db, storefrontId)).toEqual({
      updated: false,
      reason: "停用的展示渠道不能设为默认",
    });
    expect((await getStorefrontCatalog(db))?.storefront.id).toBe("sf_default");
  });

  it("protects a non-default storefront after it has historical orders", async () => {
    const storefrontId = await createStorefront(db, { slug: "history", name: "History" });
    await db.insert(orders).values({
      id: "order-history",
      orderNo: "ORDER-HISTORY",
      productId: "prod-1",
      orderSource: "storefront",
      storefrontId,
      storefrontSlugSnapshot: "history",
      storefrontNameSnapshot: "History",
      buyerContact: "buyer@example.com",
      buyerEmail: "buyer@example.com",
      status: "issued",
      createdAt: new Date().toISOString(),
    });

    expect(await deleteStorefront(db, storefrontId)).toEqual({
      deleted: false,
      reason: "该渠道已有历史订单，只能停用",
    });
  });

  it("reports visible product and historical order counts without inner id shadowing", async () => {
    await db.insert(orders).values({
      id: "order-default-count",
      orderNo: "ORDER-DEFAULT-COUNT",
      productId: "prod-1",
      orderSource: "storefront",
      storefrontId: "sf_default",
      storefrontSlugSnapshot: "shop",
      storefrontNameSnapshot: "Shop",
      buyerContact: "buyer@example.com",
      buyerEmail: "buyer@example.com",
      status: "issued",
      createdAt: new Date().toISOString(),
    });

    const defaultStorefront = (await listAdminStorefronts(db)).find((item) => item.id === "sf_default");
    expect(defaultStorefront).toMatchObject({ productCount: 1, orderCount: 1 });
  });

  it("keeps the existing mapping when a replacement contains an unknown product", async () => {
    const result = await replaceStorefrontProducts(db, "sf_default", [
      { productId: "prod-1", visible: true, sortOrder: 20 },
      { productId: "missing-product", visible: true, sortOrder: 30 },
    ]);

    expect(result).toEqual({ updated: false, reason: "包含不存在的商品" });
    expect((await getStorefrontCatalog(db))?.products.map((product) => product.id)).toEqual(["prod-1"]);
  });

  it("requires explicit confirmation before clearing visible products from /shop", async () => {
    await expect(replaceStorefrontProducts(db, "sf_default", [])).resolves.toEqual({
      updated: false,
      reason: "默认展示渠道没有可见商品，请明确确认后再保存",
    });
    expect((await getStorefrontCatalog(db))?.products.map((product) => product.id)).toEqual(["prod-1"]);

    await expect(replaceStorefrontProducts(db, "sf_default", [], true)).resolves.toEqual({
      updated: true,
      count: 0,
    });
    expect((await getStorefrontCatalog(db))?.products).toEqual([]);
  });

  it("updates a single storefront mapping sort order in place", async () => {
    const storefrontId = await createStorefront(db, { slug: "sort-test", name: "Sort Test" });
    await replaceStorefrontProducts(db, storefrontId, [{ productId: "prod-1", visible: true, sortOrder: 10 }], true);

    await expect(updateStorefrontProductMapping(db, storefrontId, "prod-1", { sortOrder: 2 })).resolves.toEqual({ updated: true });
    const mappings = await db
      .select({ sortOrder: storefrontProducts.sortOrder })
      .from(storefrontProducts)
      .where(eq(storefrontProducts.storefrontId, storefrontId));
    expect(mappings[0]?.sortOrder).toBe(2);
  });

  it("publishes a newly created product to the current default storefront by default", async () => {
    const productId = await createProduct(db, {
      id: "prod-default-publish",
      title: "Default Publish",
      description: "",
      salesCopy: "",
      coverUrl: "",
      tagsJson: "[]",
      priceCents: 100,
      currency: "CNY",
      fulfillmentMode: "virtual",
      issueMode: "manual",
      active: true,
      category: "Software",
      sortOrder: 20,
      purchaseLimit: null,
    });

    expect(productId).toBe("prod-default-publish");
    const mappings = await db
      .select({ storefrontId: storefrontProducts.storefrontId })
      .from(storefrontProducts)
      .where(eq(storefrontProducts.productId, productId));
    expect(mappings).toEqual([{ storefrontId: "sf_default" }]);
  });
});
