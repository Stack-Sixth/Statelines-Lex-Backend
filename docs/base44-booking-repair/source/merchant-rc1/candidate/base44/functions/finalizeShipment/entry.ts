import {screenBooking} from "../../shared/complianceBooking.ts";
import {settleBookingDeclaration,settleBookingNotification} from "../../shared/declarationProjection.ts";
import { customerShipment } from "../../shared/customerShipment.ts";
import { recordAuthority } from "../../shared/serverRecord.ts";
import {
  finalizeIntent,
  claimResponse,
  ClaimPending,
  equal,
} from "../../shared/casBooking.ts";
import { findExceptionByMerchant } from "../../shared/bookingException.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { resolveBookingMerchant as resolveCallerMerchant } from "../../shared/bookingMerchant.ts";
import { resolveSavedCard } from "../../shared/stripeCustomer.ts";
import { settlePrice, RATE_VERSION, round2 } from "../../shared/rateQuote.ts";

// Books a shipment against the caller's saved card.
//
// PRICE INTEGRITY: the amount stored on the booking is never taken from the
// browser. The merchant accepts a persisted quote (ShipmentQuote, issued by
// requestLiveRate); this function re-derives the price from the same rate
// engine and refuses the booking when
//   - the quote does not exist, belongs to another account, or was already used,
//   - the quote has expired, or the engine's rate version has changed,
//   - the quote was issued for different parcel inputs than the ones posted,
//   - the accepted total differs from the authoritative total.
// Each of those returns the authoritative amount so the client can show the
// merchant the real price instead of silently booking at a different one.
//
// PAYMENT: a saved card is required and re-checked server-side. No capture is
// performed at booking — the app records payment_capture_status
// "not_captured" and the amount that would be charged. See the operator report
// for the capture step, which is out of scope for this change.

const defaultDependencies = {
  screenBooking,settleBookingDeclaration,settleBookingNotification,
  customerShipment,
  recordAuthority,
  finalizeIntent,
  claimResponse,
  ClaimPending,
  equal,
  findExceptionByMerchant,
  createClientFromRequest,
  secrets,
  resolveCallerMerchant,
  resolveSavedCard,
  settlePrice,
  RATE_VERSION,
  round2,
};

export default async function (req: Request): Promise<Response> {
  return finalizeShipmentWithDependencies(req, defaultDependencies);
}

