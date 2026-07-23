import { z } from "zod";

export const PRODUCT_ID_ERROR_MESSAGE =
  "商品 ID 必须是 2-80 位字母、数字、中文、下划线或连字符；请传商品列表里的系统编号，不要传商品名称";

/**
 * 商品 ID 是订单、库存、优惠码和支付链路的主关联键。
 * 历史版本会从中文标题生成中文 ID，因此这里兼容中文；同时继续禁止空格、
 * 斜杠、问号等 URL/脚本危险字符，避免把完整商品名称或说明文案误传进来。
 */
export const PRODUCT_ID_PATTERN = /^[\p{L}\p{N}_-]{2,80}$/u;

export const productIdSchema = z.string().trim().regex(PRODUCT_ID_PATTERN, PRODUCT_ID_ERROR_MESSAGE);

export const optionalProductIdSchema = productIdSchema.optional().or(z.literal(""));
