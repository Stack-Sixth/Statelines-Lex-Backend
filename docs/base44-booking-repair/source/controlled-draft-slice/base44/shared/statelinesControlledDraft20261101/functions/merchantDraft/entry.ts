import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { resolveBookingMerchant as resolveCallerMerchant } from "../../shared/bookingMerchant.ts";
import { customerDraft as customerShipment } from "../../shared/customerShipment.ts";
import { recordAuthority } from "../../shared/serverRecord.ts";
import {
  cas,
  absent,
  vacant,
  expected,
  ClaimPending,
  claimResponse,
  equal,
} from "../../shared/casBooking.ts";
const rows = (x: any) => (Array.isArray(x) ? x : x?.items || []);
export default async function (req: Request): Promise<Response> {
  try {
    const b = createClientFromRequest(req),
      user = await b.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json(),
      E = b.asServiceRole.entities.ControlledMerchantDraft;
    const merchant = await resolveCallerMerchant(b.asServiceRole, user);
    if (!merchant)
      return Response.json({ error: "No merchant" }, { status: 403 });
    const proof = recordAuthority(
      secrets.get("MERCHANT_CONTROLLED_RECORD_SIGNING_SECRET"),
    );
    const own = async (row: any) =>
      (await proof.trusted("ShipmentDraft", row))
        ? row.server_owner_user_id === user.id &&
          row.merchant_id === merchant.id
        : row.created_by_id === user.id;
    if (body.action === "list") {
      const limit = body.limit === undefined ? 20 : Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return Response.json({ error: "Invalid limit" }, { status: 400 });
      const all = [
        ...rows(
          await E.filter(
            { server_owner_user_id: user.id },
            "-updated_date",
            100,
          ),
        ),
        ...rows(
          await E.filter({ created_by_id: user.id }, "-updated_date", 100),
        ),
      ];
      const unique = [...new Map(all.map((r) => [r.id, r])).values()];
      const items = [];
      for (const r of unique)
        if ((await own(r)) && !r.archived_at && r.status === "draft")
          items.push({
            ...r,
            booking_review_required: !(await proof.trusted("ShipmentDraft", r)),
          });
      items.sort((a, b) =>
        String(b.updated_date || b.last_saved_at || "").localeCompare(
          String(a.updated_date || a.last_saved_at || ""),
        ),
      );
      return Response.json({ items: items.slice(0, limit) });
    }
    let row = body.draft_id ? await E.get(String(body.draft_id)) : null;
    if (row && !(await own(row)))
      return Response.json({ error: "Not found" }, { status: 404 });
    if (body.action === "load")
      return row
        ? Response.json({
            draft: {
              ...row,
              booking_review_required: !(await proof.trusted(
                "ShipmentDraft",
                row,
              )),
            },
          })
        : Response.json({ draft: null });
    if (!["save", "discard"].includes(body.action))
      return Response.json({ error: "Unknown action" }, { status: 400 });
    if (body.action === "discard") {
      if (!row) return Response.json({ error: "Not found" }, { status: 404 });
      if (row.archived_at)
        return Response.json({ discarded: true, archived: true });
      const at = new Date().toISOString();
      const won = await cas(
        E,
        row.id,
        {
          booking_claim: vacant(row, "booking_claim"),
          archived_at: expected(row, "archived_at"),
          edit_revision: expected(row, "edit_revision"),
        },
        {
          archived_at: at,
          edit_revision: (Number(row.edit_revision) || 0) + 1,
          lifecycle_history: [
            ...(row.lifecycle_history || []),
            { action: "draft.archived", actor_id: user.id, at },
          ],
        },
      );
      if (!won) throw new ClaimPending("draft_claimed_or_changed");
      return Response.json({ discarded: true, archived: true });
    }
    const allowed = new Set([
      "action",
      "draft_id",
      "expected_revision",
      "data",
      "step",
      "options",
      "declaration_checked",
    ]);
    if (Object.keys(body).some((k) => !allowed.has(k)))
      return Response.json(
        { error: "Unsupported draft field" },
        { status: 400 },
      );
    const data = customerShipment(body.data || {}),
      options = body.options || {};
    const step = Number(body.step) || 0,
      rewards = Number(options.rewards_redeem) || 0;
    if (
      !Number.isInteger(step) ||
      step < 0 ||
      step > 20 ||
      !Number.isFinite(rewards) ||
      rewards < 0
    )
      throw new Error("Invalid draft input");
    if (row?.booking_claim) {
      if (!equal(data, customerShipment(row.data || {})))
        throw new ClaimPending("draft_claimed_payload_changed");
      return Response.json({ draft: row, resume_only: true });
    }
    const at = new Date().toISOString(),
      doc = {
        data,
        step,
        options: {
          promo_input: String(options.promo_input || "").slice(0, 100),
          rewards_redeem: rewards,
        },
        // Browser compliance output is informational and cannot authorize booking.
        compliance_result: null,
        declaration_checked: body.declaration_checked === true,
        route_label: `${data.origin_city || data.origin_address || "Origin"} → ${data.destination_city || data.destination_address || "Destination"}`,
        last_saved_at: at,
      };
    if (!row) {
      row = await E.create({
        ...doc,
        ...(await proof.mint("ShipmentDraft", user.id, merchant.id)),
        user_id: user.id,
        status: "draft",
        edit_revision: 0,
        lifecycle_history: [{ action: "draft.created", actor_id: user.id, at }],
      });
    } else {
      if (row.archived_at) throw new ClaimPending("draft_archived");
      if (
        !Number.isInteger(body.expected_revision) ||
        body.expected_revision !== (Number(row.edit_revision) || 0)
      )
        throw new ClaimPending("draft_revision_conflict");
      const won = await cas(
        E,
        row.id,
        {
          booking_claim: vacant(row, "booking_claim"),
          archived_at: expected(row, "archived_at"),
          edit_revision: expected(row, "edit_revision"),
        },
        { ...doc, edit_revision: (Number(row.edit_revision) || 0) + 1 },
      );
      if (!won) throw new ClaimPending("draft_claimed_or_changed");
      row = await E.get(row.id);
    }
    return Response.json({ draft: row });
  } catch (e) {
    const pending = claimResponse(e);
    if (pending) return pending;
    return Response.json({ error: "Draft operation failed" }, { status: 400 });
  }
}
