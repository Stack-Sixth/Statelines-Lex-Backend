import { secrets } from "base44:runtime";
import { recordAuthority, recordOwner } from "../../shared/serverRecord.ts";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { deliverEvent } from "../../shared/platformDispatch.ts";
import { evaluateOutboundContainment } from "../../shared/testContainment.ts";
import { resolveShipmentSubject } from "../../shared/containmentResolver.ts";

// Recovery path for synchronization that did not land.
//
// Re-delivers PlatformEvent rows that are still pending or failed (max 6 per
// call, max 5 attempts per event) and, when a shipment is named, re-runs the
// canonical shipment command through createOrderOnRender (idempotent through the
// persisted command_id and never re-POSTing a reconciled shipment).
//
// CONTAINMENT. Every row is re-resolved and re-classified AT RETRY TIME; a
// classification is never reused from the original attempt. A row whose subject
// is synthetic or cannot be classified is dropped, not delivered.

const MAX_ATTEMPTS = 5;
const BATCH = 6;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth
      .me()
      .catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const sr = base44.asServiceRole;
    const shipmentId = body.shipment_id ? String(body.shipment_id) : "";
    const eventId = body.event_id ? String(body.event_id) : "";

    let rows = [];
    let shipment = null;

    if (shipmentId) {
      shipment = await sr.entities.Shipment.get(shipmentId).catch(() => null);
      if (!shipment)
        return Response.json({ error: "Shipment not found" }, { status: 404 });
      const actualOwner = await recordOwner(
        "Shipment",
        shipment,
        recordAuthority(secrets.get("MERCHANT_RECORD_SIGNING_SECRET")),
      );
      if (actualOwner !== user.id && user.role !== "admin")
        return Response.json(
          { error: "Forbidden: not shipment owner" },
          { status: 403 },
        );
      rows = await sr.entities.PlatformEvent.filter(
        { shipment_id: shipmentId },
        "-created_date",
        25,
      );
    } else if (eventId) {
      const row = await sr.entities.PlatformEvent.get(eventId).catch(
        () => null,
      );
      if (!row)
        return Response.json({ error: "Event not found" }, { status: 404 });
      if (row.created_by_id !== user.id && user.role !== "admin")
        return Response.json({ error: "Forbidden" }, { status: 403 });
      rows = [row];
    } else {
      if (user.role !== "admin")
        return Response.json(
          { error: "Forbidden: admin required" },
          { status: 403 },
        );
      rows = await sr.entities.PlatformEvent.filter(
        { status: "failed" },
        "-created_date",
        25,
      );
    }

    const retryable = rows
      .filter(
        (row) =>
          row.status !== "delivered" && (row.attempts || 0) < MAX_ATTEMPTS,
      )
      .slice(0, BATCH);

    const contained = [];
    const sendable = [];
    for (const row of retryable) {
      // Fresh resolution per row: the row's own reference is authoritative, and
      // an unresolvable row is dropped rather than delivered.
      const subject = await resolveShipmentSubject(sr, {
        shipment_id: row.shipment_id,
        tracking_number: row.tracking_number,
      });
      const verdict = evaluateOutboundContainment({
        channel: "dispatch",
        subject,
      });
      if (verdict.allowed) {
        sendable.push({ row, subject });
      } else {
        contained.push({
          event_id: row.id,
          event: row.event,
          classification: verdict.classification,
          code: verdict.code,
          message: verdict.message,
        });
      }
    }

    const results = [];
    for (const { row, subject } of sendable) {
      const payload = JSON.stringify({
        event: row.event,
        audience: row.audience,
        shipment_id: subject.shipment_id,
        tracking_number: row.tracking_number || null,
        correlation_id: crypto.randomUUID(),
        idempotency_key: row.idempotency_key,
        data: row.payload || {},
      });
      const result = await deliverEvent(sr, row, payload);
      results.push({
        event_id: row.id,
        event: row.event,
        audience: row.audience,
        delivered: result.ok,
        attempts: result.attempts,
        http_status: result.http_status,
        error: result.ok ? undefined : result.error,
      });
    }

    let canonical = null;
    if (shipment && shipment.sync_status !== "synced") {
      const res = await base44.functions
        .invoke("createOrderOnRender", { shipment_id: shipment.id })
        .catch((e) => ({
          data: { ok: false, error: e?.response?.data?.error || e.message },
        }));
      canonical = res?.data || null;
    }

    return Response.json({
      ok: true,
      retried: results.length,
      delivered: results.filter((r) => r.delivered).length,
      still_failing: results.filter((r) => !r.delivered).length,
      skipped: rows.length - retryable.length,
      contained,
      results,
      canonical,
    });
  } catch (error) {
    console.error("retryPlatformEvents error:", error);
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
