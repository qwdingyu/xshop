import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { productIdSchema } from "../lib/product-id";
import { getIpHash } from "../lib/security";
import { writeAdminAudit } from "../services/audit-service";
import {
  STOREFRONT_SLUG_PATTERN,
  STOREFRONT_TEMPLATE_KEYS,
  createStorefront,
  deleteStorefront,
  getAdminStorefront,
  listAdminStorefronts,
  replaceStorefrontProducts,
  setDefaultStorefront,
  updateStorefrontProductMapping,
  updateStorefront,
} from "../services/storefront-service";

export const adminStorefrontRoute = new Hono<AppEnv>();

const storefrontIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);
const storefrontSlugSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.string().min(2).max(48).regex(STOREFRONT_SLUG_PATTERN),
);
const optionalHttpUrlSchema = z.string().trim().max(500).refine((value) => {
  if (!value) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}, "Logo URL 必须是 HTTPS 地址或站内相对路径");
const optionalEmailSchema = z.string().trim().max(160).refine(
  (value) => !value || z.string().email().safeParse(value).success,
  "客服邮箱格式无效",
).transform((value) => value.toLowerCase());
const storefrontTemplateSchema = z.enum(STOREFRONT_TEMPLATE_KEYS);

const editableStorefrontFields = {
  name: z.string().trim().min(1).max(60),
  logoUrl: optionalHttpUrlSchema,
  supportEmail: optionalEmailSchema,
  templateKey: storefrontTemplateSchema,
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(99999),
};

const createStorefrontSchema = z.object({
  slug: storefrontSlugSchema,
  name: editableStorefrontFields.name,
  logoUrl: editableStorefrontFields.logoUrl.default(""),
  supportEmail: editableStorefrontFields.supportEmail.default(""),
  templateKey: editableStorefrontFields.templateKey.default("compact"),
  active: editableStorefrontFields.active.default(true),
  sortOrder: editableStorefrontFields.sortOrder.default(100),
}).strict();

const updateStorefrontSchema = z.object(editableStorefrontFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提供一个可修改字段");

const replaceProductsSchema = z.object({
  items: z.array(z.object({
    productId: productIdSchema,
    visible: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(99999).default(100),
  }).strict()).max(1000),
  // 默认 /shop 允许被明确清空，但必须由管理端显式确认，不能只依赖浏览器 UI。
  allowEmptyDefault: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.productId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "productId"],
        message: "商品不能重复",
      });
    }
    seen.add(item.productId);
  });
});

const updateProductMappingSchema = z.object({
  visible: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(99999).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个可修改字段");

function parseStorefrontId(value: string) {
  return storefrontIdSchema.safeParse(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  const text = [value.code, value.message, (value.cause as { message?: unknown } | undefined)?.message]
    .filter(Boolean)
    .join(" ");
  return text.includes("SQLITE_CONSTRAINT_UNIQUE") || text.includes("UNIQUE constraint failed");
}

adminStorefrontRoute.get("/", async (c) => {
  const storefronts = await listAdminStorefronts(getDb(c));
  return ok(c, { storefronts });
});

adminStorefrontRoute.post("/", async (c) => {
  const body = createStorefrontSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  try {
    const id = await createStorefront(db, body.data);
    await writeAdminAudit(db, {
      action: "create_storefront",
      targetType: "storefront",
      targetId: id,
      metadata: {
        slug: body.data.slug,
        name: body.data.name,
        templateKey: body.data.templateKey,
        active: body.data.active,
        sortOrder: body.data.sortOrder,
      },
      ipHash: await getIpHash(c),
    });
    const storefront = await getAdminStorefront(db, id);
    return ok(c, { id, storefront }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) return fail(c, "展示渠道 slug 已存在", 409);
    throw error;
  }
});

adminStorefrontRoute.get("/:id", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());
  const storefront = await getAdminStorefront(getDb(c), id.data);
  if (!storefront) return fail(c, "展示渠道不存在", 404);
  return ok(c, storefront);
});

adminStorefrontRoute.patch("/:id", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());
  const body = updateStorefrontSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await updateStorefront(db, id.data, body.data);
  if (!result.updated) {
    const status = result.reason === "展示渠道不存在" ? 404 : 409;
    return fail(c, result.reason || "更新展示渠道失败", status);
  }
  await writeAdminAudit(db, {
    action: "update_storefront",
    targetType: "storefront",
    targetId: id.data,
    metadata: { changedFields: Object.keys(body.data) },
    ipHash: await getIpHash(c),
  });
  return ok(c, { id: id.data });
});

adminStorefrontRoute.put("/:id/products", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());
  const body = replaceProductsSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await replaceStorefrontProducts(db, id.data, body.data.items, body.data.allowEmptyDefault);
  if (!result.updated) {
    const status = result.reason === "展示渠道不存在"
      ? 404
      : result.reason === "默认展示渠道没有可见商品，请明确确认后再保存"
        ? 409
        : 400;
    return fail(c, result.reason || "更新渠道商品失败", status);
  }
  await writeAdminAudit(db, {
    action: "replace_storefront_products",
    targetType: "storefront",
    targetId: id.data,
    metadata: {
      count: body.data.items.length,
      visibleCount: body.data.items.filter((item) => item.visible).length,
    },
    ipHash: await getIpHash(c),
  });
  return ok(c, { id: id.data, count: result.count || 0 });
});

adminStorefrontRoute.patch("/:id/products/:productId", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());
  const productId = productIdSchema.safeParse(c.req.param("productId"));
  if (!productId.success) return fail(c, "商品 ID 无效", 400, productId.error.flatten());
  const body = updateProductMappingSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请求参数无效", 400, body.error.flatten());

  const db = getDb(c);
  const result = await updateStorefrontProductMapping(db, id.data, productId.data, body.data);
  if (!result.updated) return fail(c, result.reason || "更新渠道商品失败", 404);
  await writeAdminAudit(db, {
    action: "update_storefront_product",
    targetType: "storefront",
    targetId: id.data,
    metadata: {
      productId: productId.data,
      changedFields: Object.keys(body.data),
    },
    ipHash: await getIpHash(c),
  });
  return ok(c, { id: id.data, productId: productId.data });
});

adminStorefrontRoute.post("/:id/set-default", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());

  const db = getDb(c);
  const result = await setDefaultStorefront(db, id.data);
  if (!result.updated) {
    const status = result.reason === "展示渠道不存在" ? 404 : 409;
    return fail(c, result.reason || "设置默认展示渠道失败", status);
  }
  await writeAdminAudit(db, {
    action: "set_default_storefront",
    targetType: "storefront",
    targetId: id.data,
    ipHash: await getIpHash(c),
  });
  return ok(c, { id: id.data, isDefault: true });
});

adminStorefrontRoute.delete("/:id", async (c) => {
  const id = parseStorefrontId(c.req.param("id"));
  if (!id.success) return fail(c, "展示渠道 ID 无效", 400, id.error.flatten());

  const db = getDb(c);
  const result = await deleteStorefront(db, id.data);
  if (!result.deleted) {
    const status = result.reason === "展示渠道不存在" ? 404 : 409;
    return fail(c, result.reason || "删除展示渠道失败", status);
  }
  await writeAdminAudit(db, {
    action: "delete_storefront",
    targetType: "storefront",
    targetId: id.data,
    ipHash: await getIpHash(c),
  });
  return ok(c, { deleted: id.data });
});
