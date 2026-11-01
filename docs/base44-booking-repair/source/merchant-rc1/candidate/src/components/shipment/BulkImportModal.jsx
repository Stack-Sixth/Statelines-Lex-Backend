import { useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { X, Upload, Loader2, FileSpreadsheet, CheckCircle2 } from "lucide-react";

const TEMPLATE_COLS = "origin_address, destination_address, origin_city, destination_city, service_level, intake_method, weight_lb, declared_value, insurance";

export default function BulkImportModal({ onClose, onImported }) {
  const { toast } = useToast();
  const [stage, setStage] = useState("idle"); // idle | working | preview | importing
  const imported = useRef(new Map());
  const uncertain = useRef(false);
  const [rows, setRows] = useState([]);
  const [skipped, setSkipped] = useState(0);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStage("working");
    try {
      const { file_url } = await base44.integrations.Core.UploadPublicFile({ file });
      const res = await base44.functions.invoke("extractShipmentsCsv", { file_url });
      setRows(res.data.shipments || []);
      setSkipped(res.data.skipped || 0);
      setStage("preview");
    } catch (err) {
      toast({ title: "Import failed", description: err.response?.data?.error || err.message, variant: "destructive" });
      setStage("idle");
    }
  };

  const confirm = async () => {
    setStage("importing");
    try {
      if (uncertain.current) throw new Error("A draft insert has an unknown outcome. Review Incomplete Shipments before re-importing; no automatic retry is safe.");
      for (let i = 0; i < rows.length; i++) {
        if (imported.current.has(i)) continue;
        uncertain.current = true;
        const response = await base44.functions.invoke("merchantDraft", { action:"save", data:rows[i], step:0, options:{} });
        if (!response.data?.draft?.id) throw new Error("Draft insert was not confirmed");
        imported.current.set(i,response.data.draft.id);
        uncertain.current = false;
      }
      toast({ title: `${imported.current.size} unbooked drafts imported`, description:"Review each draft, obtain a quote and confirm through the normal booking handler. No carrier requests were sent." });
      onImported();
    } catch (err) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
      setStage("preview");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-2xl bg-card card-shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-foreground">Import unbooked drafts from CSV</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary transition"><X size={18} /></button>
        </div>

        {stage === "idle" && (
          <div className="space-y-4">
            <label className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border px-6 py-10 text-center cursor-pointer hover:bg-secondary transition">
              <Upload size={22} className="text-primary" />
              <p className="text-sm font-medium text-foreground">Click to upload a CSV file</p>
              <p className="text-xs text-muted-foreground">Each row becomes a draft requiring review and booking confirmation</p>
              <input type="file" accept=".csv" className="hidden" onChange={handleFile} />
            </label>
            <div className="rounded-xl bg-secondary p-4">
              <p className="text-xs font-medium text-foreground mb-1.5">Expected columns</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground font-mono break-words">{TEMPLATE_COLS}</p>
              <p className="text-[11px] text-muted-foreground mt-2">Origin and destination addresses are required; other columns are optional.</p>
            </div>
          </div>
        )}

        {stage === "working" && (
          <div className="py-12 flex flex-col items-center gap-3">
            <Loader2 size={24} className="text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Reading your file…</p>
          </div>
        )}

        {stage === "preview" && (
          <div className="space-y-4">
            {rows.length === 0 ? (
              <div className="py-8 text-center">
                <FileSpreadsheet size={26} className="mx-auto text-muted-foreground mb-3" />
                <p className="text-sm font-medium text-foreground">No valid shipments found</p>
                <p className="text-xs text-muted-foreground mt-1">{skipped > 0 ? `${skipped} rows were read but none had both addresses.` : "Try a CSV with the expected columns."}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 rounded-xl bg-green/5 border border-green/30 p-4">
                  <CheckCircle2 size={20} className="text-green shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">{rows.length} drafts ready to import</p>
                    {skipped > 0 && <p className="text-xs text-muted-foreground">{skipped} rows skipped (missing addresses).</p>}
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-xl border border-border/70">
                  {rows.slice(0, 8).map((r, i) => (
                    <div key={i} className="px-4 py-2.5 border-b border-border/40 last:border-0 flex items-center justify-between gap-3">
                      <p className="text-xs text-foreground truncate">{r.origin_city || r.origin_address} → {r.destination_city || r.destination_address}</p>
                      <span className="text-xs text-muted-foreground shrink-0">{r.service_level}</span>
                    </div>
                  ))}
                  {rows.length > 8 && <p className="px-4 py-2 text-xs text-muted-foreground">+ {rows.length - 8} more…</p>}
                </div>
              </>
            )}
            <div className="flex justify-end gap-3">
              <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">{rows.length === 0 ? "Close" : "Cancel"}</button>
              {rows.length > 0 && (
                <button onClick={confirm} className="px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition inline-flex items-center gap-1.5">
                  {stage === "importing" && <Loader2 size={14} className="animate-spin" />} Import {rows.length} drafts
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}