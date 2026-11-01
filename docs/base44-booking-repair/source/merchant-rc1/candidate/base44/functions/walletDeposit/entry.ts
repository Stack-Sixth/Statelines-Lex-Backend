import {syntheticWalletDenied} from '../../shared/syntheticPaymentGuard.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    let userId = null;
    try {
      const u = await base44.auth.me();
      userId = u?.id || null;
    } catch {}
    if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    if(await syntheticWalletDenied(base44.asServiceRole,userId))return Response.json({error:'synthetic_payment_disabled'},{status:403});
    const body = await req.json();
    const amount = Math.round(Number(body.amount) * 100);
    if (!amount || amount < 100) {
      return Response.json({ error: 'Minimum deposit is $1.00' }, { status: 400 });
    }

    const origin = new URL(req.url).origin + '/dashboard/wallet';
    const key = secrets.get('STRIPE_SECRET_KEY');
    if (!key) return Response.json({ error: 'Stripe not configured' }, { status: 500 });

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('payment_method_types[]', 'card');
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(amount));
    params.append('line_items[0][price_data][product_data][name]', 'Statelines Wallet Top-up');
    params.append('success_url', origin + '?deposit=success');
    params.append('cancel_url', origin + '?deposit=cancelled');
    params.append('metadata[base44_app_id]', Deno.env.get('BASE44_APP_ID') || '');
    if (userId) params.append('metadata[user_id]', userId);
    params.append('metadata[type]', 'wallet_deposit');

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': '2025-10-29.clover',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: params
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Stripe checkout error:', data);
      return Response.json({ error: data.error?.message || 'Stripe error' }, { status: 400 });
    }
    return Response.json({ url: data.url });
  } catch (e) {
    console.error('walletDeposit error:', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}