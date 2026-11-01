import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Trash2, Loader2, ExternalLink, ShieldAlert, LogIn } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import Seo from "@/components/Seo";

// Public account-deletion page. The backend only ever deletes the signed-in
// caller's account and records, so visitors who aren't signed in are simply
// asked to sign in first.
const PORTAL_LABEL = { vep: "Verified Exchange Partner™", pudo: "PUDO Partner" };

const REMOVED = [
  "Your account profile and sign-in access",
  "Business profile and shipping history, subject to retention review",
  "Saved addresses, shipping profiles, and templates",
  "Invoices, payments, and saved banking details",
  "Notifications, wallet balance, and rewards",
  "Partner memberships and applications",
];

export default function DeleteAccount({ portal = "sender" }) {
  const { user, isLoadingAuth } = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [closure, setClosure] = useState(null);
  const [otherApps, setOtherApps] = useState([]);

  useEffect(() => {
    base44.functions.invoke("getPlatformLinks", {})
      .then((res) => {
        const links = [];
        if (res.data?.carrierAppUrl)
          links.push({ name: "Community Carriers app", url: `${res.data.carrierAppUrl.replace(/\/$/, "")}/delete-account` });
        if (res.data?.opsCenterUrl)
          links.push({ name: "National Ops Center app", url: `${res.data.opsCenterUrl.replace(/\/$/, "")}/delete-account` });
        setOtherApps(links);
      })
      .catch(() => {});
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const result = await base44.functions.invoke("deleteMyAccount", { confirm: "DELETE" });
      if (result.data?.requested !== true) throw new Error("Account closure request was not confirmed");
      setClosure(result.data.message);
      setDeleting(false);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || "Something went wrong. Please try again or contact support.");
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen gradient-mesh flex flex-col items-center justify-center px-4 py-16">
      <Seo title="Delete Account" description="Request a reviewed closure of your Statelines account." />
      <Link
        to="/"
        className="fixed top-5 left-5 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-white/20 text-white/80 text-sm font-medium hover:text-white hover:bg-white/10 transition z-10"
      >
        <ArrowLeft size={15} /> Back to home
      </Link>

      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-600 mb-4">
            <Trash2 className="w-7 h-7 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Delete your account</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Request account closure. Support reviews retention obligations and active shipments before irreversible deletion.
          </p>
        </div>

        <div className="bg-card rounded-2xl shadow-sm border border-border p-8 space-y-6">
          {isLoadingAuth ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            </div>
          ) : !user ? (
            <SignedOutView />
          ) : (
            <>
              <div>
                <p className="text-sm font-medium text-foreground">Signed in as {user.email}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The closure review covers the following data in this app{PORTAL_LABEL[portal] ? `, including your ${PORTAL_LABEL[portal]} portal membership` : ""}.
                </p>
              </div>

              <ul className="space-y-1.5">
                {REMOVED.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-foreground/90">
                    <span className="mt-2 w-1.5 h-1.5 rounded-full bg-destructive shrink-0" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>

              <p className="text-xs text-muted-foreground">
                Shipping, payment, custody and audit history are retained for review; this request does not delete records or stop active shipments.
              </p>

              <div className="rounded-xl border border-border bg-secondary/50 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground">Accounts on other Statelines apps</p>
                <p className="text-xs text-muted-foreground">
                  Portal accounts (Sender, VEP, PUDO) share this app's account and are included in its closure review. If you also signed up separately on our other apps, delete those accounts there:
                </p>
                <div className="space-y-2">
                  <AppLink to="/vep/delete-account" label="Verified Exchange Partner™ portal" desc="Part of this account — deleted together with it." />
                  <AppLink to="/pudo/delete-account" label="PUDO Partner portal" desc="Part of this account — deleted together with it." />
                  {otherApps.map((app) => (
                    <AppLink key={app.url} href={app.url} label={app.name} desc="Separate app with its own account." external />
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="confirm-delete" className="block text-sm font-medium text-foreground mb-2">
                  Type <span className="font-mono font-semibold">DELETE</span> to confirm
                </label>
                <input
                  id="confirm-delete"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                  disabled={deleting}
                  className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
              </div>

              {closure && <p role="status" className="text-sm text-foreground">{closure}</p>}

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <ShieldAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> {error}
                </div>
              )}

              <button
                onClick={handleDelete}
                disabled={deleting || !!closure || confirmText !== "DELETE"}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
                {deleting ? "Recording your request…" : "Request account closure"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AppLink({ to, href, label, desc, external }) {
  const cls = "flex items-center justify-between gap-3 rounded-lg bg-background border border-border px-3.5 py-2.5 hover:border-primary/40 transition";
  const content = (
    <>
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      {external
        ? <ExternalLink size={14} className="text-primary shrink-0" aria-hidden="true" />
        : <ArrowRight size={14} className="text-primary shrink-0" aria-hidden="true" />}
    </>
  );
  return external
    ? <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{content}</a>
    : <Link to={to} className={cls}>{content}</Link>;
}

function SignedOutView() {
  return (
    <div className="text-center space-y-4 py-4">
      <p className="text-sm text-foreground">You need to sign in to delete your account.</p>
      <Link
        to="/login"
        className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition"
      >
        <LogIn size={16} aria-hidden="true" /> Sign in
      </Link>
    </div>
  );
}