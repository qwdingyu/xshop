/**
 * 商品服务 — 商品列表查询和详情查询。
 *
 * 使用 Drizzle ORM 进行查询，库存通过 stock-service 分步批量统计。
 * 仅返回 active=1 的已上架商品给前端用户。
 */

import { and, eq, or, sql } from "drizzle-orm";
import type { DbType } from "../db/client";
import type { IssueMode, FulfillmentMode } from "../bindings";
import { productCategories, products, storefrontProducts } from "../db/schema";
import { getAvailableStockMap } from "./stock-service";
import { normalizeFulfillmentInputConfig, type FulfillmentInputType } from "../../shared/fulfillment-input";
import {
  hasListDiscount,
  normalizeOriginalPriceCents,
  type DeliveryVisibility,
  type StockDisplayMode,
} from "../../shared/product-contract";

export type StorefrontCategory = {
  id: string;
  name: string;
  count: number;
};

function normalizeDeliveryVisibility(value: unknown): DeliveryVisibility {
  return value === "email_only" ? "email_only" : "web_and_email";
}

function normalizeStockDisplayMode(value: unknown): StockDisplayMode {
  return value === "availability_only" || value === "hidden" ? value : "exact";
}

/** 商品行数据（含库存统计） */
export type ProductRow = {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  salesCopy: string;
  coverUrl: string;
  tagsJson: string;
  priceCents: number;
  /** 可选对比价；公开投影仅在 hasListDiscount 时输出 */
  originalPriceCents?: number | null;
  currency: string;
  issueMode: IssueMode;
  fulfillmentMode: FulfillmentMode;
  active: number;
  stock: number;
  category: string;
  purchaseLimit: number | null;
  purchaseLimitDisplay: number;
  deliveryVisibility: DeliveryVisibility;
  stockDisplayMode: StockDisplayMode;
  fulfillmentInputType?: FulfillmentInputType | string;
  fulfillmentInputLabel?: string;
  fulfillmentInputHint?: string;
  fulfillmentInputRequired?: number;
};

