import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { DbType } from "../db/client";
import { withDbTransaction } from "../db/client";
import { orders, products, storefrontProducts, storefronts, systemConfig } from "../db/schema";
import { getProduct, listProducts, listStorefrontCategories } from "./product-service";

export const STOREFRONT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STOREFRONT_TEMPLATE_KEYS = ["catalog", "compact"] as const;
export type StorefrontTemplateKey = typeof STOREFRONT_TEMPLATE_KEYS[number];

export type PublicStorefront = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string;
  supportEmail: string;
  templateKey: StorefrontTemplateKey;
  isDefault: boolean;
  homePath: string;
};

export type StorefrontProductInput = {
  productId: string;
  visible: boolean;
  sortOrder: number;
};

function toPublicStorefront(row: {
  id: string;
  slug: string;
  name: string;
  logoUrl: string;
  supportEmail: string;
  templateKey: string;
  isDefault: number;
}, globalSupportEmail = ""): PublicStorefront {
  const isDefault = row.isDefault === 1;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logoUrl: row.logoUrl,
    supportEmail: row.supportEmail || globalSupportEmail,
    // 数据库 CHECK 是最终约束；这里保留防御性回退，避免旧测试库或人工数据让前端收到任意组件键。
    templateKey: row.templateKey === "compact" ? "compact" : "catalog",
    isDefault,
    homePath: isDefault ? "/shop" : `/s/${row.slug}`,
  };
}

async function globalSupportEmail(db: DbType): Promise<string> {
  const [row] = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, "support_email"))
    .limit(1);
  return row?.value?.trim() || "";
}

export async function resolvePublicStorefront(db: DbType, slug?: string): Promise<PublicStorefront | null> {
  const normalizedSlug = slug?.trim().toLowerCase();
  const [row] = await db
    .select({
      id: storefronts.id,
      slug: storefronts.slug,
      name: storefronts.name,
      logoUrl: storefronts.logoUrl,
      supportEmail: storefronts.supportEmail,
      templateKey: storefronts.templateKey,
      isDefault: storefronts.isDefault,
    })
    .from(storefronts)
    .where(and(
      eq(storefronts.active, 1),
      normalizedSlug ? eq(storefronts.slug, normalizedSlug) : eq(storefronts.isDefault, 1),
    ))
    .limit(1);
  if (!row) return null;
  return toPublicStorefront(row, row.supportEmail ? "" : await globalSupportEmail(db));
}

export async function getActiveStorefrontById(db: DbType, id: string): Promise<PublicStorefront | null> {
  const [row] = await db
    .select({
      id: storefronts.id,
      slug: storefronts.slug,
      name: storefronts.name,
      logoUrl: storefronts.logoUrl,
      supportEmail: storefronts.supportEmail,
      templateKey: storefronts.templateKey,
      isDefault: storefronts.isDefault,
    })
    .from(storefronts)
    .where(and(eq(storefronts.id, id), eq(storefronts.active, 1)))
    .limit(1);
  if (!row) return null;
  return toPublicStorefront(row, row.supportEmail ? "" : await globalSupportEmail(db));
}

export async function getStorefrontCatalog(db: DbType, slug?: string) {
  const storefront = await resolvePublicStorefront(db, slug);
  if (!storefront) return null;
  const [catalogProducts, categories] = await Promise.all([
    listProducts(db, storefront.id),
    listStorefrontCategories(db, storefront.id),
  ]);
  return { storefront, products: catalogProducts, categories };
}

export async function getSellableStorefrontProduct(db: DbType, storefrontId: string, productIdOrSlug: string) {
  const storefront = await getActiveStorefrontById(db, storefrontId);
  if (!storefront) return null;
  const product = await getProduct(db, productIdOrSlug, storefront.id);
  return product ? { storefront, product } : null;
}

/**
 * 结算事务内的最终映射校验。这里不读取库存，库存仍由 fulfillment-service 在同一事务内锁定。
 */
export async function validateStorefrontProductMapping(db: DbType, storefrontId: string, productId: string) {
  const storefront = await getActiveStorefrontById(db, storefrontId);
  if (!storefront) return null;
  const [mapping] = await db
    .select({ productId: storefrontProducts.productId })
    .from(storefrontProducts)
    .innerJoin(products, and(eq(products.id, storefrontProducts.productId), eq(products.active, 1)))
    .where(and(
      eq(storefrontProducts.storefrontId, storefrontId),
      eq(storefrontProducts.productId, productId),
      eq(storefrontProducts.visible, 1),
    ))
    .limit(1);
  return mapping ? storefront : null;
}

