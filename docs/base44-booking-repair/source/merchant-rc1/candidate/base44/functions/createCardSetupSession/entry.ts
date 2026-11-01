import {syntheticPaymentDenied} from '../../shared/syntheticPaymentGuard.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { secrets } from 'base44:runtime';
import { resolveCallerMerchant } from '../../shared/portalMemberships.ts';
import { callStripe, getOrCreateStripeCustomer } from '../../shared/stripeCustomer.ts';

// Starts a Stripe card-entry session for the caller's own merchant. The card
// is captured on Stripe's hosted form, so no card number ever reaches the app,
// and the card is saved on the merchant's Stripe customer rather than charged.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const merchantId = String(body.merchant_id || '');
    if (!merchantId) return Response.json({ error: 'merchant_id is required' }, { status: 400 });

    // Never trust the posted merchant id: it must be the caller's own merchant.
    const merchant = await resolveCallerMerchant(base44.asServiceRole, user);
    if (!merchant || merchant.id !== merchantId) {
      console.error('createCardSetupSession: merchant mismatch for user', user.id);
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    if(syntheticPaymentDenied(merchant))return Response.json({error:'synthetic_payment_disabled'},{status:403});
    const key = secrets.get('STRIPE_SECRET_KEY');
    if (!key) return Response.json({ error: 'Stripe not configured' }, { status: 500 });

    // Return URLs come from the server-set app URL header so the card form
    // returns to this app — custom domain or platform domain — and never to an
    // internal runtime address.
    const appUrl = req.headers.get('X-Base44-App-Url');
    if (!appUrl) {
      console.error('createCardSetupSession: missing X-Base44-App-Url header');
      return Response.json({ error: 'App URL unavailable' }, { status: 400 });
    }
    const base = appUrl.replace(/\/+$/, '');
    const appId = Deno.env.get('BASE44_APP_ID') || '';

    // One Stripe customer per merchant, so saved cards accumulate in one place.
    const customer = await getOrCreateStripeCustomer(base44, { key, merchant, user, appId });
    if (customer.error) return Response.json({ error: customer.error }, { status: 400 });
    const customerId = customer.customerId;
    const profile = customer.profile;

    const params = new URLSearchParams();
    params.append('mode', 'setup');
    params.append('payment_method_types[]', 'card');
    params.append('customer', customerId);
    params.append('success_url', `${base}/dashboard/create?card_setup=success`);
    params.append('cancel_url', `${base}/dashboard/create?card_setup=cancelled`);
    params.append('metadata[base44_app_id]', appId);
    params.append('metadata[merchant_id]', merchant.id);
    params.append('metadata[base44_user_id]', user.id);

    const session = await callStripe(key, '/checkout/sessions', { method: 'POST', body: params });
    if (!session.ok) {
      console.error('createCardSetupSession: checkout session failed', session.data?.error?.message);
      return Response.json({ error: session.data?.error?.message || 'Stripe error' }, { status: 400 });
    }

    // Record the session on the merchant's payment profile before the caller is
    // sent to it, so the card that comes back can always be traced to a session
    // this server created.
    if (profile?.id) {
      try {
        await base44.asServiceRole.entities.PaymentProfile.update(profile.id, {
          last_setup_session_id: session.data.id,
        });
      } catch (e) {
        console.error('createCardSetupSession: profile update failed', e.message);
      }
    }

    return Response.json({ url: session.data.url, session_id: session.data.id });
  } catch (error) {
    console.error('createCardSetupSession error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}