function parseTags(tagsJson: string) {
  try {
    const value = JSON.parse(tagsJson || "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function toPublicProduct(row: ProductRow) {
  const stock = Number(row.stock || 0);
  const requiresInventory = row.fulfillmentMode === "card";
  const canPurchase = !requiresInventory || stock > 0;
  const fulfillmentInput = normalizeFulfillmentInputConfig({
    type: row.fulfillmentInputType,
    label: row.fulfillmentInputLabel,
    hint: row.fulfillmentInputHint,
    required: row.fulfillmentInputRequired,
  });
  return {
    id: row.id,
    slug: row.slug || row.id,
    title: row.title,
    description: row.description,
    salesCopy: row.salesCopy,
    coverUrl: row.coverUrl,
    priceCents: row.priceCents,
    // 仅有效促销输出对比价，避免前端收到原价≤现价的脏数据
    ...(hasListDiscount(row.priceCents, row.originalPriceCents)
      ? { originalPriceCents: normalizeOriginalPriceCents(row.originalPriceCents) as number }
      : {}),
    currency: row.currency,
    issueMode: row.issueMode,
    fulfillmentMode: row.fulfillmentMode,
    stock,
    availableStock: stock,
    requiresInventory,
    canPurchase,
    isOutOfStock: !canPurchase,
    isLowStock: requiresInventory && stock > 0 && stock <= 3,
    tags: parseTags(row.tagsJson),
    active: Number(row.active || 0) === 1,
    category: row.category || "",
    purchaseLimit: row.purchaseLimit,
    purchaseLimitDisplay: Number(row.purchaseLimitDisplay || 0) === 1,
    deliveryVisibility: normalizeDeliveryVisibility(row.deliveryVisibility),
    stockDisplayMode: normalizeStockDisplayMode(row.stockDisplayMode),
    fulfillmentInputType: fulfillmentInput.type,
    fulfillmentInputLabel: fulfillmentInput.label,
    fulfillmentInputHint: fulfillmentInput.hint,
    fulfillmentInputRequired: fulfillmentInput.required,
  };
}

export function toStorefrontProduct(product: ReturnType<typeof toPublicProduct>) {
  const { salesCopy, ...storefrontProduct } = product;
  void salesCopy;
  if (storefrontProduct.stockDisplayMode === "exact") return storefrontProduct;

  // canPurchase/isOutOfStock 是结算入口必须保留的可售状态；精确库存只在 exact 模式下公开。
  const { stock: _stock, availableStock: _availableStock, ...withoutExactStock } = storefrontProduct;
  void _stock;
  void _availableStock;
  if (withoutExactStock.stockDisplayMode === "availability_only") return withoutExactStock;

  // hidden 不能通过“低库存”布尔值反推出库存区间，只保留是否可购买。
  const { isLowStock: _isLowStock, ...hiddenStock } = withoutExactStock;
  void _isLowStock;
  return hiddenStock;
}

const productSelect = {
      id: products.id,
      slug: products.slug,
      title: products.title,
      description: products.description,
      salesCopy: products.salesCopy,
      coverUrl: products.coverUrl,
      tagsJson: products.tagsJson,
      priceCents: products.priceCents,
      originalPriceCents: products.originalPriceCents,
      currency: products.currency,
      issueMode: products.issueMode,
      fulfillmentMode: products.fulfillmentMode,
      active: products.active,
      category: products.category,
      purchaseLimit: products.purchaseLimit,
      purchaseLimitDisplay: products.purchaseLimitDisplay,
      deliveryVisibility: products.deliveryVisibility,
      stockDisplayMode: products.stockDisplayMode,
      fulfillmentInputType: products.fulfillmentInputType,
      fulfillmentInputLabel: products.fulfillmentInputLabel,
      fulfillmentInputHint: products.fulfillmentInputHint,
      fulfillmentInputRequired: products.fulfillmentInputRequired,
};

export async function listProducts(db: DbType, storefrontId?: string) {
  const rows = storefrontId
    ? await db
      .select(productSelect)
      .from(products)
      .innerJoin(storefrontProducts, and(
        eq(storefrontProducts.productId, products.id),
        eq(storefrontProducts.storefrontId, storefrontId),
        eq(storefrontProducts.visible, 1),
      ))
      .where(eq(products.active, 1))
      .orderBy(storefrontProducts.sortOrder, products.createdAt)
    : await db
      .select(productSelect)
      .from(products)
      .where(eq(products.active, 1))
      .orderBy(products.sortOrder, products.createdAt);

  const stockMap = await getAvailableStockMap(db, rows.map((row) => row.id));
  return rows.map((row) => toPublicProduct({
    ...row,
    stock: Number(stockMap.get(row.id) || 0),
    issueMode: row.issueMode as IssueMode,
    fulfillmentMode: row.fulfillmentMode as FulfillmentMode,
    deliveryVisibility: normalizeDeliveryVisibility(row.deliveryVisibility),
    stockDisplayMode: normalizeStockDisplayMode(row.stockDisplayMode),
    purchaseLimitDisplay: Number(row.purchaseLimitDisplay || 0),
  }));
}

export async function listStorefrontCategories(db: DbType, storefrontId?: string): Promise<StorefrontCategory[]> {
  try {
    const categorySelect = {
        id: productCategories.id,
        name: productCategories.name,
        count: sql<number>`COUNT(${products.id})`,
    };
    const rows = storefrontId
      ? await db
        .select(categorySelect)
        .from(productCategories)
        .leftJoin(storefrontProducts, and(
          eq(storefrontProducts.storefrontId, storefrontId),
          eq(storefrontProducts.visible, 1),
        ))
        .leftJoin(products, and(
          eq(products.id, storefrontProducts.productId),
          eq(products.active, 1),
          eq(products.category, productCategories.name),
        ))
        .where(eq(productCategories.active, 1))
        .groupBy(productCategories.id, productCategories.name, productCategories.sortOrder)
        .orderBy(productCategories.sortOrder, productCategories.name)
      : await db
        .select(categorySelect)
        .from(productCategories)
        .leftJoin(products, sql`${products.active} = 1 AND ${products.category} = ${productCategories.name}`)
        .where(eq(productCategories.active, 1))
        .groupBy(productCategories.id, productCategories.name, productCategories.sortOrder)
        .orderBy(productCategories.sortOrder, productCategories.name);

    const configured = rows
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.count || 0) }))
      .filter((row) => row.count > 0);
    if (configured.length > 0) return configured;
  } catch (err) {
    if (!String((err as Error)?.message || err).includes("product_categories")) throw err;
  }

  const legacySelect = {
      name: products.category,
      count: sql<number>`COUNT(${products.id})`,
  };
  const legacyRows = storefrontId
    ? await db
      .select(legacySelect)
      .from(products)
      .innerJoin(storefrontProducts, and(
        eq(storefrontProducts.productId, products.id),
        eq(storefrontProducts.storefrontId, storefrontId),
        eq(storefrontProducts.visible, 1),
      ))
      .where(sql`${products.active} = 1 AND trim(${products.category}) <> ''`)
      .groupBy(products.category)
      .orderBy(products.category)
    : await db
      .select(legacySelect)
      .from(products)
      .where(sql`${products.active} = 1 AND trim(${products.category}) <> ''`)
      .groupBy(products.category)
      .orderBy(products.category);

  return legacyRows.map((row) => ({
    id: row.name,
    name: row.name,
    count: Number(row.count || 0),
  }));
}

