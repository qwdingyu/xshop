export const DEFAULT_OFFLINE_PAY_HINT =
  "请扫码付款，转账备注填写付款备注码，完成后提交付款流水号后 4 位。";

const LEGACY_BOOLEAN_HINT_RE = /^(true|false)(\s|$)/i;
const GENERATED_SMOKE_HINT_RE = /^线下付款 smoke 提示 \d+$/;

export function normalizeOfflinePayHintForSmoke(value) {
  if (LEGACY_BOOLEAN_HINT_RE.test(value) || GENERATED_SMOKE_HINT_RE.test(value)) {
    return DEFAULT_OFFLINE_PAY_HINT;
  }
  return value;
}
