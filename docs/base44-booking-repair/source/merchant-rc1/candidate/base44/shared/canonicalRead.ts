// Pure helpers for reading the domain network's canonical shipment list.
//
// Pagination and exact matching are the two places where a read can silently
// leak another tenant's data or mis-count a shipment, so they live here — free
// of network, platform imports and secrets — and are unit-tested with mocked
// responses (tests/authority.test.ts).

export interface RenderResultLike<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  etag?: string;
  code?: string;
  message?: string;
  requestId?: string;
}

export type CallRenderFn = <T = unknown>(opts: {
  method: string;
  path: string;
  body?: unknown;
  etag?: string;
  timeoutMs?: number;
  credential?: { client_id: string; client_secret: string };
  baseUrl?: string;
}) => Promise<RenderResultLike<T>>;

export interface ShipmentScope {
  merchant_id: string;
  order_id: string;
}

// Walk the confirmed read contract:
//   GET /api/v1/shipments?order_id=<encoded>&limit=50 → { items, next_cursor }
//   next page requested with after=<next_cursor>
// Stops on a page with no cursor, an empty page, or the page cap — never loops
// forever on a backend that keeps returning the same cursor.
export async function collectShipmentPages(
  callRender: CallRenderFn,
  input: ShipmentScope & {
    maxPages?: number;
    credential?: { client_id: string; client_secret: string };
  },
): Promise<
  { ok: true; items: Record<string, unknown>[] } | { ok: false; detail: string }
> {
  if (!input.merchant_id || !input.order_id) {
    return {
      ok: false,
      detail: "reconcile requires a merchant scope and order id",
    };
  }
  const maxPages = input.maxPages ?? 5;
  const items: Record<string, unknown>[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      order_id: input.order_id,
      limit: "50",
    });
    if (after) params.set("after", after);
    const res = await callRender<{
      items?: unknown[];
      next_cursor?: string | null;
    }>({
      method: "GET",
      path: `/api/v1/shipments?${params.toString()}`,
      timeoutMs: 10000,
      credential: input.credential,
    });
    if (!res.ok) {
      return {
        ok: false,
        detail: `${res.code || "render_error"}: ${res.message || `Render responded ${res.status}`}`,
      };
    }
    const body = (res.data && typeof res.data === "object" ? res.data : {}) as {
      items?: unknown[];
      next_cursor?: string | null;
    };
    const batch = Array.isArray(body.items) ? body.items : [];
    for (const it of batch) {
      if (it && typeof it === "object")
        items.push(it as Record<string, unknown>);
    }
    const cursor =
      typeof body.next_cursor === "string" && body.next_cursor
        ? body.next_cursor
        : null;
    if (!cursor) return { ok: true, items };
    if (cursor === after || batch.length === 0)
      return { ok: false, detail: "incomplete pagination" };
    after = cursor;
  }

  return { ok: false, detail: "pagination cap reached" };
}

// A filtered read is never trusted as tenant scoping: every returned row must
// still match merchant_id + order_id exactly, and exactly one may match.
export function selectExactMatch(
  items: Record<string, unknown>[],
  scope: ShipmentScope,
):
  | { ok: true; item: Record<string, unknown> }
  | {
      ok: false;
      reason: "no_match" | "ambiguous";
      detail: string;
      matches: number;
    } {
  const matches = items.filter(
    (o) => o.merchant_id === scope.merchant_id && o.order_id === scope.order_id,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "no_match",
      detail: "Render list returned no shipment for merchant_id + order_id",
      matches: 0,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `Render list returned ${matches.length} shipments for merchant_id + order_id`,
      matches: matches.length,
    };
  }
  return { ok: true, item: matches[0] };
}
