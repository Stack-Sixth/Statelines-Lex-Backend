// Install as a Base44 backend function named lexApi, not in browser code.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
const jsonPart = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const baseUrl = secrets.get('LEX_API_URL');
    const clientId = secrets.get('LEX_API_CLIENT_ID');
    const secret = secrets.get('LEX_API_CLIENT_SECRET');
    if (!baseUrl || !clientId || !secret)
      return Response.json({ error: 'LEX integration is not configured' }, { status: 503 });
    // This map is maintained by administrators in server secrets, never supplied by a caller.
    const roleMap = JSON.parse(secrets.get('LEX_USER_ROLES_JSON') || '{}');
    const role = user.role === 'admin' ? 'admin' : roleMap[user.id] || 'merchant';
    if (!['admin', 'operator', 'merchant', 'carrier'].includes(role))
      return Response.json({ error: 'Invalid server-side role mapping' }, { status: 403 });
    const routes: Record<string, { method: string; path: string }> = {
      createShipment: { method: 'POST', path: '/v1/shipments' },
      listShipments: { method: 'GET', path: '/v1/shipments' },
      getShipment: { method: 'GET', path: '/v1/shipments/:id' },
      matchShipment: { method: 'POST', path: '/v1/shipments/:id/match' },
      transitionShipment: { method: 'POST', path: '/v1/shipments/:id/transitions' },
      approveWallet: { method: 'POST', path: '/v1/shipments/:id/wallet-approval' },
      createCarrier: { method: 'POST', path: '/v1/carriers' },
      listCarriers: { method: 'GET', path: '/v1/carriers' },
      scheduleCarrier: { method: 'POST', path: '/v1/carriers/:id/schedule' },
      health: { method: 'GET', path: '/v1/operations/health' },
      listDeliveries: { method: 'GET', path: '/v1/deliveries' },
      replayDelivery: { method: 'POST', path: '/v1/deliveries/:id/replay' },
    };
    const route = routes[body.action];
    if (!route) return Response.json({ error: 'Unknown action' }, { status: 400 });
    let path = route.path;
    if (path.includes(':id')) {
      if (
        typeof body.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
      )
        return Response.json({ error: 'Valid ID required' }, { status: 400 });
      path = path.replace(':id', body.id);
    }
    const target = new URL(path, baseUrl);
    if (target.protocol !== 'https:')
      return Response.json({ error: 'LEX_API_URL must use HTTPS' }, { status: 503 });
    if (route.method === 'GET' && body.query) {
      for (const key of ['after', 'limit', 'status'])
        if (body.query[key] !== undefined) target.searchParams.set(key, String(body.query[key]));
    }
    const now = Math.floor(Date.now() / 1000);
    const signingInput =
      jsonPart({ alg: 'HS256', typ: 'JWT' }) +
      '.' +
      jsonPart({
        iss: clientId,
        aud: 'statelines-lex',
        sub: user.id,
        role,
        iat: now,
        exp: now + 120,
      });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
    const response = await fetch(target, {
      method: route.method,
      headers: {
        Authorization: 'Bearer ' + signingInput + '.' + encode(new Uint8Array(sig)),
        'Content-Type': 'application/json',
      },
      body: route.method === 'GET' ? undefined : JSON.stringify(body.payload || {}),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return Response.json(
      { error: 'LEX request failed. Preserve command_id when retrying.' },
      { status: 502 },
    );
  }
}
