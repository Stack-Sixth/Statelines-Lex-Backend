import {syntheticWalletDenied} from '../../shared/syntheticPaymentGuard.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { secrets } from 'base44:runtime';

async function verifySignature(rawBody, sigHeader, secret) {
  const parts = {};
  for (const part of (sigHeader || '').split(',')) {
    const [k, v] = part.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return null;
  const payload = `${t}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== v1) return null;
  const ageMs = Date.now() - Number(t) * 1000;
  if (ageMs > 5 * 60 * 1000) return null;
  return Number(t);
}

export default async function (req) {
  try {
    // v2: idempotent wallet crediting
    const rawBody = await req.text();
    const sig = req.headers.get('stripe-signature') || '';
    const secret = secrets.get('STRIPE_WEBHOOK_SECRET');
    if (!secret) return Response.json({ error: 'Webhook secret not set' }, { status: 500 });

    const verified = await verifySignature(rawBody, sig, secret);
    if (!verified) return Response.json({ error: 'Invalid signature' }, { status: 400 });

    const event = JSON.parse(rawBody);
    const base44 = createClientFromRequest(req);
    const _dedupeVersion = 2;

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.metadata?.type === 'wallet_deposit') {
        // Only credit when the payment actually succeeded.
        if (s.payment_status && s.payment_status !== 'paid') {
          return Response.json({ received: true, skipped: 'unpaid' });
        }
        // Idempotency: a re-delivered or retried event must not double-credit.
        const existing = await base44.asServiceRole.entities.WalletTransaction.filter(
          { reference: s.id, type: 'credit' },
          { limit: 1, fields: ['id'] }
        );
        if (existing.items && existing.items.length > 0) {
          return Response.json({ received: true, skipped: 'duplicate' });
        }
        const amount = s.amount_total / 100;
        const userId = s.metadata?.user_id || null;
        if (!userId) {
          // Deposits always originate from a logged-in user; a session without
          // user_id cannot be attributed to any wallet.
          console.error('stripeWebhook: wallet_deposit missing user_id, session', s.id);
          return Response.json({ received: true, skipped: 'missing_user_id' });
        }
        if(await syntheticWalletDenied(base44.asServiceRole,userId)) {
          await base44.asServiceRole.entities.AuditLog.create({actor_id:userId,action:'synthetic_payment_event_held',entity:'StripeEvent',entity_id:event.id||s.id,
            detail:'Authenticated payment event for synthetic account held; no wallet credit or notification issued. Operator review required.'});
          return Response.json({received:true,held:true,skipped:'synthetic_payment_disabled'});
        }
        // The service role stamps its own identity as creator; user_id carries
        // the wallet owner.
        await base44.asServiceRole.entities.WalletTransaction.create({
          type: 'credit',
          amount,
          description: 'Wallet top-up via card',
          status: 'available',
          reference: s.id,
          user_id: userId
        });
        if (userId) {
          try {
            await base44.asServiceRole.entities.Notification.create({
              title: 'Wallet topped up',
              body: `$${amount.toFixed(2)} was added to your wallet.`,
              type: 'system',
              created_by_id: userId
            });
          } catch {}
        }
      }
    }

    return Response.json({ received: true });
  } catch (e) {
    console.error('stripeWebhook error:', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}