export async function getProduct(db: DbType, idOrSlug: string, storefrontId?: string) {
  const detailSelect = {
      id: products.id,
      slug: products.slug,
      title: products.title,
      description: products.description,
      salesCopy: products.salesCopy,
      coverUrl: products.coverUrl,
      tagsJson: products.tagsJson,
      priceCents: products.priceCents,
      originalPriceCents: products.originalPriceCents,
      currency: products.currency,
      issueMode: products.issueMode,
      fulfillmentMode: products.fulfillmentMode,
      active: products.active,
      category: products.category,
      purchaseLimit: products.purchaseLimit,
      purchaseLimitDisplay: products.purchaseLimitDisplay,
      deliveryVisibility: products.deliveryVisibility,
      stockDisplayMode: products.stockDisplayMode,
      fulfillmentInputType: products.fulfillmentInputType,
      fulfillmentInputLabel: products.fulfillmentInputLabel,
      fulfillmentInputHint: products.fulfillmentInputHint,
      fulfillmentInputRequired: products.fulfillmentInputRequired,
  };
  const rows = storefrontId
    ? await db
      .select(detailSelect)
      .from(products)
      .innerJoin(storefrontProducts, and(
        eq(storefrontProducts.productId, products.id),
        eq(storefrontProducts.storefrontId, storefrontId),
        eq(storefrontProducts.visible, 1),
      ))
      .where(and(eq(products.active, 1), or(eq(products.id, idOrSlug), eq(products.slug, idOrSlug))))
      .limit(1)
    : await db
      .select(detailSelect)
      .from(products)
      .where(and(eq(products.active, 1), or(eq(products.id, idOrSlug), eq(products.slug, idOrSlug))))
      .limit(1);
  const [row] = rows;

  if (!row) return null;
  const stockMap = await getAvailableStockMap(db, [row.id]);
  return toPublicProduct({
    ...row,
    stock: Number(stockMap.get(row.id) || 0),
    issueMode: row.issueMode as IssueMode,
    fulfillmentMode: row.fulfillmentMode as FulfillmentMode,
    deliveryVisibility: normalizeDeliveryVisibility(row.deliveryVisibility),
    stockDisplayMode: normalizeStockDisplayMode(row.stockDisplayMode),
    purchaseLimitDisplay: Number(row.purchaseLimitDisplay || 0),
  });
}
