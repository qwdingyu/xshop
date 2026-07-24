import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * SQLite 侧与 shared/canonical-email.ts 对齐的规范化表达式，
 * 用于限购/限流按“同一人”匹配历史订单（订单表可仍存原始邮箱）。
 */
export function sqlCanonicalBuyerEmail(emailExpr: SQLWrapper): SQL {
  const normalized = sql`lower(trim(${emailExpr}))`;
  const atPos = sql`instr(${normalized}, '@')`;
  const plusPos = sql`instr(${normalized}, '+')`;
  const localRaw = sql`substr(${normalized}, 1, ${atPos} - 1)`;
  const localStripped = sql`(CASE
    WHEN ${plusPos} > 0 AND ${plusPos} < ${atPos}
    THEN substr(${normalized}, 1, ${plusPos} - 1)
    ELSE ${localRaw}
  END)`;
  const domainRaw = sql`substr(${normalized}, ${atPos} + 1)`;
  const domain = sql`(CASE
    WHEN ${domainRaw} = 'googlemail.com' THEN 'gmail.com'
    ELSE ${domainRaw}
  END)`;
  const localFinal = sql`(CASE
    WHEN ${domain} = 'gmail.com' THEN replace(${localStripped}, '.', '')
    ELSE ${localStripped}
  END)`;

  return sql`(CASE
    WHEN ${atPos} <= 1 THEN ${normalized}
    ELSE ${localFinal} || '@' || ${domain}
  END)`;
}

export function eqCanonicalBuyerEmail(emailExpr: SQLWrapper, canonicalEmail: string): SQL {
  return sql`${sqlCanonicalBuyerEmail(emailExpr)} = ${canonicalEmail}`;
}
