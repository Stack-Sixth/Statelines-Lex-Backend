import type { recordAuthority } from "./serverRecord.ts";
// Server-only. Requires protected claim fields and single-id write-time CAS.
// No lease expiry: an old owner may still be executing after any timeout.
export class ClaimPending extends Error {
  constructor(
    public code: string,
    public identity?: unknown,
  ) {
    super(code);
  }
}
export function claimResponse(e: unknown): Response | null {
  return e instanceof ClaimPending
    ? Response.json(
        { pending: true, code: e.code, identity: e.identity },
        { status: 202 },
      )
    : null;
}
export const absent = { $exists: false };
export function expected(row: any, field: string) {
  return Object.hasOwn(row, field) ? row[field] : absent;
}
// Match only a vacant field; never overwrite an existing command identity.
export function vacant(row: any, field: string) {
  return row[field] == null ? expected(row, field) : absent;
}
export async function cas(
  entity: any,
  id: string,
  condition: any,
  changes: any,
): Promise<boolean> {
  let result;
  try {
    result = await entity.updateMany({ id, ...condition }, { $set: changes });
  } catch {
    throw new ClaimPending("cas_outcome_unknown");
  }
  // Truthiness, success:true, missing/ambiguous results are NOT ownership.
  if (result?.updated === 1) return true;
  if (result?.updated === 0) return false;
  throw new ClaimPending("cas_result_unknown");
}
export function equal(a: unknown, b: unknown): boolean {
  const norm = (x: any): any =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, norm(x[k])]),
          )
        : x;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
// Fresh callers only acquire an absent claim. Recovery never generates a new id.
export async function acquireCommand(
  entity: any,
  id: string,
  prefix: string,
  proposed: any,
  guard: any = {},
) {
  const field = `${prefix}_claim`;
  const before = await entity.get(id);
  const owner = await cas(
    entity,
    id,
    {
      [field]: vacant(before, field),
      lifecycle_revision: expected(before, "lifecycle_revision"),
      ...guard,
    },
    {
      [field]: proposed,
      [`${prefix}_state`]: "sending",
      lifecycle_revision: (Number(before.lifecycle_revision) || 0) + 1,
      lifecycle_history: [
        ...(before.lifecycle_history || []),
        {
          action: prefix + ".claimed",
          command_id: proposed.command_id,
          at: new Date().toISOString(),
        },
      ],
    },
  );
  const row = await entity.get(id);
  const stored = row[field];
  if (!stored || !stored.command_id || !stored.payload)
    throw new ClaimPending("claim_not_visible");
  if (!owner) return { owner: false, claim: stored };
  if (!equal(stored, proposed))
    throw new ClaimPending("claim_identity_conflict");
  return { owner: true, claim: stored };
}
// Only explicit ambiguous responses may release an attempt back to retryable.
// A process crash during POST leaves sending forever: read/reconcile or operator
// review, never automatic lease takeover. Backend same-command idempotency remains mandatory.
export async function retryCommand(
  entity: any,
  id: string,
  prefix: string,
  claim: any,
) {
  const row = await entity.get(id);
  if (row[`${prefix}_state`] !== "retryable") return false;
  return cas(
    entity,
    id,
    { [`${prefix}_state`]: "retryable" },
    { [`${prefix}_state`]: "sending" },
  );
}
export async function markCommand(
  entity: any,
  id: string,
  prefix: string,
  claim: any,
  state: string,
) {
  return cas(
    entity,
    id,
    { [`${prefix}_state`]: "sending" },
    { [`${prefix}_state`]: state },
  );
}

