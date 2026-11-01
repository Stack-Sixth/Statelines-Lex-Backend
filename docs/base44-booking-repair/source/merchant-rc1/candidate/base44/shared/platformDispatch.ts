import { secrets } from 'base44:runtime';

// Delivery of one Statelines platform event to the canonical logistics backend.
//
// VERIFIED DESTINATION (probed 2026-10-28): LEX_HUB_URL's
// POST /functions/lexIngestWebhook exists (a GET returns 405 Method Not
// Allowed). The Carrier and NOC platform sync endpoints that were called
// before (/functions/platformSyncReceiver on CARRIER_APP_URL and
// OPS_CENTER_APP_URL) return 404 and are no longer called: LEX owns canonical
// state and fans out to Carrier and NOC. `audience` is carried in the payload.
//
// Every attempt is recorded on the PlatformEvent row (attempts, status,
// last_http_status, last_error) so failures are durable and retryable.

export interface DispatchRecord {
  id: string;
  event: string;
  audience: string;
  attempts?: number;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  http_status: number;
  error: string;
}

export function isDispatchConfigured(): boolean {
  return Boolean(secrets.get('LEX_HUB_URL') && secrets.get('LEX_WEBHOOK_SECRET'));
}

export async function deliverEvent(sr, record: DispatchRecord, payload: string, timeoutMs = 10000): Promise<DeliveryResult> {
  const target = (secrets.get('LEX_HUB_URL') || '').replace(/\/$/, '');
  const lexSecret = secrets.get('LEX_WEBHOOK_SECRET');

  if (!target || !lexSecret) {
    const error = !target ? 'LEX_HUB_URL not configured' : 'LEX_WEBHOOK_SECRET not configured';
    await sr.entities.PlatformEvent.update(record.id, {
      status: 'failed',
      last_error: error,
      last_attempt_at: new Date().toISOString(),
    }).catch(() => {});
    return { ok: false, attempts: record.attempts || 0, http_status: 0, error };
  }

  const attempts = (record.attempts || 0) + 1;
  let httpStatus = 0;

  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(lexSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const signature = 'sha256=' + Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    const res = await fetch(`${target}/functions/lexIngestWebhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LEX-Signature': signature,
        'X-LEX-Event': record.event,
        'X-LEX-Correlation-Id': crypto.randomUUID(),
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    httpStatus = res.status;
    const text = await res.text();
    if (res.ok) {
      await sr.entities.PlatformEvent.update(record.id, {
        status: 'delivered',
        attempts,
        last_http_status: httpStatus,
        last_error: '',
        last_attempt_at: new Date().toISOString(),
        delivered_at: new Date().toISOString(),
      }).catch(() => {});
      return { ok: true, attempts, http_status: httpStatus, error: '' };
    }

    const error = `HTTP ${res.status} ${text.slice(0, 160)}`;
    await sr.entities.PlatformEvent.update(record.id, {
      status: 'failed',
      attempts,
      last_http_status: httpStatus,
      last_error: error.slice(0, 280),
      last_attempt_at: new Date().toISOString(),
    }).catch(() => {});
    return { ok: false, attempts, http_status: httpStatus, error };
  } catch (e) {
    const error = ((e as Error).message || 'network error').slice(0, 280);
    await sr.entities.PlatformEvent.update(record.id, {
      status: 'failed',
      attempts,
      last_http_status: httpStatus,
      last_error: error,
      last_attempt_at: new Date().toISOString(),
    }).catch(() => {});
    return { ok: false, attempts, http_status: httpStatus, error };
  }
}