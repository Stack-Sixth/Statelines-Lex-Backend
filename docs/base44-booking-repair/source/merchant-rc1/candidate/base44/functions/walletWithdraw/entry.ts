import {syntheticWalletDenied} from '../../shared/syntheticPaymentGuard.ts';
// Server-side withdrawal request handler. The client requests a payout; the
// balance check and the pending debit are computed and created here so the
// entity API can never be used to request more than the user actually holds.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    if(await syntheticWalletDenied(base44.asServiceRole,user.id))return Response.json({error:'synthetic_payment_disabled'},{status:403});
    const body = await req.json().catch(() => ({}));
    const amount = Number(body.amount);
    const bankId = String(body.bank_id || '');
    if (!Number.isFinite(amount) || amount < 1) {
      return Response.json({ error: 'Minimum withdrawal is $1.00.' }, { status: 400 });
    }
    if (!bankId) {
      return Response.json({ error: 'A verified bank account is required.' }, { status: 400 });
    }

    // The bank account must belong to the caller and be verified.
    const bank = await base44.entities.BankAccount.get(bankId).catch(() => null);
    if (!bank || bank.created_by_id !== user.id || bank.status !== 'verified') {
      return Response.json({ error: 'Bank account not found or not verified.' }, { status: 404 });
    }

    // Reserve-then-verify to close the TOCTOU window: the pending debit is
    // created FIRST, then the total reserved is re-checked against the settled
    // balance. Concurrent withdrawals each create their debit before either
    // verifies, so the verification sees every concurrent reservation and the
    // one that pushes the total over is rolled back.
    const last4 = String(bank.account_number || '').slice(-4);
    // Service-role create: WalletTransaction create RLS is admin-only, so the
    // debit must be issued server-side. The service role stamps its own
    // internal identity as creator, so the caller is tied via user_id.
    const tx = await base44.asServiceRole.entities.WalletTransaction.create({
      type: 'debit',
      amount,
      status: 'pending',
      description: `Withdrawal to ${bank.bank_name || 'bank'} ••••${last4}`,
      reference: bankId,
      user_id: user.id,
    });

    // Settled balance: only credits with a server-issued reference count
    // (stripeWebhook sets reference to the Stripe session id; the reward
    // function sets it to the shipment id). Credits without a reference are
    // ignored — they are either stale client-created rows or fabricated.
    // Server-issued rows are stamped with the service identity, not the
    // caller's, so both balances are keyed on user_id.
    const settledPage = await base44.asServiceRole.entities.WalletTransaction.filter(
      { user_id: user.id, status: 'available' },
      { limit: 500, sort: '-created_date' }
    );
    // All pending debits (including the one just created) are reserved funds.
    const pendingPage = await base44.asServiceRole.entities.WalletTransaction.filter(
      { user_id: user.id, type: 'debit', status: 'pending' },
      { limit: 500, sort: '-created_date' }
    );
    let settled = 0;
    for (const t of settledPage.items) {
      if (t.type === 'debit') settled -= t.amount;
      else if (t.reference) settled += t.amount;
    }
    let totalPending = 0;
    for (const t of pendingPage.items) totalPending += t.amount;

    if (totalPending > settled) {
      // This withdrawal (together with any concurrent ones) overdraws the
      // wallet — roll back the reservation we just made.
      await base44.asServiceRole.entities.WalletTransaction.delete(tx.id).catch(() => {});
      const available = Math.max(0, settled - (totalPending - amount));
      return Response.json(
        { error: `Insufficient funds. Available balance is $${available.toFixed(2)}.` },
        { status: 400 }
      );
    }

    const available = settled - totalPending;
    try {
      await base44.entities.Notification.create({
        title: 'Withdrawal requested',
        body: `$${amount.toFixed(2)} withdrawal to ${bank.bank_name} is pending processing.`,
        type: 'billing',
      });
    } catch {}

    return Response.json({ ok: true, transaction_id: tx.id, available });
  } catch (e) {
    console.error('walletWithdraw error:', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}