// Test seam: dependencies are server imports, never request/body options.
export async function finalizeShipmentWithDependencies(
  req: Request,
  deps: typeof defaultDependencies,
): Promise<Response> {
  const {
    screenBooking,settleBookingDeclaration,settleBookingNotification,
    customerShipment,
    recordAuthority,
    finalizeIntent,
    claimResponse,
    ClaimPending,
    equal,
    findExceptionByMerchant,
    createClientFromRequest,
    secrets,
    resolveCallerMerchant,
    resolveSavedCard,
    settlePrice,
    RATE_VERSION,
    round2,
  } = deps;
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth
      .me()
      .catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const draftId = String(body.draft_id || "");
    let shipment =
      body.shipment && typeof body.shipment === "object" ? body.shipment : null;
    const quoteInput =
      body.quote && typeof body.quote === "object" ? body.quote : {};
    if (!draftId)
      return Response.json({ error: "draft_id is required" }, { status: 400 });
    if (!shipment)
      return Response.json({ error: "shipment is required" }, { status: 400 });

    // Read through the caller's own client, so another account's draft is
    // simply not visible here.
    const draft = await base44.asServiceRole.entities.ShipmentDraft.get(
      draftId,
    ).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (!draft)
      return Response.json({ error: "Draft not found" }, { status: 404 });

    const merchant = await resolveCallerMerchant(base44.asServiceRole, user);
    if (!merchant)
      return Response.json(
        { error: "No shipping account for this user" },
        { status: 403 },
      );

    const synthetic = !!findExceptionByMerchant({
      local_merchant_id: merchant.id,
    });
    const allowCreate =
      !synthetic && secrets.get("BOOKING_RELEASE_ENABLED") === "true";
    const proof = recordAuthority(
      secrets.get("MERCHANT_RECORD_SIGNING_SECRET"),
    );
    const trustedDraft = await proof.trusted("ShipmentDraft", draft);
    if (
      (trustedDraft ? draft.server_owner_user_id : draft.created_by_id) !==
      user.id
    )
      return Response.json({ error: "Draft not found" }, { status: 404 });
    if (!trustedDraft || draft.merchant_id !== merchant.id)
      throw new ClaimPending("legacy_draft_review_required");
    if (draft.archived_at) throw new ClaimPending("draft_archived");
    if (draft.booking_claim) {
      // Resume the immutable server-validated snapshot without repeating card I/O
      // or requiring a consumed quote to become open again.
      const existing = await finalizeIntent(
        base44.asServiceRole.entities,
        draftId,
        draft.booking_claim.quote_id,
        {
          user_id: user.id,
          merchant_id: merchant.id,
          edit_revision: draft.edit_revision,
        },
        null,
        proof,
        allowCreate,
      );
      await settleBookingDeclaration(base44.asServiceRole.entities,existing,secrets.get("MERCHANT_RECORD_SIGNING_SECRET")!);
      await settleBookingNotification(base44.asServiceRole.entities,existing,secrets.get("MERCHANT_RECORD_SIGNING_SECRET")!);
      return Response.json({
        shipment: existing,
        draft_id: draftId,
        duplicate: true,
        resumed: true,
        quote_id: draft.booking_claim.quote_id,
        quote: {
          total: existing.cost,
          currency: existing.currency,
          rate_version: existing.rate_version,
        },
      });
    }
    if (synthetic)
      return Response.json(
        { error: "synthetic_payment_disabled" },
        { status: 403 },
      );
    if (!allowCreate)
      return Response.json(
        { error: "booking_release_closed" },
        { status: 409 },
      );
    const selectedPaymentMethod =
      typeof shipment.payment_method_id === "string"
        ? shipment.payment_method_id
        : undefined;
    const posted = customerShipment(shipment);
    const saved = customerShipment(draft.data || {});
    if (!equal(posted, saved))
      throw new ClaimPending("draft_payload_changed_save_first");
    shipment = saved;
    const weightKg =
      Math.round(Number(shipment.weight_lb) * 0.45359237 * 100) / 100;
    if (!Number.isFinite(weightKg) || weightKg <= 0)
      return Response.json(
        { error: "Positive routable weight required" },
        { status: 400 },
      );
    const complianceEvidence = await screenBooking(req,draft,merchant);
    const key = secrets.get("STRIPE_SECRET_KEY");
    if (!key)
      return Response.json({ error: "Stripe not configured" }, { status: 500 });

    // The card this shipment is booked against: the caller's chosen card when
    // it belongs to their own Stripe customer, otherwise their account default.
    // An account with no card is refused here rather than in the browser only.
    const card = await resolveSavedCard(base44, {
      key,
      merchant,
      preferredId: selectedPaymentMethod,
    });
    if (card.error) {
      console.error(
        "finalizeShipment: blocked, no saved payment method for merchant",
        merchant.id,
      );
      return Response.json(
        {
          error: "payment_method_required",
          message: "Add a saved payment method before booking this shipment.",
        },
        { status: 402 },
      );
    }

    const originAddress = String(shipment.origin_address || "").trim();
    const destinationAddress = String(
      shipment.destination_address || "",
    ).trim();
    if (!originAddress || !destinationAddress) {
      return Response.json(
        { error: "Origin and destination addresses are required" },
        { status: 400 },
      );
    }

    // ---------- authoritative price ----------
    const sr = base44.asServiceRole;
    const quoteId = String(quoteInput.quote_id || "");
    if (!quoteId) {
      return Response.json(
        {
          error: "quote_required",
          message: "A quote must be requested before booking this shipment.",
        },
        { status: 400 },
      );
    }

    const storedQuote = await sr.entities.ShipmentQuote.get(quoteId).catch(
      (e) => (e.status === 404 ? null : Promise.reject(e)),
    );
    if (!storedQuote)
      return Response.json({ error: "quote_not_found" }, { status: 404 });
    if (
      storedQuote.user_id !== user.id ||
      storedQuote.merchant_id !== merchant.id
    ) {
      return Response.json({ error: "quote_not_found" }, { status: 404 });
    }

    if(Number(storedQuote.rewards_points||0)!==0)return Response.json({error:'rewards_redemption_unavailable',message:'Request and explicitly accept a new quote without unverified rewards redemption.'},{status:409});

    // Re-derive from the parcel inputs the merchant is actually booking.
    const authoritative = settlePrice({
      weight_lb: Number(shipment.weight_lb) || 0,
      declared_value: Number(shipment.declared_value) || 0,
      service_level: shipment.service_level,
      insurance: shipment.insurance === true,
      promo_code: storedQuote.promo_code,
      rewards_points: storedQuote.rewards_points,
    });

    const inputsMatch =
      round2(Number(storedQuote.weight_lb) || 0) ===
        round2(Number(shipment.weight_lb) || 0) &&
      round2(Number(storedQuote.declared_value) || 0) ===
        round2(Number(shipment.declared_value) || 0) &&
      String(storedQuote.service_level || "") === authoritative.service_level &&
      Boolean(storedQuote.insurance) === (shipment.insurance === true);

    const citiesMatch =
      (!storedQuote.origin_city ||
        storedQuote.origin_city === shipment.origin_city) &&
      (!storedQuote.destination_city ||
        storedQuote.destination_city === shipment.destination_city);

    const expired =
      new Date(storedQuote.expires_at || 0).getTime() <= Date.now();
    const staleRate = storedQuote.rate_version !== RATE_VERSION;
    const amountDrift =
      round2(Number(storedQuote.amount)) !== authoritative.total;

    if (storedQuote.status !== "open") {
      return Response.json(
        {
          error: "quote_not_open",
          message: "This quote has already been used for another booking.",
          quote: authoritative,
        },
        { status: 409 },
      );
    }

    if (!inputsMatch || !citiesMatch) {
      return Response.json(
        {
          error: "quote_mismatch",
          message:
            "This quote was issued for different shipment details. Request a new quote.",
          quote: authoritative,
        },
        { status: 409 },
      );
    }

    if (expired || staleRate || amountDrift) {
      // Do not expire with unconditional writes: reservation may have won concurrently.
      console.warn("finalizeShipment: quote rejected", {
        quoteId,
        expired,
        staleRate,
        amountDrift,
      });
      return Response.json(
        {
          error: expired
            ? "quote_expired"
            : staleRate
              ? "rate_changed"
              : "quote_mismatch",
          message: expired
            ? "This quote has expired. Review the updated price and confirm again."
            : "The price for this shipment has changed. Review the updated price and confirm again.",
          quote: authoritative,
        },
        { status: 409 },
      );
    }

    const acceptedTotal =
      quoteInput.accepted_total === undefined ||
      quoteInput.accepted_total === null
        ? null
        : round2(Number(quoteInput.accepted_total));
    if (acceptedTotal !== null && acceptedTotal !== authoritative.total) {
      console.warn("finalizeShipment: accepted total differs from quote", {
        quoteId,
        acceptedTotal,
        authoritative: authoritative.total,
      });
      return Response.json(
        {
          error: "quote_mismatch",
          message:
            "The accepted amount does not match the current quote. Review the updated price and confirm again.",
          accepted_total: acceptedTotal,
          quote: authoritative,
        },
        { status: 409 },
      );
    }

    // The merchant, the card, the price and the starting lifecycle fields come
    // from the server, never from the posted body.
    const trackingNumber =
      "STL-" + crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const dropOffCode =
      "DROP-" +
      crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const correlation = "corr-" + crypto.randomUUID();
    const etaDate = new Date(
      Date.now() + authoritative.eta_days * 24 * 3600 * 1000,
    ).toISOString();
    // Booking windows. The Render shipment command requires an explicit pickup
    // and delivery deadline; when a booking carries neither, the domain create
    // is refused and the shipment can never reach canonical state. The pickup
    // window follows the service level the merchant actually bought.
    const PICKUP_WINDOW_HOURS: Record<string, number> = {
      same_day: 4,
      overnight: 6,
      express: 8,
      priority: 12,
      standard: 24,
      saver: 48,
    };
    const pickupDeadline = new Date(
      Date.now() +
        (PICKUP_WINDOW_HOURS[authoritative.service_level] || 24) * 3600 * 1000,
    ).toISOString();

    const created = await finalizeIntent(
      sr.entities,
      draftId,
      quoteId,
      {
        user_id: user.id,
        merchant_id: merchant.id,
        edit_revision: draft.edit_revision,
      },
      {
        ...customerShipment(shipment),
        origin_address: originAddress,
        destination_address: destinationAddress,
        merchant_id: merchant.id,
        merchant_name: merchant.company_name || user.full_name || "",
        compliance_evidence: complianceEvidence,
        payment_method_id: card.paymentMethod.id,
        payment_method_label: `${card.paymentMethod.card?.brand || "card"} •••• ${card.paymentMethod.card?.last4 || ""}`,
        status: "created",
        domain_status: "pending",
        sync_status: "pending",
        version: 1,
        // price of record — server derived, never client supplied
        cost: authoritative.total,
        currency: authoritative.currency,
        quoted_amount: authoritative.total,
        quote_id: quoteId,
        quote_ref: storedQuote.quote_ref || "",
        quote_expires_at: storedQuote.expires_at,
        rate_version: authoritative.rate_version,
        pricing_authority: authoritative.pricing_authority,
        payment_capture_status: "not_captured",
        eta: etaDate,
        // Pickup/delivery windows and a package class are part of the domain
        // create contract, so they are recorded at booking, not left to the sync.
        pickup_deadline: pickupDeadline,
        delivery_deadline: etaDate,
        package_size: shipment.package_size || "small",
        weight_kg: weightKg,
        tracking_number: trackingNumber,
        drop_off_code: dropOffCode,
        qr_code: trackingNumber,
        correlation_id: correlation,
      },
      proof,
    );

    await settleBookingDeclaration(sr.entities,created,secrets.get("MERCHANT_RECORD_SIGNING_SECRET")!);
    await settleBookingNotification(sr.entities,created,secrets.get("MERCHANT_RECORD_SIGNING_SECRET")!);
    return Response.json({
      shipment: created,
      draft_id: draftId,
      quote: authoritative,
      quote_id: quoteId,
    });
  } catch (error) {
    if((error as any)?.code==='compliance_approval_required'||(error as any)?.code==='declaration_required')return Response.json({error:(error as any).code,message:(error as Error).message},{status:(error as any).status});
    const pending = claimResponse(error);
    if (pending) return pending;
    console.error("finalizeShipment error:", error);
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
