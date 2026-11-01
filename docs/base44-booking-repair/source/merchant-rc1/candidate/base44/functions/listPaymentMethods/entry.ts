import {syntheticPaymentDenied} from '../../shared/syntheticPaymentGuard.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { secrets } from 'base44:runtime';
import { resolveCallerMerchant } from '../../shared/portalMemberships.ts';
import { callStripe, getPaymentProfile } from '../../shared/stripeCustomer.ts';

// The merchant's saved cards, read live from Stripe. The app stores no card
// data of its own — only the Stripe customer id that holds them.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const merchantId = String(body.merchant_id || '');
    if (!merchantId) return Response.json({ error: 'merchant_id is required' }, { status: 400 });

    // The merchant is resolved from the caller's own identity and the posted id
    // must match it, so one account can never list another account's cards.
    const merchant = await resolveCallerMerchant(base44.asServiceRole, user);
    if (!merchant || merchant.id !== merchantId) {
      console.error('listPaymentMethods: merchant mismatch for user', user.id);
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    if(syntheticPaymentDenied(merchant))return Response.json({error:'synthetic_payment_disabled'},{status:403});
    const key = secrets.get('STRIPE_SECRET_KEY');
    if (!key) return Response.json({ error: 'Stripe not configured' }, { status: 500 });

    // Returned so the client can mount Stripe's own card fields. A publishable
    // key is public by design; the secret key never leaves this server.
    const publishableKey = secrets.get('STRIPE_PUBLISHABLE_KEY') || '';

    const profile = await getPaymentProfile(base44, merchant.id);
    const customerId = profile?.stripe_customer_id;
    if (!customerId)     return Response.json({ methods: [], default_id: null, publishable_key: publishableKey });

    const [customerRes, cardsRes] = await Promise.all([
      callStripe(key, `/customers/${customerId}`),
      callStripe(key, `/customers/${customerId}/payment_methods?type=card&limit=10`),
    ]);

    // A customer deleted in Stripe simply means there are no cards on file.
    if (customerRes.status === 404)     return Response.json({ methods: [], default_id: null, publishable_key: publishableKey });

    if (!cardsRes.ok) {
      console.error('listPaymentMethods: stripe error', cardsRes.status, cardsRes.data?.error?.message);
      return Response.json({ error: cardsRes.data?.error?.message || 'Stripe error' }, { status: 400 });
    }

    const methods = (cardsRes.data?.data || []).map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '',
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null,
    }));
    const rawDefault = customerRes.data?.invoice_settings?.default_payment_method;
    const defaultId = (typeof rawDefault === 'string' ? rawDefault : rawDefault?.id) || null;

    return Response.json({ methods, default_id: defaultId, publishable_key: publishableKey });
  } catch (error) {
    console.error('listPaymentMethods error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}