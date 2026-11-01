import { readShipmentTimeline } from "@/lib/merchantShipmentReads";
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { ShieldCheck, User, MapPin, Fingerprint, Loader2 } from "lucide-react";

export default function TrustTab({ shipment }) {
  const [events, setEvents] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const evts = await readShipmentTimeline(shipment.id, "occurred_at", 50);
        setEvents(evts);
      } catch { setEvents([]); }
    })();
  }, [shipment.id]);

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-green" /><h3 className="font-semibold text-foreground">Chain of custody</h3></div>
        <span className="text-xs text-muted-foreground">Every handoff is logged with its verification method</span>
      </div>
      {!events ? (
        <div className="py-6 text-center"><Loader2 size={20} className="mx-auto text-muted-foreground animate-spin" /></div>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No chain-of-custody events recorded for this shipment yet.</p>
      ) : (
        <div className="space-y-1">
          {events.map((e, i) => (
            <div key={e.id} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="h-9 w-9 rounded-full bg-green/10 text-green flex items-center justify-center shrink-0"><Fingerprint size={14} /></div>
                {i < events.length - 1 && <div className="w-0.5 h-full min-h-8 bg-green/30" />}
              </div>
              <div className="pt-1 pb-6 min-w-0">
                <p className="text-sm font-medium text-foreground">{e.event}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><MapPin size={11} /> {e.location || "—"}</span>
                  <span className="inline-flex items-center gap-1"><User size={11} /> {e.custodian || "—"}</span>
                  {e.verification_method && <span className="inline-flex items-center gap-1 text-green"><ShieldCheck size={11} /> {e.verification_method}</span>}
                </div>
                <p className="text-xs text-muted-foreground/80 mt-1">{e.occurred_at ? new Date(e.occurred_at).toLocaleString() : "—"}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}