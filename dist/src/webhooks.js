import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './domain.js';
export function validateEndpoint(value, allowedHosts) {
    const url = new URL(value);
    if (url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        isIP(url.hostname) ||
        !allowedHosts.includes(url.hostname.toLowerCase()))
        throw new AppError(422, 'invalid_webhook_url', 'Use an HTTPS URL on an explicitly allowed hostname, port 443');
    return url;
}
export function signature(secret, timestamp, body) {
    return ('v1=' +
        createHmac('sha256', secret)
            .update(timestamp + '.' + body)
            .digest('hex'));
}
export function verifySignature(secret, timestamp, sig, body, now = Date.now()) {
    if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300)
        return false;
    const expected = Buffer.from(signature(secret, timestamp, body));
    const actual = Buffer.from(sig);
    return actual.length === expected.length && timingSafeEqual(expected, actual);
}
// Reject non-public destinations and pin the actual socket to the address checked.
export function publicAddress(address) {
    if (isIP(address) !== 4)
        return false; // Deliberately IPv4-only until IPv6 range validation is added.
    const [a, b] = address.split('.').map(Number);
    return (a !== 0 &&
        a !== 10 &&
        a !== 127 &&
        a !== 169 &&
        !(a === 172 && b >= 16 && b <= 31) &&
        !(a === 192 && [0, 168].includes(b)) &&
        !(a === 100 && b >= 64 && b <= 127) &&
        !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
        !(a === 203 && b === 0) &&
        a < 224);
}
export function webhookSender(config) {
    return async (value, secret, envelope, deliveryId) => {
        try {
            const url = validateEndpoint(value, config.allowedHosts);
            const records = await lookup(url.hostname, { all: true, family: 4 });
            if (!records.length || records.some((r) => !publicAddress(r.address)))
                return {
                    ok: false,
                    retryable: false,
                    status: 0,
                    error: 'Destination resolved to a prohibited address',
                };
            const record = records[0];
            const body = JSON.stringify(envelope);
            const timestamp = String(Math.floor(Date.now() / 1000));
            return await new Promise((resolve) => {
                let settled = false;
                const finish = (result) => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve(result);
                    }
                };
                const req = https.request(url, {
                    method: 'POST',
                    family: 4,
                    lookup: (_host, _options, cb) => cb(null, record.address, 4),
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'X-LEX-Timestamp': timestamp,
                        'X-LEX-Signature': signature(secret, timestamp, body),
                        'X-LEX-Delivery-Id': deliveryId,
                    },
                }, (res) => {
                    let text = '';
                    let bytes = 0;
                    res.on('data', (chunk) => {
                        bytes += chunk.length;
                        if (bytes > 65536) {
                            req.destroy();
                            finish({
                                ok: false,
                                retryable: false,
                                status: res.statusCode || 0,
                                error: 'Acknowledgment too large',
                            });
                        }
                        else
                            text += chunk.toString();
                    });
                    res.on('error', () => finish({ ok: false, retryable: true, status: 0, error: 'Response stream failed' }));
                    res.on('end', () => {
                        const status = res.statusCode || 0;
                        if (status < 200 || status >= 300)
                            return finish({
                                ok: false,
                                retryable: status === 408 || status === 429 || status >= 500,
                                status,
                                error: 'Receiver returned HTTP ' + status,
                            });
                        try {
                            const ack = JSON.parse(text);
                            if (ack.event_id !== envelope.event_id ||
                                !['accepted', 'processed'].includes(ack.status))
                                throw Error();
                            finish({
                                ok: true,
                                processed: ack.status === 'processed',
                                retryable: false,
                                status,
                            });
                        }
                        catch {
                            finish({
                                ok: false,
                                retryable: true,
                                status,
                                error: 'Receiver did not acknowledge this event ID',
                            });
                        }
                    });
                });
                const timer = setTimeout(() => {
                    req.destroy();
                    finish({ ok: false, retryable: true, status: 0, error: 'Webhook timeout' });
                }, 8000);
                req.on('error', () => finish({ ok: false, retryable: true, status: 0, error: 'Webhook connection failed' }));
                req.end(body);
            });
        }
        catch (error) {
            return {
                ok: false,
                retryable: !(error instanceof AppError),
                status: 0,
                error: error instanceof AppError ? error.message : 'Webhook lookup or connection failed',
            };
        }
    };
}
//# sourceMappingURL=webhooks.js.map