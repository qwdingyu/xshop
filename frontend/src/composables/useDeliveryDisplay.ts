/**
 * 交付信息展示工具。
 *
 * 虚拟资料（non-card）模式下，deliveryJson 可能包含任意字段（url、code、text、inviteCode、content 等），
 * 需要按字段名映射为可读的中文标签，同时过滤掉卡密模式的专用字段（accountLabel / deliverySecret / deliveryNote）。
 *
 * 被 OrderView.vue 和 LookupView.vue 共用。
 */

/** 卡密模式专用字段——这些字段在虚拟资料交付中不展示 */
const CARD_FIELDS = ['accountLabel', 'deliverySecret', 'deliveryNote'];

/** 虚拟资料字段 → 中文标签映射 */
const FIELD_LABELS: Record<string, string> = {
  accountLabel: '名称',
  deliverySecret: '内容',
  deliveryNote: '备注',
  url: '链接',
  code: '兑换码',
  text: '内容',
  inviteCode: '邀请码',
  content: '内容',
};

function isCardField(key: string): boolean {
  return CARD_FIELDS.includes(key);
}

/** 获取交付字段的中文标签。未知字段原样返回。 */
export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] || key;
}

/**
 * 从 delivery 对象中过滤出非卡密模式的展示条目。
 * 返回 [字段名, 字段值] 数组，直接用于 v-for 渲染。
 */
export function getDeliveryEntries(
  delivery: Record<string, unknown> | undefined | null,
  options: { includeLegacyDeliveryFields?: boolean } = {},
): Array<[string, string]> {
  if (!delivery) return [];
  return Object.entries(delivery)
    .filter(([key, value]) => (options.includeLegacyDeliveryFields || !isCardField(key)) && value)
    .map(([key, value]) => [key, String(value)] as [string, string]);
}
