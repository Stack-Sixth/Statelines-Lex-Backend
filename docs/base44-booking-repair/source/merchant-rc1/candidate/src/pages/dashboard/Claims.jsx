import { readShipments } from "@/lib/merchantShipmentReads";
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { mergeEvent } from "@/lib/realtime";
import { Plus, ShieldAlert, X, Loader2, Upload, FileText } from "lucide-react";

const TYPES = [
  ["lost_package", "Lost Package"],
  ["damaged_package", "Damaged Package"],
  ["delayed_shipment", "Delayed Shipment"],
  ["missing_contents", "Missing Contents"],
];
const STATUS_STYLES = {
  submitted: ["bg-blue-50", "text-blue-600", "Submitted"],
  under_review: ["bg-amber-50", "text-amber-600", "Under Review"],
  info_requested: ["bg-orange-50", "text-orange-600", "More Info Requested"],
  approved: ["bg-green/10", "text-green", "Approved"],
  denied: ["bg-red-50", "text-red-600", "Denied"],
  closed: ["bg-secondary", "text-muted-foreground", "Closed"],
};

export default function Claims() {
  const { toast } = useToast();
  const [claims, setClaims] = useState(null);
  const [shipments, setShipments] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ shipment_id: "", type: "lost_package", description: "", photo_url: "", document_url: "" });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(null);

  const load = () => base44.entities.Claim.list("-created_date", 100).then(setClaims).catch(() => setClaims([]));
  useEffect(() => {
    load();
    const unsub = base44.entities.Claim.subscribe((event) => setClaims((prev) => mergeEvent(prev, event)));
    return unsub;
  }, []);

  const openModal = async () => {
    setForm({ shipment_id: "", type: "lost_package", description: "", photo_url: "", document_url: "" });
    setOpen(true);
    try { const s = await readShipments(50); setShipments(s); } catch { setShipments([]); }
  };

  const openFile = async (uri) => {
    try {
      const res = await base44.functions.invoke("signFileUrl", { file_uri: uri });
      window.open(res.data.url, "_blank", "noopener");
    } catch (e) {
      toast({ title: "Could not open file", description: e.message, variant: "destructive" });
    }
  };

  const upload = async (e, field) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(field);
    try {
      const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });
      setForm((f) => ({ ...f, [field]: file_uri }));
      toast({ title: "File uploaded" });
    } catch (err) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally { setUploading(null); }
  };

  const submit = async () => {
    if (!form.shipment_id) { toast({ title: "Select a shipment", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const shipment = shipments.find((s) => s.id === form.shipment_id);
      const created = await base44.entities.Claim.create({
        shipment_id: form.shipment_id,
        tracking_number: shipment?.tracking_number || "",
        type: form.type,
        description: form.description,
        photo_url: form.photo_url,
        document_url: form.document_url,
      });
      await base44.entities.Notification.create({
        title: "Claim submitted",
        body: `Your ${TYPES.find(([k]) => k === form.type)[1].toLowerCase()} claim for ${shipment?.tracking_number || "your shipment"} has been submitted.`,
        type: "shipment",
      });
      setOpen(false);
      await load();
      toast({ title: "Claim submitted", description: "Our team will review it shortly." });
    } catch (e) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Claims</h1>
          <p className="text-sm text-muted-foreground mt-1">Submit and track claims for lost, damaged, or delayed shipments.</p>
        </div>
        <button onClick={openModal} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition"><Plus size={16} /> New claim</button>
      </div>

      {!claims ? (
        <div className="text-center py-10"><Loader2 size={22} className="mx-auto text-muted-foreground animate-spin" /></div>
      ) : claims.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card p-12 text-center card-shadow">
          <ShieldAlert size={28} className="mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No claims filed</p>
          <p className="text-xs text-muted-foreground mt-1">If something goes wrong with a shipment, file a claim here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {claims.map((c) => {
            const [bg, color, label] = STATUS_STYLES[c.status] || STATUS_STYLES.submitted;
            return (
              <div key={c.id} className="rounded-2xl border border-border/70 bg-card p-5 card-shadow">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{TYPES.find(([k]) => k === c.type)?.[1] || c.type}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{c.tracking_number || "No tracking"} · Filed {new Date(c.created_date).toLocaleDateString()}</p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${bg} ${color}`}>{label}</span>
                </div>
                {c.description && <p className="mt-3 text-sm text-muted-foreground line-clamp-2">{c.description}</p>}
                {(c.photo_url || c.document_url) && (
                  <div className="mt-3 flex gap-2">
                    {c.photo_url && <button onClick={() => openFile(c.photo_url)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-secondary transition"><Upload size={12} /> Photo</button>}
                    {c.document_url && <button onClick={() => openFile(c.document_url)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-secondary transition"><FileText size={12} /> Document</button>}
                  </div>
                )}
                {c.resolution_note && <p className="mt-3 text-sm text-foreground bg-secondary rounded-xl px-4 py-3">{c.resolution_note}</p>}
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="rounded-2xl bg-card card-shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-foreground">File a claim</h3>
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
                <label className="text-xs font-medium text-foreground mb-1.5 block">Claim type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={4} placeholder="Describe what happened…" className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Photo {form.photo_url && <span className="text-green">✓</span>}</label>
                  <label className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:bg-secondary transition cursor-pointer">
                    {uploading === "photo_url" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {form.photo_url ? "Replace photo" : "Upload photo"}
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e, "photo_url")} />
                  </label>
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground mb-1.5 block">Supporting document {form.document_url && <span className="text-green">✓</span>}</label>
                  <label className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:bg-secondary transition cursor-pointer">
                    {uploading === "document_url" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} {form.document_url ? "Replace file" : "Upload file"}
                    <input type="file" className="hidden" onChange={(e) => upload(e, "document_url")} />
                  </label>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">Cancel</button>
              <button onClick={submit} disabled={saving} className="px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-60 inline-flex items-center gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />} Submit claim</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}