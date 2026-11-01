import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { ShieldCheck, Loader2, Check, X, AlertTriangle, MessageSquare, Clock } from "lucide-react";
import Seo from "@/components/Seo";
import OnboardingDocumentsSection from "@/components/dashboard/OnboardingDocumentsSection";

const STATUS_CONFIG = {
  pending_review: { label: "Pending Review", color: "amber", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-300", icon: Clock },
  additional_info_required: { label: "Additional Info Required", color: "amber", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-300", icon: MessageSquare },
  approved: { label: "Approved", color: "green", bg: "bg-green/10", text: "text-green", border: "border-green/30", icon: Check },
  rejected: { label: "Rejected", color: "red", bg: "bg-red-50", text: "text-red-600", border: "border-red-200", icon: X },
};

const VALIDATION_CONFIG = {
  permitted: { label: "Permitted", color: "green", text: "text-green" },
  restricted: { label: "Restricted", color: "amber", text: "text-amber-700" },
  prohibited: { label: "Prohibited", color: "red", text: "text-red-600" },
  unknown: { label: "Unknown", color: "neutral", text: "text-muted-foreground" },
};

export default function ComplianceReviewPage() {
  const { toast } = useToast();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [acting, setActing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke("validateShipmentCompliance", {action:"list_reviews"});
      setReviews(res.data?.items || []);
    } catch (e) {
      toast({ title: "Failed to load reviews", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const takeAction = async (reviewId, actionType, reviewNote) => {
    setActing(true);
    try {
      await base44.functions.invoke("validateShipmentCompliance", {
        action: actionType === "approve" ? "approve" : actionType === "reject" ? "reject" : "request_info",
        review_id: reviewId,
        reviewer_note: reviewNote || "",
      });
      const newStatus = actionType === "approve" ? "approved" : actionType === "reject" ? "rejected" : "additional info required";
      toast({ title: `Review ${newStatus}`, description: "The compliance review has been updated." });
      setAction(""); setNote(""); setSelected(null);
      load();
    } catch (e) {
      toast({ title: "Action failed", description: e.message, variant: "destructive" });
    } finally {
      setActing(false);
    }
  };

  const pending = reviews.filter((r) => r.compliance_status === "pending_review" || r.compliance_status === "additional_info_required");
  const resolved = reviews.filter((r) => r.compliance_status === "approved" || r.compliance_status === "rejected");

  return (
    <div className="max-w-5xl mx-auto">
      <Seo title="Compliance Review" description="Administrative compliance review for restricted and unclassified shipment requests." />
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Compliance Review</h1>
        <p className="text-sm text-muted-foreground mt-1">Review restricted and unclassified shipment requests. Approvals depend on confirmed carrier capabilities and legal requirements.</p>
      </div>

      <OnboardingDocumentsSection />
      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
      ) : reviews.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card p-12 text-center">
          <ShieldCheck size={32} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No compliance review requests yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3">Pending ({pending.length})</h2>
              <div className="space-y-3">
                {pending.map((r) => <ReviewCard key={r.id} review={r} selected={selected} setSelected={setSelected} action={action} setAction={setAction} note={note} setNote={setNote} acting={acting} onAction={takeAction} />)}
              </div>
            </div>
          )}
          {resolved.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3">Resolved ({resolved.length})</h2>
              <div className="space-y-3">
                {resolved.map((r) => <ReviewCard key={r.id} review={r} readonly />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ review, selected, setSelected, action, setAction, note, setNote, acting, onAction, readonly }) {
  const cfg = STATUS_CONFIG[review.compliance_status] || STATUS_CONFIG.pending_review;
  const valCfg = VALIDATION_CONFIG[review.validation_status] || VALIDATION_CONFIG.unknown;
  const isOpen = selected === review.id;

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <cfg.icon size={15} className={cfg.text} />
            <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className={`text-xs font-medium ${valCfg.text}`}>{valCfg.label}</span>
          </div>
          <p className="font-medium text-foreground text-sm mt-1.5">{review.contents_description}</p>
          <p className="text-xs text-muted-foreground mt-1">Category: {review.item_category || "Unclassified"} · Qty: {review.quantity}</p>
          {review.validation_reason && <p className="text-xs text-foreground/70 mt-2">{review.validation_reason}</p>}
          {review.has_battery && <p className="text-xs text-muted-foreground mt-1">Battery: {review.battery_details || "Yes"}</p>}
          {review.reviewer_note && <p className="text-xs text-muted-foreground mt-2"><span className="font-medium">Reviewer note:</span> {review.reviewer_note}</p>}
        </div>
        {!readonly && (
          <button onClick={() => { setSelected(isOpen ? null : review.id); setAction(""); setNote(""); }} className="shrink-0 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-background transition">
            {isOpen ? "Close" : "Review"}
          </button>
        )}
      </div>

      {isOpen && !readonly && (
        <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
          <div className="flex gap-2">
            <button onClick={() => setAction("approve")} className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${action === "approve" ? "bg-green text-white border-green" : "border-border hover:bg-secondary"}`}>Approve</button>
            <button onClick={() => setAction("reject")} className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${action === "reject" ? "bg-red-500 text-white border-red-500" : "border-border hover:bg-secondary"}`}>Reject</button>
            <button onClick={() => setAction("info")} className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${action === "info" ? "bg-amber-500 text-white border-amber-500" : "border-border hover:bg-secondary"}`}>Request Info</button>
          </div>
          {action && (
            <>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note explaining your decision…" rows={2} className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
              <button onClick={() => onAction(review.id, action, note)} disabled={acting} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl gradient-blue text-white text-sm font-medium disabled:opacity-50">
                {acting ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Confirm
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}