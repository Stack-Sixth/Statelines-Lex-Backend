import {engineUuid} from "../../shared/lexTrustedIsolation.ts";
// Install as a Base44 backend function named lexApi, not in browser code.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import { signedRenderHeaders, signedRenderHeadersWith } from '../../shared/lexRenderJwt.ts';
import {
  loadMerchantContext,
  loadMerchantRowForSubject,
  loadMerchantRowByMerchantId,
  resolveDedicatedCredential,
  validateMerchantAgainstBackend,
  recordMerchantValidation,
  clientFingerprint,
  publicMerchantContext,
} from '../../shared/lexMerchantContext.ts';
import { normalizeShipmentRead } from '../../shared/lexRenderAdapter.ts';
import { sandboxBookingGrant } from '../../shared/lexSandbox.ts';

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const baseUrl = secrets.get('LEX_API_URL');
    const clientId = secrets.get('LEX_API_CLIENT_ID');
    const secret = secrets.get('LEX_API_CLIENT_SECRET');
    if (!baseUrl)
      return Response.json({ error: 'LEX integration is not configured' }, { status: 503 });

    // This map is maintained by administrators in server secrets, never supplied by a caller.
    const roleMap = JSON.parse(secrets.get('LEX_USER_ROLES_JSON') || '{}');
    const role = user.role === 'admin' ? 'admin' : roleMap[user.id] || 'merchant';
    if (!['admin', 'operator', 'merchant', 'carrier'].includes(role))
      return Response.json({ error: 'Invalid server-side role mapping' }, { status: 403 });

    // Merchant authorization is resolved server-side from MerchantAuthorization:
    // mapping, approved subject, dedicated credential and booking readiness. No
    // part of it comes from the caller.
    const merchantCtx = role === 'merchant' ? await loadMerchantContext(base44, user.id) : null;

    // Local, side-effect-free preflight. Returns readiness and blockers without
    // touching the engine, so the console can show why booking is unavailable.
    if (body.action === 'merchantContext') {
      if (!merchantCtx)
        return Response.json(
          {
            ok: false,
            role,
            merchant_context_applicable: false,
            request_authorized: false,
            booking_ready: false,
            blockers: [
              { code: 'merchant_role_required', detail: 'Caller is not a merchant-role identity; merchant context is not applicable.' },
            ],
          },
          { status: 200 },
        );
      const fingerprint = merchantCtx.credential ? await clientFingerprint(merchantCtx.credential.clientId) : '';
      return Response.json(
        {
          ok: merchantCtx.request_authorized,
          role,
          merchant_context_applicable: true,
          ...publicMerchantContext(merchantCtx),
          signing: { subject: user.id, credential_ref: merchantCtx.credential_ref, client_fingerprint: fingerprint },
        },
        { status: 200 },
      );
    }

    // Server-side authorization proof: signs GET /api/v1/merchant-context with the
    // merchant's own dedicated credential and compares the returned merchant_id,
    // client_id and subject against the trusted mapping and signing identity. Local
    // credential presence is configuration readiness only and never sufficient.
    if (body.action === 'verifyMerchantContext') {
      let row: any = null;
      let subject: string | null = null;
      let scope: 'self' | 'admin_selected' = 'self';

      if (role === 'merchant') {
        if (!merchantCtx?.request_authorized)
          return Response.json(
            {
              error: 'Merchant request denied: no authorized merchant context',
              code: 'merchant_request_denied',
              blockers: merchantCtx?.authorization_blockers ?? [],
            },
            { status: 403 },
          );
        row = await loadMerchantRowForSubject(base44, user.id);
        subject = user.id;
      } else if (role === 'admin') {
        if (typeof body.merchant_id !== 'string' || !body.merchant_id)
          return Response.json({ error: 'merchant_id of an existing mapping row is required' }, { status: 400 });
        row = await loadMerchantRowByMerchantId(base44, body.merchant_id);
        if (!row) return Response.json({ error: 'No MerchantAuthorization row for that merchant_id' }, { status: 404 });
        const approved: string[] = Array.isArray(row.approved_subjects) ? row.approved_subjects : [];
        subject = approved[0] || null;
        scope = 'admin_selected';
      } else {
        return Response.json({ error: 'Merchant verification is available to merchant and admin roles only' }, { status: 403 });
      }

      const credentialRef = row ? String(row.credential_ref || '') || null : null;
      const credential = resolveDedicatedCredential(credentialRef);
      if (!row || !subject || !credential) {
        const reason = !row
          ? 'merchant_mapping_missing'
          : !subject
            ? 'merchant_subject_not_approved'
            : 'merchant_credential_missing';
        if (row?.id)
          await recordMerchantValidation(base44, row.id, { status: 'failed', subject, credential_ref: credentialRef });
        return Response.json(
          { verified: false, status: 'failed', reason, scope, merchant_id: row?.merchant_id ?? null, credential_ref: credentialRef },
          { status: 200 },
        );
      }

      const validation = await validateMerchantAgainstBackend(row, subject, credential);
      await recordMerchantValidation(base44, row.id, {
        status: validation.status,
        subject,
        credential_ref: credentialRef,
        validation,
      });
      return Response.json(
        {
          verified: validation.matched,
          status: validation.status,
          scope,
          merchant_id: row.merchant_id ?? null,
          expected: validation.expected,
          returned: validation.returned,
          mismatches: validation.mismatches,
          http_status: validation.http_status,
          error: validation.error,
          note: 'A matching read-back authorizes; booking switches remain closed.',
        },
        { status: 200 },
      );
    }

    const routes: Record<string, { method: string; path: string; domain?: boolean }> = {
      createShipment: { method: 'POST', path: '/v1/shipments' },
      getCanonicalShipment: {method:'GET',path:'/api/v1/shipments/:id',domain:true},
      listCanonicalShipments: {method:'GET',path:'/api/v1/shipments',domain:true},
      canonicalCancellationPreflight: {method:'GET',path:'/api/v1/shipments/:id/cancellable',domain:true},
      cancelCanonicalShipment: {method:'POST',path:'/api/v1/shipments/:id/cancel',domain:true},
      listShipments: { method: 'GET', path: '/v1/shipments' },
      getShipment: { method: 'GET', path: '/v1/shipments/:id' },
      deleteShipment: { method: 'DELETE', path: '/v1/shipments/:id' },
      matchShipment: { method: 'POST', path: '/v1/shipments/:id/match' },
      transitionShipment: { method: 'POST', path: '/v1/shipments/:id/transitions' },
      approveWallet: { method: 'POST', path: '/v1/shipments/:id/wallet-approval' },
      createCarrier: { method: 'POST', path: '/v1/carriers' },
      listCarriers: { method: 'GET', path: '/v1/carriers' },
      deleteCarrier: { method: 'DELETE', path: '/v1/carriers/:id' },
      scheduleCarrier: { method: 'POST', path: '/v1/carriers/:id/schedule' },
      health: { method: 'GET', path: '/v1/operations/health' },
      listDeliveries: { method: 'GET', path: '/v1/deliveries' },
      replayDelivery: { method: 'POST', path: '/v1/deliveries/:id/replay' },
    };

    const route = routes[body.action];
    if (!route) return Response.json({ error: 'Unknown action' }, { status: 400 });

    // Tenant isolation: the permitted merchant scope is derived server-side by the
    // engine from the signing credential — never from caller input. Reject any
    // attempt to assert scope in the payload instead of forwarding it.
    const SCOPE_KEYS = [
      'merchant_id',
      'merchant_scope',
      'merchant_client_id',
      'service_client',
      'service_client_id',
      'issuer',
      'iss',
    ];
    const asserted = Object.keys(body.payload || {}).filter((k) => SCOPE_KEYS.includes(k));
    if (asserted.length)
      return Response.json(
        { error: `Merchant scope is derived server-side and cannot be set by the caller: ${asserted.join(', ')}` },
        { status: 400 },
      );

    // Merchant booking stays closed until the confirmed contract is deployed and
    // provisioning is verified. `booking_ready` is the only authority, so a data
    // row alone can never open it. The caller's command_id is echoed untouched so
    // a retry keeps the same idempotency identity.
    // General merchant booking stays closed: `booking_ready` still requires the
    // global gate, which is untouched. The only additional authority is the sandbox
    // exception, which applies to exactly two registered synthetic businesses, only
    // while active, against the trusted live backend with server-enforced quarantine
    // and no payment calls.
    if (body.action === 'createShipment') {
      if (merchantCtx?.sandbox || !merchantCtx?.booking_ready) {
        const grant = sandboxBookingGrant(merchantCtx, user.id);
        if (!grant.allowed)
          return Response.json(
            {
              error: 'Merchant booking is disabled pending a confirmed contract, deployment and provisioning',
              code: 'merchant_booking_disabled',
              command_id: body?.payload?.command_id ?? null,
              blockers:
                merchantCtx?.blockers ?? [
                  {
                    code: 'merchant_role_required',
                    detail: 'Caller is not a merchant-role identity, so no provisioned merchant context can authorize a booking.',
                  },
                ],
              sandbox_blockers: 'blockers' in grant ? grant.blockers : undefined,
            },
            { status: 409 },
          );
      }
    }

    // Fail closed. Every merchant-role request — list, read, transition, not just
    // mutations — requires a provisioned mapping, an approved subject for this
    // client and a dedicated credential. No mapping means no access; there is no
    // fallback to the shared service client. Admin, operator and carrier workers
    // keep the shared service credential unchanged.
    if (role === 'merchant' && !merchantCtx?.request_authorized)
      return Response.json(
        {
          error: 'Merchant request denied: no authorized merchant context',
          code: 'merchant_request_denied',
          blockers: merchantCtx?.authorization_blockers ?? [],
        },
        { status: 403 },
      );

    // Controlled live-test tenancy: a synthetic business is signed against the live
    // backend like any other caller (LEX_API_URL). There is no separate sandbox engine
    // and no sandbox URL to fall back to or substitute — isolation comes from the
    // test-account-only gate, dedicated credentials and the outbound event guards.
    let path = route.path;
    if (path.includes(':id')) {
      if (
        typeof body.id !== 'string' ||
        !(route.domain ? engineUuid(body.id) : /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id))
      )
        return Response.json({ error: route.domain ? 'UUID or canonical SHP identifier required' : 'Legacy route requires a UUID' }, { status: 400 });
      path = path.replace(':id', body.id);
    }

    const target = new URL(path, role === "merchant" ? merchantCtx!.backend_target! : baseUrl);
    if (target.protocol !== 'https:')
      return Response.json({ error: 'LEX_API_URL must use HTTPS' }, { status: 503 });

    if (route.method === 'GET' && body.query) {
      for (const key of (route.domain ? ['after', 'limit', 'status', 'order_id'] : ['after', 'limit', 'status']))
        if (body.query[key] !== undefined) target.searchParams.set(key, String(body.query[key]));
    }

    // Signing identity is fixed for the whole request: the merchant's dedicated
    // client is `iss`, the authenticated app user is `sub`, and both stay identical
    // across retries (only iat/exp move), so a replayed command_id carries the same
    // (client, subject) pair. Merchant reads use the dedicated client too — a list
    // under the shared signer would prove nothing about isolation.
    const authHeaders =
      role === 'merchant'
        ? await signedRenderHeadersWith(merchantCtx!.credential!, user.id, role)
        : await signedRenderHeaders(user.id, role);

    const response = await fetch(target, {
      method: route.method,
      headers: authHeaders,
      body: route.method === 'GET' || route.method === 'DELETE' ? undefined : JSON.stringify(body.action === 'createShipment' && merchantCtx?.sandbox ? {...body.payload, sandbox_isolated:true} : body.payload || {}),
      signal: AbortSignal.timeout(15000),
      redirect: 'manual',
    });

    const raw = await response.text();

    // Documented read/write asymmetry (handoff §2a vs §2c): requests send
    // weight_kg as a number, reads return a decimal string. LEX consumes numbers,
    // and nothing sent to the engine or the Carrier contract changes here.
    if (response.ok && (body.action === 'listShipments' || body.action === 'getShipment')) {
      const normalized = normalizeShipmentRead(raw);
      if (normalized !== null)
        return new Response(JSON.stringify(normalized), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
    }

    return new Response(raw, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        error: 'LEX request failed. Preserve command_id when retrying.',
        reason,
      },
      { status: 502 },
    );
  }
}

