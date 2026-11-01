// ONE payment configuration object, resolved before any Stripe request.
//
// The Merchant app charges merchants with the live account key. A controlled
// test must never reach that account, and no handler may call Stripe before
// authorization. This module is the single place that decides whether a
// TEST-MODE payment path is available at all.
//
// Current state: test payments are DISABLED. The test slot is honoured only when
// the operator sets TEST_PAYMENT_ENABLED AND both sandbox values are present AND
// they are test-mode keys. A live key parked in the test slot is refused rather
// than used as a fallback, and the live key is never read by a test path.
//
// Pure: takes a presence probe, returns no secret value.

export const TEST_PAYMENT_SECRET = "STRIPE_SANDBOX_SECRET_KEY";
export const TEST_PUBLISHABLE_SECRET = "STRIPE_SANDBOX_PUBLISHABLE_KEY";
export const LIVE_PAYMENT_SECRET = "STRIPE_SECRET_KEY";
export const TEST_PAYMENT_FLAG = "TEST_PAYMENT_ENABLED";

export type PaymentMode = "test" | "disabled";

export interface PaymentConfiguration {
  mode: PaymentMode;
  /** True only for an enabled, test-key-only configuration. */
  enabled: boolean;
  flag_enabled: boolean;
  test_secret_present: boolean;
  test_publishable_present: boolean;
  live_key_present: boolean;
  refusal: "flag_off" | "not_configured" | "live_key_in_test_slot" | null;
  code: string;
  message: string;
}

export function resolvePaymentConfiguration(
  readSecret: (name: string) => string,
): PaymentConfiguration {
  const secret = String(readSecret(TEST_PAYMENT_SECRET) || "");
  const publishable = String(readSecret(TEST_PUBLISHABLE_SECRET) || "");
  const flagEnabled = String(readSecret(TEST_PAYMENT_FLAG) || "").toLowerCase() === "true";
  const liveKeyPresent = Boolean(readSecret(LIVE_PAYMENT_SECRET));

  const base = {
    flag_enabled: flagEnabled,
    test_secret_present: Boolean(secret),
    test_publishable_present: Boolean(publishable),
    live_key_present: liveKeyPresent,
  };

  if (!flagEnabled) {
    return {
      ...base,
      mode: "disabled",
      enabled: false,
      refusal: "flag_off",
      code: "test_payment_disabled",
      message: "Test payments are switched off. Payment-required test booking is not available.",
    };
  }

  if (!secret || !publishable) {
    return {
      ...base,
      mode: "disabled",
      enabled: false,
      refusal: "not_configured",
      code: "test_payment_not_configured",
      message: "No test-mode payment configuration is present.",
    };
  }

  if (!secret.startsWith("sk_test_") || !publishable.startsWith("pk_test_")) {
    return {
      ...base,
      mode: "disabled",
      enabled: false,
      refusal: "live_key_in_test_slot",
      code: "test_payment_refused",
      message: "The test slot holds a non-test key; it is refused, not used as a fallback.",
    };
  }

  return {
    ...base,
    mode: "test",
    enabled: true,
    refusal: null,
    code: "test_payment_ready",
    message: "Test-mode payment is enabled for test-mode objects only.",
  };
}

/**
 * A payment call is allowed only through a configuration this function returns
 * with enabled === true. Callers must check that before any Stripe request —
 * including an early preflight and an admin path.
 */
export function paymentCallsAllowed(config: PaymentConfiguration): boolean {
  return config.mode === "test" && config.enabled === true;
}