import { readShipments } from "@/lib/merchantShipmentReads";
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { mergeEvent } from "@/lib/realtime";
import { Plus, RotateCcw, X, Loader2, Ban } from "lucide-react";

const REASONS = ["Damaged in transit", "Wrong item shipped", "Customer refused delivery", "Undeliverable", "Other"];
const STATUS_STYLES = {
  requested: ["bg-blue-50", "text-blue-600", "Requested"],
  approved: ["bg-amber-50", "text-amber-600", "Approved"],
  in_transit: ["bg-blue-50", "text-blue-600", "In transit"],
  received: ["bg-orange-50", "text-orange-600", "Received"],
  completed: ["bg-green/10", "text-green", "Completed"],
  cancelled: ["bg-secondary", "text-muted-foreground", "Cancelled"],
};
const CANCELLABLE = ["requested", "approved"];

export default function Returns() {
  const { toast } = useToast();
  const [returns, setReturns] = useState(null);
  const [shipments, setShipments] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ shipment_id: "", reason: REASONS[0], description: "" });
  const [saving, setSaving] = useState(false);

  const load = () => base44.entities.ReturnOrder.list("-created_date", 100).then(setReturns).catch(() => setReturns([]));
  useEffect(() => {
    load();
    const unsub = base44.entities.ReturnOrder.subscribe((event) => setReturns((prev) => mergeEvent(prev, event)));
    return unsub;
  }, []);

  const openModal = async () => {
    setForm({ shipment_id: "", reason: REASONS[0], description: "" });
    setOpen(true);
    try { const s = await readShipments(50); setShipments(s); } catch { setShipments([]); }
  };

  const submit = async () => {
    if (!form.shipment_id) { toast({ title: "Select a shipment", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const shipment = shipments.find((s) => s.id === form.shipment_id);
      await base44.entities.ReturnOrder.create({
        shipment_id: form.shipment_id,
        tracking_number: shipment?.tracking_number || "",
        reason: form.reason,
        description: form.description,
      });
      await base44.entities.Notification.create({
        title: "Return request submitted",
        body: `Your return for ${shipment?.tracking_number || "your shipment"} has been requested.`,
        type: "shipment",
      });
      setOpen(false);
      await load();
      toast({ title: "Return requested", description: "We'll update you as it progresses." });
    } catch (e) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const cancel = async (r) => {
    if (!window.confirm("Cancel this return request?")) return;
    try {
      await base44.entities.ReturnOrder.update(r.id, { status: "cancelled" });
      await base44.entities.Notification.create({
        title: "Return request updated",
        body: `Your return for ${r.tracking_number || "your shipment"} was cancelled.`,
        type: "shipment",
      });
      await load();
      toast({ title: "Return cancelled" });
    } catch (e) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Returns</h1>
          <p className="text-sm text-muted-foreground mt-1">Request and track returns for your shipments.</p>
        </div>
        <button onClick={openModal} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition"><Plus size={16} /> Request return</button>
      </div>

      {!returns ? (
        <div className="text-center py-10"><Loader2 size={22} className="mx-auto text-muted-foreground animate-spin" /></div>
      ) : returns.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card p-12 text-center card-shadow">
          <RotateCcw size={28} className="mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No returns yet</p>
          <p className="text-xs text-muted-foreground mt-1">Request a return for any of your shipments here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {returns.map((r) => {
            const [bg, color, label] = STATUS_STYLES[r.status] || STATUS_STYLES.requested;
            return (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card p-5 card-shadow">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{r.reason}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{r.tracking_number || "No tracking"} · Requested {new Date(r.created_date).toLocaleDateString()}</p>
                  {r.description && <p className="text-xs text-muted-foreground mt-1.5 line-clamp-1">{r.description}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${bg} ${color}`}>{label}</span>
                  {CANCELLABLE.includes(r.status) && (
                    <button onClick={() => cancel(r)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-red-600 hover:bg-red-50 transition"><Ban size={12} /> Cancel</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="rounded-2xl bg-card card-shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-foreground">Request a return</h3>
              <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-secondary transition"><X size={18} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">Shipment *</label>
                <select value={form.shipment_id} onChange={(e) => setForm({ ...form, shipment_id: e.target.value })} className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Select a shipment…</option>
                  {shipments.map((s) => <option key={s.id} value={s.id}>{s.tracking_number || s.id.slice(0, 8)} · {s.origin_city || "Origin"} → {s.destination_city || "Destination"}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">Reason</label>
                <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={4} placeholder="Anything we should know about this return…" className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">Cancel</button>
              <button onClick={submit} disabled={saving} className="px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-60 inline-flex items-center gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />} Submit request</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}