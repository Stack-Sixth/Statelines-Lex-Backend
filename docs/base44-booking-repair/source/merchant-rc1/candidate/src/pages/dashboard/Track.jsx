import { readShipmentTimeline } from "@/lib/merchantShipmentReads";
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { readShipments, readShipment } from "@/lib/merchantShipmentReads";
import { useToast } from "@/components/ui/use-toast";
import { Search, MapPin, Truck, Package, CheckCircle2, Clock, QrCode, Navigation, Download, Upload, ShieldCheck, ExternalLink, RefreshCw, Loader2, Activity, Trash2, Ban } from "lucide-react";
import usePlatformLinks from "@/hooks/usePlatformLinks";
import ShipmentOutputs from "@/components/shipment/ShipmentOutputs";
import { motion } from "framer-motion";
import ShipmentFilters from "@/components/shipment/ShipmentFilters";
import BulkImportModal from "@/components/shipment/BulkImportModal";
import TrustTab from "@/components/shipment/TrustTab";
import { downloadCsv } from "@/lib/export";

const TIMELINE = [
  { key: "created", label: "Shipment created", icon: Package },
  { key: "picked_up", label: "Received at Origin Partner Location", icon: MapPin },
  { key: "in_transit", label: "In transit across network", icon: Truck },
  { key: "out_for_delivery", label: "Out for delivery", icon: Navigation },
  { key: "delivered", label: "Delivered", icon: CheckCircle2 },
];
const ORDER = ["created", "picked_up", "in_transit", "out_for_delivery", "delivered"];

const EXPORT_COLS = [
  { header: "Tracking", value: (s) => s.tracking_number || "" },
  { header: "Status", value: (s) => s.status },
  { header: "Service", value: (s) => s.service_level },
  { header: "Origin", value: (s) => s.origin_address },
  { header: "Destination", value: (s) => s.destination_address },
  { header: "Weight (lb)", value: (s) => s.weight_lb },
  { header: "Cost", value: (s) => s.cost },
  { header: "Created", value: (s) => (s.created_date ? new Date(s.created_date).toLocaleDateString() : "") },
];