export async function listAdminStorefronts(db: DbType) {
  // 计数单独按渠道聚合：避免相关子查询中未限定的 id 被内层 orders.id 遮蔽，
  // 也避免同时 JOIN 商品和订单后形成大量笛卡尔中间行。
  const [rows, productCountRows, orderCountRows] = await Promise.all([
    db
      .select({
        id: storefronts.id,
        slug: storefronts.slug,
        name: storefronts.name,
        logoUrl: storefronts.logoUrl,
        supportEmail: storefronts.supportEmail,
        templateKey: storefronts.templateKey,
        active: storefronts.active,
        isDefault: storefronts.isDefault,
        sortOrder: storefronts.sortOrder,
        createdAt: storefronts.createdAt,
        updatedAt: storefronts.updatedAt,
      })
      .from(storefronts)
      .orderBy(asc(storefronts.sortOrder), asc(storefronts.name)),
    db
      .select({ storefrontId: storefrontProducts.storefrontId, value: count() })
      .from(storefrontProducts)
      .where(eq(storefrontProducts.visible, 1))
      .groupBy(storefrontProducts.storefrontId),
    db
      .select({ storefrontId: orders.storefrontId, value: count() })
      .from(orders)
      .groupBy(orders.storefrontId),
  ]);
  const productCounts = new Map(productCountRows.map((row) => [row.storefrontId, Number(row.value || 0)]));
  const orderCounts = new Map(orderCountRows.flatMap((row) => row.storefrontId
    ? [[row.storefrontId, Number(row.value || 0)] as const]
    : []));
  return rows.map((row) => ({
    ...row,
    active: row.active === 1,
    isDefault: row.isDefault === 1,
    productCount: productCounts.get(row.id) || 0,
    orderCount: orderCounts.get(row.id) || 0,
    homePath: row.isDefault === 1 ? "/shop" : `/s/${row.slug}`,
  }));
}

export async function getAdminStorefront(db: DbType, id: string) {
  const [storefront] = (await listAdminStorefronts(db)).filter((item) => item.id === id);
  if (!storefront) return null;
  const mappings = await db
    .select({
      productId: storefrontProducts.productId,
      productTitle: products.title,
      visible: storefrontProducts.visible,
      sortOrder: storefrontProducts.sortOrder,
    })
    .from(storefrontProducts)
    .innerJoin(products, eq(products.id, storefrontProducts.productId))
    .where(eq(storefrontProducts.storefrontId, id))
    .orderBy(asc(storefrontProducts.sortOrder), asc(products.title));
  return {
    storefront,
    products: mappings.map((item) => ({ ...item, visible: item.visible === 1 })),
  };
}

