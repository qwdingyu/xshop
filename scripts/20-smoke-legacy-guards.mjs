import { textRequest } from "./http-client.mjs";

/*
 * Legacy entrypoint guard smoke.
 *
 * Ensures removed public order-creation paths cannot silently create orders
 * outside the unified payment state machine. This is intentionally no-side-effect:
 * both requests must fail before product lookup, stock locking, coupon reservation,
 * or order creation.
 */

async function expectLegacyDisabled(path, expectedCode) {
  const response = await textRequest(path, {
    method: "POST",
    body: JSON.stringify({
      productId: "legacy-guard-smoke",
      buyerEmail: "legacy-guard@example.test",
      quantity: 1,
      turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || "",
    }),
  });

  let data;
  try {
    data = JSON.parse(response.raw || "{}");
  } catch {
    throw new Error(`${path} returned non-json: ${response.raw.slice(0, 200)}`);
  }

  if (response.statusCode !== 410) {
    throw new Error(`${path} must return HTTP 410, got ${response.statusCode}: ${JSON.stringify(data)}`);
  }
  if (data.ok !== false || data.details?.code !== expectedCode) {
    throw new Error(`${path} returned unexpected legacy guard payload: ${JSON.stringify(data)}`);
  }
  if (!String(data.error || "").includes("/api/pay/unified")) {
    throw new Error(`${path} must direct clients to /api/pay/unified: ${JSON.stringify(data)}`);
  }
}

await expectLegacyDisabled("/api/orders", "LEGACY_ORDER_DISABLED");

console.log("eshop legacy guard smoke passed: /api/orders creation disabled");
