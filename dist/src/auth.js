import { decodeJwt, jwtVerify } from 'jose';
import { roleSchema } from './config.js';
import { AppError } from './domain.js';
export async function authenticate(header, config) {
    try {
        if (!header?.startsWith('Bearer '))
            throw Error('Missing bearer token');
        const token = header.slice(7);
        const untrusted = decodeJwt(token);
        const client = config.clients.find((c) => c.id === untrusted.iss);
        if (!client)
            throw Error('Unknown issuer');
        const { payload } = await jwtVerify(token, new TextEncoder().encode(client.secret), {
            algorithms: ['HS256'],
            issuer: client.id,
            audience: 'statelines-lex',
            maxTokenAge: '5m',
            clockTolerance: 5,
            requiredClaims: ['sub', 'iat', 'exp', 'iss', 'aud'],
        });
        const role = roleSchema.parse(payload.role);
        if (!payload.sub ||
            payload.sub.length > 200 ||
            !client.roles.includes(role) ||
            payload.exp - payload.iat > 300)
            throw Error('Invalid identity');
        return { id: payload.sub, role, clientId: client.id };
    }
    catch {
        throw new AppError(401, 'unauthorized', 'Valid short-lived service token required');
    }
}
//# sourceMappingURL=auth.js.map