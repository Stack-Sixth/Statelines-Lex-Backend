import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { computeCapacity } from "../../shared/lexPhase3.ts";
import { nowIso } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Network Capacity Engine. Read-only monitoring of corridor,
// carrier, exchange partner, smart node, and last-mile capacity with
// today / tomorrow / next-7-day forecasts and bottleneck detection.
// Consumes existing operational data; modifies nothing.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [shipments, carriers, nodes, forecasts] = [
      await base44.asServiceRole.entities.Shipment.filter({}),
      await base44.asServiceRole.entities.CommunityCarrier.filter({}),
      await base44.asServiceRole.entities.SmartNode.filter({}),
      await base44.asServiceRole.entities.DemandForecast.filter({}),
    ];

    const capacity = computeCapacity({ shipments, carriers, nodes, forecasts });

    return Response.json({
      generated_at: nowIso(),
      samples: {
        shipments: shipments.length,
        carriers: carriers.length,
        nodes: nodes.length,
        forecasts: forecasts.length,
      },
      ...capacity,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}