export default function Track() {
  const [shipments, setShipments] = useState(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ status: "", service_level: "", from: "", to: "" });
  const [selected, setSelected] = useState(null);
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState("timeline");
  const [importOpen, setImportOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const [sel, setSel] = useState(new Set());
  const { toast } = useToast();
  const { opsCenterUrl } = usePlatformLinks();

  const load = async () => {
    try {
      const s = await readShipments(200);
      setShipments(s);
      setSelected((prev) => (prev && s.some((x) => x.id === prev.id) ? s.find((x) => x.id === prev.id) : s[0] || null));
    } catch { setShipments([]); }
  };

  useEffect(() => { load(); }, []);

  // Service-created rows may not be visible through the legacy SDK subscription.
  // Refresh only through the server's ownership-filtered read contract.
  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  // Load custody events for the selected shipment.
  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    readShipmentTimeline(selected.id, "-occurred_at", 50)
      .then(setEvents).catch(() => setEvents([]));
  }, [selected]);

  const requestLiveUpdate = async () => {
    if (!selected) return;
    setRefreshing(true);
    try {
      // Both requests are delivered through LEX, which fans out to the carrier
      // and ops networks. We report what actually happened, not what we asked.
      const results = await Promise.allSettled(
        ["carriers", "ops"].map((platform) =>
          base44.functions.invoke("dispatchPlatformEvent", {
            platform, event: "status_request", shipment_id: selected.id, tracking_number: selected.tracking_number,
            data: { tracking_number: selected.tracking_number },
          })
        )
      );
      if (results.some((r) => r.status === "fulfilled" && r.value.data?.delivered === true)) {
        toast({ title: "Live update requested", description: "The network was asked to re-report status. New events appear here automatically." });
      } else {
        const reason = results[0]?.reason;
        toast({
          title: "Live update could not be delivered",
          description: `${reason?.response?.data?.message || reason?.response?.data?.error || reason?.message || "Network unreachable"}. It is recorded and can be retried.`,
          variant: "destructive",
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const retrySync = async () => {
    if (!selected) return;
    setSyncing(true);
    try {
      const res = await base44.functions.invoke("retryPlatformEvents", { shipment_id: selected.id });
      const d = res.data || {};
      const fresh = await readShipment(selected.id).catch(() => null);
      if (fresh) {
        setSelected(fresh);
        setShipments((prev) => (prev ? prev.map((s) => (s.id === fresh.id ? fresh : s)) : prev));
      }
      const parts = [];
      if (typeof d.delivered === "number") parts.push(`${d.delivered} delivered`);
      if (d.still_failing) parts.push(`${d.still_failing} still failing`);
      if (d.canonical) parts.push(d.canonical.ok ? "network record confirmed" : `network record not confirmed: ${d.canonical.error || "unknown"}`);
      toast({
        title: d.still_failing || (d.canonical && !d.canonical.ok) ? "Some updates are still pending" : "Network sync complete",
        description: parts.join(" · ") || "Nothing left to retry.",
        variant: d.still_failing || (d.canonical && !d.canonical.ok) ? "destructive" : undefined,
      });
    } catch (e) {
      toast({ title: "Retry failed", description: e?.response?.data?.error || e?.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (id) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel((prev) => { const n = new Set(prev); if (filtered.length && filtered.every((s) => n.has(s.id))) { filtered.forEach((s) => n.delete(s.id)); } else { filtered.forEach((s) => n.add(s.id)); } return n; });
  const clear = () => setSel(new Set());
  const exportSelected = () => downloadCsv("selected-shipments.csv", filtered.filter((s) => sel.has(s.id)), EXPORT_COLS);
  const bulkCancel = async () => {
    const ids = [...sel];
    if (!ids.length) return;
    try {
      // Gate each cancel through the Render Domain Platform: if the order is
      // past its cancellation cutoff on Render, the local cancel is blocked.
      const gateResults = await Promise.all(
        ids.map((id) =>
          base44.functions.invoke("cancelOrderGate", { shipment_id: id })
            .then((r) => ({ id, ok: true, body: r.data }))
            .catch((e) => ({ id, ok: false, body: e?.response?.data || { message: e.message } })),
        ),
      );
      const cancellable = gateResults.filter((g) => g.ok && g.body?.cancellable).map((g) => g.id);
      const blocked = gateResults.filter((g) => !g.ok || g.body?.cancellable === false);
      if (cancellable.length === 0) {
        const reason = blocked[0]?.body?.reason || blocked[0]?.body?.message || "Render rejected cancellation";
        toast({ title: "Cancel blocked", description: `No shipments can be cancelled: ${reason}`, variant: "destructive" });
        return;
      }
      // The cancellation itself is a domain command: it is sent with this
      // merchant's verified credentials and addressed by canonical shipment id.
      const cancelResults = await Promise.all(
        cancellable.map((id) =>
          base44.functions.invoke("cancelOrderOnDomain", { shipment_id: id, reason: "Customer requested cancellation" })
            .then((r) => ({ id, ok: true, body: r.data }))
            .catch((e) => ({ id, ok: false, body: e?.response?.data || { message: e.message } })),
        ),
      );
      const cancelled = cancelResults.filter((r) => r.ok && r.body?.cancelled).map((r) => r.id);
      const failed = cancelResults.filter((r) => !(r.ok && r.body?.cancelled));
      setSel(new Set(ids.filter((id) => !cancelled.includes(id)))); await load();
      if (!cancelled.length) {
        const reason = failed[0]?.body?.message || failed[0]?.body?.error || "the domain did not confirm cancellation";
        toast({ title: "Cancel failed", description: reason, variant: "destructive" });
        return;
      }
      if (blocked.length || failed.length) {
        toast({ title: `${cancelled.length} cancelled`, description: `${blocked.length + failed.length} not cancelled`, variant: "destructive" });
      } else {
        toast({ title: `${cancelled.length} shipments cancelled` });
      }
    } catch (e) { toast({ title: "Cancel failed", description: e.message, variant: "destructive" }); }
  };
  const bulkArchive = async () => {
    const ids = [...sel];
    if (!ids.length || !window.confirm(`Archive ${ids.length} selected shipment(s)? Active shipments must be confirmed cancelled first. Records and audit history are retained.`)) return;
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const r = await base44.functions.invoke("archiveMerchantShipment", { shipment_id: id });
        return { id, archived: r.data?.archived === true };
      } catch { return { id, archived: false }; }
    }));
    const archived = new Set(results.filter((r) => r.archived).map((r) => r.id));
    setSel(new Set(ids.filter((id) => !archived.has(id))));
    if (selected && archived.has(selected.id)) setSelected(null);
    await load();
    toast({ title: `${archived.size} archived`, description: `${ids.length - archived.size} pending or blocked; retained for review.`, variant: archived.size === ids.length ? undefined : "destructive" });
  };

  const filtered = (shipments || []).filter((s) => {
    if (query) {
      const q = query.toLowerCase();
      if (!(s.tracking_number || "").toLowerCase().includes(q) && !(s.origin_city || "").toLowerCase().includes(q) && !(s.destination_city || "").toLowerCase().includes(q)) return false;
    }
    if (filters.status && s.status !== filters.status) return false;
    if (filters.service_level && s.service_level !== filters.service_level) return false;
    const created = s.created_date ? new Date(s.created_date) : null;
    if (filters.from && created && created < new Date(filters.from)) return false;
    if (filters.to && created && created > new Date(`${filters.to}T23:59:59`)) return false;
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Shipments</h1>
          <p className="text-sm text-muted-foreground mt-1">Search, filter, and track shipments across the network.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-card text-sm font-medium hover:bg-secondary transition"><Upload size={15} /> Import CSV</button>
          <button onClick={() => downloadCsv("shipments.csv", filtered, EXPORT_COLS)} disabled={!shipments || filtered.length === 0} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-50"><Download size={15} /> Export CSV</button>
        </div>
      </div>

      {sel.size > 0 && (
        <div className="rounded-2xl border border-border bg-card p-3 card-shadow flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground px-1">{sel.size} selected</span>
          <button onClick={exportSelected} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-medium hover:bg-secondary transition"><Download size={13} /> Export</button>
          <button onClick={bulkCancel} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs font-medium hover:bg-secondary transition"><Ban size={13} /> Cancel</button>
          <button onClick={bulkArchive} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-destructive/30 text-destructive text-xs font-medium hover:bg-destructive/5 transition"><Trash2 size={13} /> Archive</button>
          <button onClick={clear} className="ml-auto px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition">Clear</button>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-2xl border border-border/70 bg-card p-4 card-shadow">
            <ShipmentFilters filters={filters} setFilters={setFilters} />
          </div>
          <div className="rounded-2xl border border-border/70 bg-card card-shadow overflow-hidden">
            <div className="p-4 border-b border-border/70">
              <div className="flex items-center gap-2 rounded-xl bg-secondary px-3 py-2">
                <Search size={15} className="text-muted-foreground" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Track a shipment…" className="bg-transparent text-sm outline-none flex-1" />
              </div>
            </div>
            {shipments && filtered.length > 0 && (
              <div className="px-4 py-2 border-b border-border/40 flex items-center gap-3 bg-secondary/40">
                <input type="checkbox" checked={filtered.every((s) => sel.has(s.id))} onChange={toggleAll} className="h-4 w-4 rounded accent-blue-600" />
                <span className="text-xs text-muted-foreground">{filtered.length} shipments</span>
              </div>
            )}
            <div className="max-h-[48vh] overflow-y-auto">
              {!shipments ? <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-secondary animate-pulse" />)}</div> :
               filtered.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No shipments found.</div> :
               filtered.map((s) => (
                <div key={s.id} onClick={() => setSelected(s)} className={`px-4 py-3 border-b border-border/40 flex items-center gap-3 cursor-pointer hover:bg-secondary transition ${selected?.id === s.id ? "bg-secondary" : ""} ${sel.has(s.id) ? "bg-primary/5" : ""}`}>
                  <input type="checkbox" checked={sel.has(s.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(s.id)} className="h-4 w-4 rounded accent-blue-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{s.origin_city || "Origin"} → {s.destination_city || "Destination"}</p>
                    <p className="text-xs text-muted-foreground">{s.tracking_number || s.id.slice(0, 8)}</p>
                  </div>
                  <StatusDot status={s.status} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          {!selected ? <div className="rounded-2xl border border-border/70 bg-card p-10 text-center text-sm text-muted-foreground card-shadow">Select a shipment to track.</div> :
          <motion.div key={selected.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div className="rounded-2xl border border-border/70 bg-card overflow-hidden card-shadow">
              <div className="h-56 gradient-mesh relative">
                <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.2) 1px, transparent 0)", backgroundSize: "24px 24px" }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 text-white">
                    <span className="flex items-center gap-1.5 text-sm"><MapPin size={16} className="text-blue-400" /> {selected.origin_city || "Origin"}</span>
                    <div className="h-px w-16 bg-white/30 relative"><Truck size={16} className="absolute -top-2 left-1/2 -translate-x-1/2 text-blue-400" /></div>
                    <span className="flex items-center gap-1.5 text-sm"><MapPin size={16} className="text-green-400" /> {selected.destination_city || "Destination"}</span>
                  </div>
                </div>
              </div>
              <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Meta label="Tracking" value={selected.tracking_number || "—"} />
                <Meta label="Service" value={selected.service_level} />
                <Meta label="ETA" value={selected.eta ? new Date(selected.eta).toLocaleDateString() : "—"} />
                <Meta label="Carrier" value={selected.carrier_id || "—"} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <button onClick={() => setTab("timeline")} className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition ${tab === "timeline" ? "gradient-blue text-white card-shadow" : "border border-border bg-card text-foreground hover:bg-secondary"}`}><Clock size={14} /> Timeline</button>
              <button onClick={() => setTab("trust")} className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition ${tab === "trust" ? "gradient-blue text-white card-shadow" : "border border-border bg-card text-foreground hover:bg-secondary"}`}><ShieldCheck size={14} /> Trust</button>
              <button onClick={() => setShowOutputs(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border bg-card text-sm font-medium text-foreground hover:bg-secondary transition"><Package size={14} /> Label & QR</button>
              <button onClick={requestLiveUpdate} disabled={refreshing} className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border bg-card text-sm font-medium text-foreground hover:bg-secondary transition disabled:opacity-60">{refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Request live update</button>
              {selected.sync_status !== "synced" && (
                <button onClick={retrySync} disabled={syncing} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border bg-card text-sm font-medium text-foreground hover:bg-secondary transition disabled:opacity-60">{syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Retry sync</button>
              )}
              {opsCenterUrl && (
                <a href={`${opsCenterUrl.replace(/\/$/, "")}/track?tracking=${encodeURIComponent(selected.tracking_number || "")}`} target="_blank" rel="noopener" className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border bg-card text-sm font-medium text-foreground hover:bg-secondary transition"><ExternalLink size={14} /> View in Ops Center</a>
              )}
            </div>

            {selected.sync_status !== "synced" && (
              <p className="text-xs text-amber-600">
                Network sync {selected.sync_status === "failed" ? "failed" : "pending"}
                {selected.sync_message ? `: ${selected.sync_message}` : "."}
              </p>
            )}

            {tab === "timeline" ? (
              <>
                <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
                  <h3 className="font-semibold text-foreground mb-5">Shipment timeline</h3>
                  <div className="space-y-1">
                    {TIMELINE.map((t, i) => {
                      const reached = ORDER.indexOf(selected.status) >= i;
                      const current = selected.status === t.key;
                      return (
                        <div key={t.key} className="flex gap-4">
                          <div className="flex flex-col items-center">
                            <div className={`h-9 w-9 rounded-full flex items-center justify-center transition ${reached ? "gradient-blue text-white" : "bg-secondary text-muted-foreground"} ${current ? "ring-4 ring-primary/20" : ""}`}>
                              <t.icon size={15} />
                            </div>
                            {i < TIMELINE.length - 1 && <div className={`w-0.5 h-8 ${reached ? "bg-primary" : "bg-border"}`} />}
                          </div>
                          <div className="pt-1.5 pb-6">
                            <p className={`text-sm font-medium ${reached ? "text-foreground" : "text-muted-foreground"}`}>{t.label}</p>
                            {current && <p className="text-xs text-primary mt-0.5 flex items-center gap-1"><Clock size={11} /> Current status</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-6">
                  <div className="rounded-2xl border border-border/70 bg-card p-5 card-shadow">
                    <div className="flex items-center gap-2 mb-3"><Truck size={16} className="text-primary" /><h4 className="font-semibold text-foreground text-sm">Community Carrier™</h4></div>
                    <p className="text-sm text-foreground">{selected.carrier_id ? `Carrier #${selected.carrier_id}` : "Awaiting carrier assignment"}</p>
                    <p className="text-xs text-muted-foreground mt-1">Vetted · insured · rated 4.9★</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-card p-5 card-shadow">
                    <div className="flex items-center gap-2 mb-3"><QrCode size={16} className="text-primary" /><h4 className="font-semibold text-foreground text-sm">Proof of Delivery</h4></div>
                    {selected.status === "delivered" ? <p className="text-sm text-green flex items-center gap-1.5"><CheckCircle2 size={15} /> Delivered & signed</p> : <p className="text-sm text-muted-foreground">Pending delivery</p>}
                  </div>
                </div>

                <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2"><Activity size={16} className="text-primary" /><h3 className="font-semibold text-foreground">Live custody events</h3></div>
                    <span className="text-xs text-muted-foreground">{events.length} recorded</span>
                  </div>
                  {events.length === 0 ? <p className="text-sm text-muted-foreground">No custody events yet. Status updates from carriers appear here in real time.</p> : (
                    <div className="space-y-3">
                      {events.map((e) => (
                        <div key={e.id} className="flex gap-3">
                          <div className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-foreground">{e.event}</p>
                            <p className="text-xs text-muted-foreground">{e.custodian ? `${e.custodian} · ` : ""}{e.location ? `${e.location} · ` : ""}{e.occurred_at ? new Date(e.occurred_at).toLocaleString() : ""}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <TrustTab shipment={selected} />
            )}
          </motion.div>}
        </div>
      </div>

      {importOpen && <BulkImportModal onClose={() => setImportOpen(false)} onImported={async () => { setImportOpen(false); await load(); }} />}
      {showOutputs && selected && <ShipmentOutputs shipment={selected} onClose={() => setShowOutputs(false)} />}
    </div>
  );
}

function StatusDot({ status }) {
  const color = { delivered: "bg-green", cancelled: "bg-red-500", created: "bg-gray-400" }[status] || "bg-primary";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}
function Meta({ label, value }) {
  return <div><p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p><p className="text-sm font-medium text-foreground mt-1 truncate">{value}</p></div>;
}