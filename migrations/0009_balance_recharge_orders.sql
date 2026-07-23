-- UP
CREATE TABLE IF NOT EXISTS balance_recharge_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  buyer_email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  payment_provider TEXT NOT NULL,
  payment_ref TEXT NOT NULL DEFAULT '',
  order_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_recharge_order_no
  ON balance_recharge_orders(order_no);
CREATE INDEX IF NOT EXISTS idx_balance_recharge_email_created
  ON balance_recharge_orders(buyer_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_recharge_status_expires
  ON balance_recharge_orders(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_recharge_payment_ref_unique
  ON balance_recharge_orders(payment_provider, payment_ref)
  WHERE payment_ref <> '';

-- DOWN
DROP INDEX IF EXISTS idx_balance_recharge_payment_ref_unique;
DROP INDEX IF EXISTS idx_balance_recharge_status_expires;
DROP INDEX IF EXISTS idx_balance_recharge_email_created;
DROP INDEX IF EXISTS idx_balance_recharge_order_no;
DROP TABLE IF EXISTS balance_recharge_orders;
