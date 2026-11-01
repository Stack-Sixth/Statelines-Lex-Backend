import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { computeQuote, settlePrice, QUOTE_TTL_SECONDS } from '../../shared/rateQuote.ts';
import { resolveBookingMerchant as resolveCallerMerchant } from '../../shared/bookingMerchant.ts';

// Issues a quote for a shipment and PERSISTS it, so the amount the merchant
// accepts is a server-held record with an id, an expiry and a rate version.
//
// WHERE PRICES COME FROM (verified 2026-10-28):
//   - LEX/Render Domain API (LEX_API_URL) has NO quote route: GET /api/v1/quotes,
//     /api/v1/quote and /api/v1/rates all return 404, while /api/v1/shipments
//     returns 200 with the same service JWT. So there is no central quote
//     endpoint to call and no second price source to disagree with.
//   - Prices are therefore computed by the Statelines rate engine
//     (base44/shared/rateQuote.ts) on every request and labelled
//     pricing_authority="statelines_rate_engine". finalizeShipment re-validates
//     the accepted quote against the same engine before booking.
//
// A proposed central LEX quote contract is documented in
// base44/shared/rateQuote.ts consumers and reported to the operator; it is NOT
// implemented here because the route does not exist.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    if (body.weight_lb !== undefined && body.weight_lb !== null && body.weight_lb !== '' && !Number.isFinite(Number(body.weight_lb))) {
      return Response.json({ error: 'weight_lb must be a number' }, { status: 400 });
    }
    if (body.declared_value !== undefined && body.declared_value !== null && body.declared_value !== '' && !Number.isFinite(Number(body.declared_value))) {
      return Response.json({ error: 'declared_value must be a number' }, { status: 400 });
    }
    if (body.rewards_points !== undefined && body.rewards_points !== null && body.rewards_points !== '' && !Number.isFinite(Number(body.rewards_points))) {
      return Response.json({ error: 'rewards_points must be a number' }, { status: 400 });
    }

    if(Number(body.rewards_points||0)!==0)return Response.json({error:'rewards_redemption_unavailable',message:'Verified payment and balance authority is required before rewards can reduce a booking price.'},{status:409});
    const weightLb = Math.max(0, Math.min(Number(body.weight_lb) || 0, 150));
    const declaredValue = Math.max(0, Math.min(Number(body.declared_value) || 0, 100000));
    const insurance = body.insurance === true;
    const promoCode = String(body.promo_code || '').slice(0, 24);
    const rewardsPoints = Math.max(0, Math.min(Math.floor(Number(body.rewards_points) || 0), 1000000));
    const serviceLevel = String(body.service_level || 'standard');

    const settlement = settlePrice({
      weight_lb: weightLb,
      declared_value: declaredValue,
      service_level: serviceLevel,
      insurance,
      promo_code: promoCode,
      rewards_points: rewardsPoints,
    });
    const quote = computeQuote({ weight_lb: weightLb, declared_value: declaredValue, service_level: serviceLevel });

    const merchant = await resolveCallerMerchant(base44.asServiceRole,user);
    if(!merchant?.id)return Response.json({error:'Authorized merchant required'},{status:403});
    const issuedAt = new Date().toISOString();

    // Persisted server-side: the merchant never writes a quote row directly.
    const record = await base44.asServiceRole.entities.ShipmentQuote.create({
      quote_ref: `STL-Q-${issuedAt.replace(/\D/g, '').slice(2, 14)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      user_id: user.id,
      merchant_id: merchant.id,
      status: 'open',
      amount: settlement.total,
      currency: settlement.currency,
      rate: settlement.rate,
      insurance_fee: settlement.insurance_fee,
      subtotal: settlement.subtotal,
      promo_code: settlement.promo_code,
      promo_discount: settlement.promo_discount,
      rewards_points: settlement.rewards_points,
      rewards_discount: settlement.rewards_discount,
      tax: settlement.tax,
      service_level: settlement.service_level,
      eta_days: settlement.eta_days,
      weight_lb: weightLb,
      declared_value: declaredValue,
      insurance,
      origin_city: String(body.origin_city || '').slice(0, 120),
      destination_city: String(body.destination_city || '').slice(0, 120),
      pricing_authority: settlement.pricing_authority,
      rate_version: settlement.rate_version,
      issued_at: issuedAt,
      expires_at: settlement.expires_at,
    });

    return Response.json({
      live: true,
      source: settlement.pricing_authority,
      pricing_authority: settlement.pricing_authority,
      pricing_label: 'Calculated by the Statelines rate engine',
      quote_id: record.id,
      quote_ref: record.quote_ref,
      amount: settlement.total,
      total: settlement.total,
      currency: settlement.currency,
      rate: settlement.rate,
      eta_days: settlement.eta_days,
      service_level: settlement.service_level,
      rate_version: settlement.rate_version,
      issued_at: issuedAt,
      expires_at: settlement.expires_at,
      expires_in_seconds: QUOTE_TTL_SECONDS,
      settlement: {
        rate: settlement.rate,
        insurance_fee: settlement.insurance_fee,
        subtotal: settlement.subtotal,
        promo_code: settlement.promo_code,
        promo_discount: settlement.promo_discount,
        rewards_points: settlement.rewards_points,
        rewards_discount: settlement.rewards_discount,
        tax: settlement.tax,
        total: settlement.total,
      },
      origin_city: String(body.origin_city || ''),
      destination_city: String(body.destination_city || ''),
      quoted_at: issuedAt,
      breakdown: {
        base_rate: quote.base_rate,
        weight_lb: weightLb,
        weight_component: quote.weight_component,
        declared_value: declaredValue,
        value_component: quote.value_component,
        service_multiplier: quote.multiplier,
      },
    });
  } catch (error) {
    console.error('requestLiveRate error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}