import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowRight, Package, Trash2 } from "lucide-react";
import { SHIPMENT_STEPS } from "@/lib/shipmentSteps";

const savedLabel = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

// Shipments that were left unfinished, so they can be picked up exactly where
// they stopped or thrown away. A draft is never booked — it only becomes a real
// shipment once the payment requirement is met on the confirmation step.
export default function IncompleteShipments() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState(null);
  const [pending, setPending] = useState(null);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const user = await base44.auth.me();
        const response = await base44.functions.invoke("merchantDraft", {
          action: "list",
          limit: 5,
        });
        const page = response.data || {};
        if (active) setDrafts(page.items || []);
      } catch {
        if (active) setDrafts([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const discard = async () => {
    if (!pending) return;
    setDiscarding(true);
    try {
      const result = await base44.functions.invoke("merchantDraft", {
        action: "discard",
        draft_id: pending.id,
      });
      if (result.data?.discarded !== true)
        throw new Error(
          result.data?.code || "Draft is claimed or awaiting review",
        );
      setDrafts((list) => (list || []).filter((d) => d.id !== pending.id));
      toast({
        title: "Draft discarded",
        description:
          "That incomplete shipment was archived; its history is retained.",
      });
      setPending(null);
    } catch (e) {
      toast({
        title: "Couldn't discard the draft",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setDiscarding(false);
    }
  };

  // Nothing pending: the section stays out of the way.
  if (!drafts || drafts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-foreground">
            Incomplete shipments
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pick up where you left off, or discard a draft you no longer need.
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
        </span>
      </div>

      <div className="space-y-2">
        {drafts.map((draft) => (
          <div
            key={draft.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                <Package size={15} className="text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {draft.route_label || "Unfinished shipment"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Stopped at {SHIPMENT_STEPS[Number(draft.step) || 0]}
                  {savedLabel(draft.last_saved_at)
                    ? ` · saved ${savedLabel(draft.last_saved_at)}`
                    : ""}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate(`/dashboard/create?draft=${draft.id}`)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition"
              >
                Continue Shipment <ArrowRight size={14} />
              </button>
              <button
                type="button"
                onClick={() => setPending(draft)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-border bg-card text-sm font-medium hover:bg-secondary transition"
              >
                <Trash2 size={14} /> Discard Shipment
              </button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this shipment?</AlertDialogTitle>
            <AlertDialogDescription>
              This hides {pending?.route_label || "this draft"} from unfinished
              shipments. Its details and any booking linkage are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discarding}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                discard();
              }}
              disabled={discarding}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {discarding ? "Discarding…" : "Discard Shipment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
