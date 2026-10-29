import type { Sql } from './db.js';
import { resolveMerchantScope } from './merchant-authorization.js';
import { decodeJwt, jwtVerify } from 'jose';
import type { Config } from './config.js';
import { roleSchema } from './config.js';
import { AppError, type Actor } from './domain.js';
export async function authenticate(
  header: string | undefined,
  config: Config,
  db: Sql,
): Promise<Actor> {
  let actor: Actor;
  try {
    if (!header?.startsWith('Bearer ')) throw Error('Missing bearer token');
    const token = header.slice(7);
    const untrusted = decodeJwt(token);
    const client = config.clients.find((c) => c.id === untrusted.iss);
    if (!client) throw Error('Unknown issuer');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(client.secret), {
      algorithms: ['HS256'],
      issuer: client.id,
      audience: 'statelines-lex',
      maxTokenAge: '5m',
      clockTolerance: 5,
      requiredClaims: ['sub', 'iat', 'exp', 'iss', 'aud'],
    });
    const role = roleSchema.parse(payload.role);
    if (
      !payload.sub ||
      payload.sub.length > 200 ||
      !client.roles.includes(role) ||
      payload.exp! - payload.iat! > 300
    )
      throw Error('Invalid identity');
    if (
      role === 'merchant' &&
      [
        'sandbox_isolated',
        'merchant_id',
        'tenant_id',
        'scope',
        'scopes',
        'client_id',
        'owner_user_id',
        'delegation',
        'permissions',
      ].some((key) => key in payload)
    )
      throw Error('Caller-asserted merchant scope is not supported');
    if (role === 'merchant' && (client.roles.length !== 1 || client.roles[0] !== 'merchant'))
      throw new AppError(
        403,
        'invalid_merchant_client',
        'Merchant requests require a dedicated merchant-only service client',
      );
    actor = { id: payload.sub, role, clientId: client.id };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'unauthorized', 'Valid short-lived service token required');
  }
  return actor.role === 'merchant' ? resolveMerchantScope(db, actor) : actor;
}
