import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMerchant } from "@/lib/MerchantContext";
import { PackageCheck, Clock, Loader2, Package, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

// PUDO — packages ready for pickup by recipients at this location.
// Shows shipments in "ready_for_collection" status.
export default function PudoReady() {
  const { merchant } = useMerchant();
  const [shipments, setShipments] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await base44.functions.invoke("partnerCustody", {action:"queue"});
        setShipments(res.data?.ready_for_collection || []);
      } catch {
        setShipments([]);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Ready for Pickup</h1>
        <p className="text-sm text-muted-foreground mt-1">Packages at your facility awaiting recipient collection.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-border/70 bg-card p-5 card-shadow">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Awaiting Pickup</p>
              <p className="font-display text-2xl font-semibold text-foreground mt-1.5">{shipments?.length ?? "—"}</p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center"><PackageCheck size={18} className="text-amber-600" /></div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="h-9 w-9 rounded-xl bg-amber-50 flex items-center justify-center"><PackageCheck size={17} className="text-amber-600" /></div>
          <h2 className="font-semibold text-foreground">Pickup queue</h2>
        </div>
        {!shipments ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted-foreground" /></div>
        ) : shipments.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No packages awaiting pickup.</p>
        ) : (
          <div className="space-y-2.5">
            {shipments.map((s) => (
              <Link key={s.id} to="/dashboard/track" className="flex items-center gap-3 rounded-xl border border-border/60 p-3 hover:bg-secondary transition">
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Package size={15} className="text-primary" /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{s.origin_city || "Origin"} → {s.destination_city || "Destination"}</p>
                  <p className="text-xs text-muted-foreground truncate">{s.tracking_number || s.id.slice(0, 8)} · {s.destination_location_name || "—"}</p>
                </div>
                {s.drop_off_deadline && (
                  <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-600">
                    <Clock size={11} /> {new Date(s.drop_off_deadline).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                )}
                <ArrowRight size={15} className="text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}