// The existing Draft is the shared intent. The existing Quote prevents another
// draft consuming that same quote. No Shipment is inserted before both claims.
export async function finalizeIntent(
  entities: any,
  draftId: string,
  quoteId: string,
  owner: { user_id: string; merchant_id: string; edit_revision?: number },
  candidate: any,
  authority: ReturnType<typeof recordAuthority>,
  allowCreate = true,
) {
  const D = entities.ShipmentDraft,
    Q = entities.ShipmentQuote,
    S = entities.Shipment;
  let draft = await D.get(draftId);
  if (
    !(await authority.trusted("ShipmentDraft", draft)) ||
    draft.server_owner_user_id !== owner.user_id ||
    draft.merchant_id !== owner.merchant_id
  )
    throw new ClaimPending("legacy_or_untrusted_draft");
  if (draft.archived_at) throw new ClaimPending("draft_archived");
  if (!draft.booking_claim && draft.edit_revision !== owner.edit_revision)
    throw new ClaimPending("draft_revision_changed_before_claim");
  if (!draft.booking_claim && !allowCreate)
    throw new ClaimPending("booking_release_closed");
  if (!draft.booking_claim) {
    const claim = {
      intent: `draft:${draftId}`,
      quote_id: quoteId,
      ...owner,
      snapshot: candidate,
    };
    await cas(
      D,
      draftId,
      {
        booking_claim: vacant(draft, "booking_claim"),
        archived_at: expected(draft, "archived_at"),
        edit_revision: expected(draft, "edit_revision"),
      },
      { booking_claim: claim, booking_state: "claimed" },
    );
    draft = await D.get(draftId);
  }
  let c = draft.booking_claim;
  let state = draft.booking_state;
  if (
    !c ||
    c.quote_id !== quoteId ||
    c.user_id !== owner.user_id ||
    c.merchant_id !== owner.merchant_id
  )
    throw new ClaimPending("draft_intent_conflict");
  // Candidate is ignored on retries; first validated snapshot is immutable.
  let quote = await Q.get(quoteId);
  if ((state === "claimed" || state === "reserved") && !allowCreate)
    throw new ClaimPending("booking_release_closed_resume_only");
  if (state === "claimed") {
    if (!quote.reservation_intent) {
      const now = new Date().toISOString();
      await cas(
        Q,
        quoteId,
        {
          status: "open",
          reservation_intent: vacant(quote, "reservation_intent"),
          expires_at: { $gt: now },
          user_id: owner.user_id,
          merchant_id: owner.merchant_id,
        },
        {
          status: "reserved",
          reservation_intent: c.intent,
          reservation_draft_id: draftId,
        },
      );
      quote = await Q.get(quoteId);
    }
    if (
      quote.reservation_intent !== c.intent ||
      !["reserved", "consumed"].includes(quote.status)
    )
      throw new ClaimPending("quote_reserved_elsewhere_or_expired");
    await cas(
      D,
      draftId,
      { booking_state: "claimed" },
      { booking_state: "reserved" },
    );
    draft = await D.get(draftId);
    c = draft.booking_claim;
    state = draft.booking_state;
  }
  if (state === "reserved") {
    const won = await cas(
      D,
      draftId,
      { booking_state: "reserved" },
      { booking_state: "creating" },
    );
    if (won) {
      // NEVER repeat this insert after an exception, process death or lost response.
      // The next invocation only searches this intent.
      if (!c.snapshot) throw new ClaimPending("missing_validated_snapshot");
      let created;
      try {
        created = await S.create({
          ...c.snapshot,
          ...(await authority.mint("Shipment", c.user_id, c.merchant_id)),
          booking_ready: false,
          lifecycle_revision: 0,
          lifecycle_history: [
            {
              action: "shipment.created",
              actor_id: c.user_id,
              at: new Date().toISOString(),
            },
          ],
          test_harness: c.snapshot.test_harness === true,
          booking_intent: c.intent,
          merchant_owner_user_id: c.user_id,
          order_id: c.intent,
          idempotency_key: c.intent,
        });
      } catch {
        throw new ClaimPending("create_outcome_unknown");
      }
      await cas(
        D,
        draftId,
        { booking_state: "creating" },
        { booking_state: "linked", booking_shipment_id: created.id },
      );
    }
    draft = await D.get(draftId);
    c = draft.booking_claim;
    state = draft.booking_state;
  }
  if (state === "creating") {
    // Bounded query is safe for adoption only: at most one insert can be issued
    // by this protocol. Existing/imported duplicates stop recovery.
    const rows = await S.filter(
      { booking_intent: c.intent },
      "-created_date",
      2,
    );
    if (rows.length !== 1)
      throw new ClaimPending(
        rows.length ? "duplicate_intent_rows" : "create_outcome_unknown",
      );
    const row = rows[0];
    if (
      !(await authority.trusted("Shipment", row)) ||
      row.quote_id !== c.quote_id ||
      row.merchant_id !== c.merchant_id ||
      row.merchant_owner_user_id !== c.user_id
    )
      throw new ClaimPending("intent_row_identity_conflict");
    await cas(
      D,
      draftId,
      { booking_state: "creating" },
      { booking_state: "linked", booking_shipment_id: row.id },
    );
    draft = await D.get(draftId);
    c = draft.booking_claim;
    state = draft.booking_state;
  }
  if (!["linked", "complete"].includes(state))
    throw new ClaimPending("finalize_in_progress");
  const row = await S.get(draft.booking_shipment_id);
  if (
    !(await authority.trusted("Shipment", row)) ||
    row.booking_intent !== c.intent ||
    row.merchant_id !== c.merchant_id ||
    row.quote_id !== c.quote_id ||
    row.merchant_owner_user_id !== c.user_id
  )
    throw new ClaimPending("linked_shipment_identity_conflict");
  quote = await Q.get(quoteId);
  if (quote.status !== "consumed") {
    await cas(
      Q,
      quoteId,
      { status: "reserved", reservation_intent: c.intent },
      {
        status: "consumed",
        consumed_by_shipment_id: row.id,
        consumed_at: new Date().toISOString(),
      },
    );
    quote = await Q.get(quoteId);
  }
  if (
    quote.status !== "consumed" ||
    quote.reservation_intent !== c.intent ||
    quote.consumed_by_shipment_id !== row.id
  )
    throw new ClaimPending("quote_settlement_conflict");
  if (state !== "complete")
    await cas(
      D,
      draftId,
      { booking_state: "linked" },
      {
        booking_state: "complete",
        status: "booked",
        shipment_id: row.id,
        lifecycle_history: [
          ...(draft.lifecycle_history || []),
          {
            action: "draft.booked",
            actor_id: c.user_id,
            at: new Date().toISOString(),
            shipment_id: row.id,
          },
        ],
      },
    );
  const settled = await D.get(draftId);
  if (settled.booking_state !== "complete" || settled.shipment_id !== row.id)
    throw new ClaimPending("draft_settlement_pending");
  await cas(S, row.id, { booking_ready: false }, { booking_ready: true });
  return S.get(row.id);
}