export async function createStorefront(db: DbType, input: {
  slug: string;
  name: string;
  logoUrl?: string;
  supportEmail?: string;
  templateKey?: StorefrontTemplateKey;
  active?: boolean;
  sortOrder?: number;
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(storefronts).values({
    id,
    slug: input.slug.trim().toLowerCase(),
    name: input.name.trim(),
    logoUrl: input.logoUrl?.trim() || "",
    supportEmail: input.supportEmail?.trim().toLowerCase() || "",
    // 新渠道通常承载卡密/兑换码等窄信息商品，默认使用紧凑列表；管理员可显式改为图片目录。
    templateKey: input.templateKey || "compact",
    active: input.active === false ? 0 : 1,
    isDefault: 0,
    sortOrder: input.sortOrder ?? 100,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateStorefront(db: DbType, id: string, input: {
  name?: string;
  logoUrl?: string;
  supportEmail?: string;
  templateKey?: StorefrontTemplateKey;
  active?: boolean;
  sortOrder?: number;
}): Promise<{ updated: boolean; reason?: string }> {
  const [existing] = await db.select({ id: storefronts.id, isDefault: storefronts.isDefault }).from(storefronts).where(eq(storefronts.id, id)).limit(1);
  if (!existing) return { updated: false, reason: "展示渠道不存在" };
  if (existing.isDefault === 1 && input.active === false) return { updated: false, reason: "默认展示渠道不可停用" };
  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) values.name = input.name.trim();
  if (input.logoUrl !== undefined) values.logoUrl = input.logoUrl.trim();
  if (input.supportEmail !== undefined) values.supportEmail = input.supportEmail.trim().toLowerCase();
  if (input.templateKey !== undefined) values.templateKey = input.templateKey;
  if (input.active !== undefined) values.active = input.active ? 1 : 0;
  if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;
  await db.update(storefronts).set(values).where(eq(storefronts.id, id));
  return { updated: true };
}

export async function replaceStorefrontProducts(
  db: DbType,
  storefrontId: string,
  items: StorefrontProductInput[],
  allowEmptyDefault = false,
) {
  const uniqueItems = Array.from(new Map(items.map((item) => [item.productId, item])).values());
  return withDbTransaction(db, async (tx) => {
    const [storefront] = await tx.select({ id: storefronts.id, isDefault: storefronts.isDefault }).from(storefronts).where(eq(storefronts.id, storefrontId)).limit(1);
    if (!storefront) return { updated: false, reason: "展示渠道不存在" };
    const visibleCount = uniqueItems.filter((item) => item.visible).length;
    if (storefront.isDefault === 1 && visibleCount === 0 && !allowEmptyDefault) {
      return { updated: false, reason: "默认展示渠道没有可见商品，请明确确认后再保存" };
    }
    if (uniqueItems.length > 0) {
      const existingProducts = await tx.select({ id: products.id }).from(products).where(inArray(products.id, uniqueItems.map((item) => item.productId)));
      if (existingProducts.length !== uniqueItems.length) return { updated: false, reason: "包含不存在的商品" };
    }
    await tx.delete(storefrontProducts).where(eq(storefrontProducts.storefrontId, storefrontId));
    if (uniqueItems.length > 0) {
      const now = new Date().toISOString();
      await tx.insert(storefrontProducts).values(uniqueItems.map((item) => ({
        storefrontId,
        productId: item.productId,
        visible: item.visible ? 1 : 0,
        sortOrder: item.sortOrder,
        createdAt: now,
        updatedAt: now,
      })));
    }
    return { updated: true, count: uniqueItems.length };
  });
}

export async function updateStorefrontProductMapping(
  db: DbType,
  storefrontId: string,
  productId: string,
  input: Partial<Pick<StorefrontProductInput, "visible" | "sortOrder">>,
): Promise<{ updated: boolean; reason?: string }> {
  const [mapping] = await db
    .select({
      storefrontId: storefrontProducts.storefrontId,
      productId: storefrontProducts.productId,
    })
    .from(storefrontProducts)
    .where(and(
      eq(storefrontProducts.storefrontId, storefrontId),
      eq(storefrontProducts.productId, productId),
    ))
    .limit(1);
  if (!mapping) return { updated: false, reason: "商品未分配到该展示渠道" };

  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.visible !== undefined) values.visible = input.visible ? 1 : 0;
  if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;
  await db
    .update(storefrontProducts)
    .set(values)
    .where(and(
      eq(storefrontProducts.storefrontId, storefrontId),
      eq(storefrontProducts.productId, productId),
    ));
  return { updated: true };
}

export async function setDefaultStorefront(db: DbType, id: string) {
  return withDbTransaction(db, async (tx) => {
    const [target] = await tx.select({ id: storefronts.id, active: storefronts.active }).from(storefronts).where(eq(storefronts.id, id)).limit(1);
    if (!target) return { updated: false, reason: "展示渠道不存在" };
    if (target.active !== 1) return { updated: false, reason: "停用的展示渠道不能设为默认" };
    await tx.update(storefronts).set({ isDefault: 0, updatedAt: new Date().toISOString() }).where(eq(storefronts.isDefault, 1));
    await tx.update(storefronts).set({ isDefault: 1, updatedAt: new Date().toISOString() }).where(eq(storefronts.id, id));
    return { updated: true };
  });
}

export async function deleteStorefront(db: DbType, id: string) {
  return withDbTransaction(db, async (tx) => {
    const [row] = await tx.select({ id: storefronts.id, isDefault: storefronts.isDefault }).from(storefronts).where(eq(storefronts.id, id)).limit(1);
    if (!row) return { deleted: false, reason: "展示渠道不存在" };
    if (row.isDefault === 1) return { deleted: false, reason: "默认展示渠道不可删除" };
    const [usage] = await tx.select({ count: count() }).from(orders).where(eq(orders.storefrontId, id));
    if (Number(usage?.count || 0) > 0) return { deleted: false, reason: "该渠道已有历史订单，只能停用" };
    await tx.delete(storefrontProducts).where(eq(storefrontProducts.storefrontId, id));
    await tx.delete(storefronts).where(eq(storefronts.id, id));
    return { deleted: true };
  });
}
