import {syntheticPaymentDenied} from './syntheticPaymentGuard.ts';
// Shared Stripe customer helpers for merchant card-on-file.
//
// The Stripe customer that owns a merchant's saved cards is recorded in the
// service-role-written PaymentProfile record, never on the client-writable
// Merchant record — otherwise a merchant could point its own account at
// another merchant's customer and see or extend someone else's cards.
//
// Card numbers are entered on Stripe's own form and never reach this app; only
// the brand and last four digits are read back for display.

import { resolveCallerMerchant } from "./portalMemberships.ts";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2025-10-29.clover";

// One Stripe call. Mutations are form-encoded with an idempotency key, so a
// retried request can never create a second customer or checkout session.
export async function callStripe(key, path, options: any = {}) {
  const method = options.method || "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_VERSION,
  };
  if (options.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
  }
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: options.body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// The caller's own payment profile for a merchant, or null when the merchant
// has never added a card. Read with the service role: the record is
// admin-only, so no client can read or forge it.
export async function getPaymentProfile(base44, merchantId) {
  const page = await base44.asServiceRole.entities.PaymentProfile.filter(
    { merchant_id: merchantId },
    { sort: "-created_date", limit: 1 }
  );
  return (page?.items || [])[0] || null;
}

export async function saveCustomerId(base44, { merchantId, userId, email, customerId }) {
  return await base44.asServiceRole.entities.PaymentProfile.create({
    merchant_id: merchantId,
    user_id: userId,
    customer_email: email || "",
    stripe_customer_id: customerId,
  });
}

// Resolves the merchant the caller is allowed to act on. The posted merchant id
// is never trusted on its own: it must be the caller's own merchant, so one
// account can never read or change another account's saved cards. Returns
// either { user, merchant, body }, or an { error, status } the caller sends
// straight back to the client.
export async function resolveOwnedMerchant(base44, req, label) {
  const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
  if (!user) return { error: "Unauthorized", status: 401 };

  const body = await req.json().catch(() => ({}));
  const merchantId = String(body.merchant_id || "");
  if (!merchantId) return { error: "merchant_id is required", status: 400 };

  const merchant = await resolveCallerMerchant(base44.asServiceRole, user);
  if (!merchant || merchant.id !== merchantId) {
    console.error(`${label}: merchant mismatch for user`, user.id);
    return { error: "Forbidden", status: 403 };
  }
  if(syntheticPaymentDenied(merchant))return {error:'synthetic_payment_disabled',status:403};
  return { user, merchant, body };
}

// The merchant's Stripe customer, created on first use so every card a merchant
// saves accumulates on one customer. Returns { customerId, profile } or
// { error }.
export async function getOrCreateStripeCustomer(base44, { key, merchant, user, appId }) {
  const profile = await getPaymentProfile(base44, merchant.id);
  let customerId = profile?.stripe_customer_id || null;
  if (customerId) {
    const existing = await callStripe(key, `/customers/${customerId}`);
    if (existing.status !== 404) return { customerId, profile };
    customerId = null; // customer deleted in Stripe — start a fresh one
  }

  const params = new URLSearchParams();
  params.append("email", user.email || merchant.contact_email || "");
  params.append("name", merchant.company_name || user.full_name || "");
  params.append("metadata[base44_app_id]", appId);
  params.append("metadata[merchant_id]", merchant.id);

  const created = await callStripe(key, "/customers", { method: "POST", body: params });
  if (!created.ok) {
    console.error("getOrCreateStripeCustomer: customer create failed", created.data?.error?.message);
    return { error: created.data?.error?.message || "Stripe error" };
  }

  const saved = await saveCustomerId(base44, {
    merchantId: merchant.id,
    userId: user.id,
    email: user.email || merchant.contact_email || "",
    customerId: created.data.id,
  });
  return { customerId: created.data.id, profile: saved };
}

// The card a shipment may be booked against: the card the caller chose when it
// belongs to their own Stripe customer, otherwise the account default, else the
// account's single saved card. Returns { paymentMethod, customerId }, or
// { error } when the account has no card on file at all.
export async function resolveSavedCard(base44, { key, merchant, preferredId }): Promise<any> {
  const profile = await getPaymentProfile(base44, merchant.id);
  const customerId = profile?.stripe_customer_id || null;
  if (!customerId) return { error: 'No saved payment method on this account' };

  const cardsRes = await callStripe(key, `/customers/${customerId}/payment_methods?type=card&limit=10`);
  const cards = cardsRes.ok ? (cardsRes.data?.data || []) : [];
  if (cards.length === 0) return { error: 'No saved payment method on this account' };

  // A card id that is not on this customer is ignored rather than trusted.
  let card = preferredId ? cards.find((c) => c.id === preferredId) : null;
  if (!card) {
    const customerRes = await callStripe(key, `/customers/${customerId}`);
    const rawDefault = customerRes.data?.invoice_settings?.default_payment_method;
    const defaultId = (typeof rawDefault === 'string' ? rawDefault : rawDefault?.id) || null;
    card = cards.find((c) => c.id === defaultId) || cards[0];
  }

  return { paymentMethod: card, customerId };
}