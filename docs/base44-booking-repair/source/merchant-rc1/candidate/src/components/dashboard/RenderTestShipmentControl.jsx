import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { FlaskConical, Search, ShieldAlert, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

// Admin-only read/preview diagnostic. The old platform-client create harness
// is disabled. Approved synthetic owners use createControlledTestShipment and
// the normal createOrderOnRender command handler after all release checks.
export default function RenderTestShipmentControl({ isAdmin }) {
  const { toast } = useToast();
  const [shipmentId, setShipmentId] = useState("");
  const [searching, setSearching] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prepared, setPrepared] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [order, setOrder] = useState(null);

  if (!isAdmin) return null;

  const searchOrder = async () => {
    const id = shipmentId.trim();
    if (!id) return;
    setSearching(true);
    setError(null);
    setOrder(null);
    setPrepared(null);
    setResult(null);
    try {
      const response = await base44.functions.invoke("merchantShipmentRead", {action:"admin_get",shipment_id:id});
      const page = {items:response.data?.shipment?[response.data.shipment]:[]};
      const ship = page.items?.[0];
      if (!ship) {
        setError("No Merchant Order found with that ID.");
        return;
      }
      setOrder(ship);
    } catch (e) {
      setError(e.message || "Failed to load order.");
    } finally {
      setSearching(false);
    }
  };

  const prepare = async () => {
    if (!order) return;
    setPreparing(true);
    setError(null);
    setPrepared(null);
    setResult(null);
    try {
      const res = await base44.functions.invoke("prepareTestShipment", { shipment_id: order.id });
      setPrepared(res);
      toast({ title: "Payload prepared", description: "Review before confirming the create." });
    } catch (e) {
      setError(e.message || "Prepare failed.");
      toast({ title: "Prepare failed", description: e.message, variant: "destructive" });
    } finally {
      setPreparing(false);
    }
  };

  const create = async () => {
    if (!order) return;
    setCreating(true);
    setError(null);
    setResult(null);
    try {
      const res = await base44.functions.invoke("createTestShipment", {
        shipment_id: order.id,
        confirmed: true,
      });
      setResult(res);
      toast({ title: "Shipment created on Render", description: res.canonical_shipment_id || "Synced" });
    } catch (e) {
      setError(e.message || "Create failed.");
      toast({ title: "Create failed", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    setShipmentId("");
    setOrder(null);
    setPrepared(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
      <div className="flex items-center gap-2 mb-1">
        <FlaskConical size={16} className="text-primary" />
        <h3 className="font-semibold text-foreground">Render Domain Platform — Controlled Test</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-5">
        Admin-only diagnostic. Creates exactly ONE canonical shipment on the Render Domain Platform from an existing
        Merchant Order. The browser never calls Render directly. Requires explicit confirmation.
      </p>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-5 flex items-start gap-2">
        <ShieldAlert size={15} className="text-amber-600 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-800">
          This is a production operation against the live Render Domain Platform. It will create a real canonical
          shipment. Do not proceed unless you have a complete, legitimate Merchant Order ready for testing.
        </p>
      </div>

      {/* Step 1: Find a Merchant Order */}
      <div className="space-y-3">
        <label className="text-xs font-medium text-foreground">1. Enter an existing Merchant Order (Shipment) ID</label>
        <div className="flex gap-2">
          <input
            value={shipmentId}
            onChange={(e) => setShipmentId(e.target.value)}
            placeholder="Shipment ID"
            className="flex-1 rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
          <button
            onClick={searchOrder}
            disabled={searching || !shipmentId.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition disabled:opacity-50"
          >
            {searching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {searching ? "Searching…" : "Find"}
          </button>
        </div>
      </div>

      {/* Order preview + validation */}
      {order && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CheckCircle2 size={15} className="text-green" />
            Order found — review the required domain fields below.
          </div>
          <div className="rounded-xl bg-secondary p-4 space-y-2 text-sm">
            <Field label="order_id" value={order.order_id || "—"} warn={!order.order_id} />
            <Field label="merchant_id" value={order.merchant_id || order.created_by_id || "—"} warn={!order.merchant_id} />
            <Field label="origin" value={order.origin_address ? `${order.origin_address}, ${order.origin_city || ""}` : "—"} warn={!order.origin_address || !order.origin_city} />
            <Field label="destination" value={order.destination_address ? `${order.destination_address}, ${order.destination_city || ""}` : "—"} warn={!order.destination_address || !order.destination_city} />
            <Field label="service_level" value={order.service_level || "—"} warn={!order.service_level} />
            <Field label="package_size" value={order.package_size || "—"} warn={!order.package_size} />
            <Field label="weight_kg" value={order.weight_kg ? `${order.weight_kg} kg` : `derived from ${order.weight_lb || 0} lb`} warn={!(order.weight_lb > 0)} />
            <Field label="pickup_deadline" value={order.pickup_deadline || order.drop_off_deadline || "—"} warn={!order.pickup_deadline && !order.drop_off_deadline} />
            <Field label="delivery_deadline" value={order.delivery_deadline || order.eta || "—"} warn={!order.delivery_deadline && !order.eta} />
          </div>
          <button
            onClick={prepare}
            disabled={preparing}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-60"
          >
            {preparing ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}
            {preparing ? "Preparing…" : "2. Prepare & validate payload"}
          </button>
        </div>
      )}

      {/* Prepared payload preview */}
      {prepared && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-green">
            <CheckCircle2 size={15} />
            Payload validated — review and confirm the create.
          </div>
          <div className="rounded-xl border border-border p-4">
            <p className="text-xs font-medium text-foreground mb-2">Payload to be sent to Render (POST /api/v1/shipments):</p>
            <pre className="text-xs font-mono text-muted-foreground bg-secondary rounded-lg p-3 overflow-auto max-h-56">
{JSON.stringify(prepared.payload, null, 2)}
            </pre>
          </div>
          <div className="rounded-xl bg-secondary p-4 space-y-1.5 text-xs">
            <Field label="command_id" value={prepared.command_id} mono />
            <Field label="correlation_id" value={prepared.correlation_id} mono />
            <Field label="order_id" value={prepared.order_id || "—"} />
          </div>
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={true}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-foreground text-background text-sm font-medium hover:opacity-90 transition disabled:opacity-60"
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : <ShieldAlert size={15} />}
              {creating ? "Creating on Render…" : "Legacy creation disabled — use the approved-owner controlled intake"}
            </button>
            <button
              onClick={reset}
              className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Result — safe fields only */}
      {result && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-green">
            <CheckCircle2 size={15} />
            Shipment created on Render and verified.
          </div>
          <div className="rounded-xl bg-secondary p-4 space-y-2 text-sm">
            <Field label="HTTP status" value={String(result.http_status)} bold />
            <Field label="order_id" value={result.order_id || "—"} />
            <Field label="canonical shipment_id" value={result.canonical_shipment_id || "—"} bold mono />
            <Field label="tracking_id" value={result.tracking_id || "—"} bold mono />
            <Field label="canonical status" value={result.canonical_status || "—"} />
            <Field label="version" value={String(result.version ?? "—")} />
            <Field label="correlation_id" value={result.correlation_id || "—"} mono />
            <Field label="timestamp" value={result.timestamp || "—"} />
          </div>
          {result.verification && (
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs font-medium text-foreground mb-2">Read-back verification (GET /api/v1/shipments/:id):</p>
              <div className="space-y-1.5 text-xs">
                <Field label="verified" value={String(result.verification.verified)} warn={!result.verification.verified} />
                <Field label="canonical_shipment_id" value={result.verification.canonical_shipment_id || "—"} mono />
                <Field label="tracking_id" value={result.verification.tracking_id || "—"} mono />
                <Field label="status" value={result.verification.status || "—"} />
                <Field label="version" value={String(result.verification.version ?? "—")} />
                {result.verification.read_error && (
                  <Field label="read_error" value={result.verification.read_error} warn />
                )}
              </div>
            </div>
          )}
          <button onClick={reset} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">
            Done
          </button>
        </div>
      )}

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 flex items-start gap-2">
          <AlertTriangle size={15} className="text-red-600 mt-0.5 shrink-0" />
          <p className="text-xs text-red-800">{error}</p>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, bold, mono, warn }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`${bold ? "font-semibold text-foreground" : "text-foreground"} ${mono ? "font-mono text-xs break-all" : ""} ${warn ? "text-amber-600" : ""} text-right`}>
        {value || "—"}
      </span>
    </div>
  );
}