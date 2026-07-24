/**
 * 买家邮箱规范化：用于限购、限流、冷却等“同一人”判定。
 * 订单表仍可保存用户填写的原始邮箱（交付与展示）。
 *
 * 规则（保守、可测）：
 * 1. trim + toLowerCase
 * 2. 去掉 local-part 中 + 及之后（user+tag@gmail.com → user@gmail.com）
 * 3. 仅对 gmail.com / googlemail.com：去掉 local 中的点，并将 googlemail.com → gmail.com
 * 4. 不对其他域名去点（避免误伤合法不同邮箱）
 */
export function canonicalBuyerEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return normalized;

  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);

  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.replace(/\./g, "");
  }

  return `${local}@${domain}`;
}
