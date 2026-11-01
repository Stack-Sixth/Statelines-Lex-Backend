import { readShipments } from "@/lib/merchantShipmentReads";
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { base44 } from "@/api/base44Client";
import StatCard from "@/components/dashboard/StatCard";
import { useMerchant } from "@/lib/MerchantContext";
import { Package, Truck, DollarSign, PiggyBank, ArrowRight, Plus, Search, Receipt, Bell, ShieldCheck, Rocket, BarChart3 } from "lucide-react";
import { motion } from "framer-motion";
import GuidelinesDownloadCard from "@/components/shipping/GuidelinesDownloadCard";

export default function IndividualHome() {
  const [shipments, setShipments] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [notifications, setNotifications] = useState(null);
  const { merchant } = useMerchant();
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [s, inv, n, tasks] = await Promise.all([
          readShipments(200),
          base44.entities.Invoice.list("-created_date", 50),
          base44.entities.Notification.list("-created_date", 8),
          base44.entities.OnboardingTask.list("step_order", 20),
        ]);
        setShipments(s); setInvoices(inv); setNotifications(n);
        setVerified(tasks.length > 0 && tasks.every((t) => t.status === "approved"));
      } catch {
        setShipments([]); setInvoices([]); setNotifications([]);
      }
    })();
  }, []);

  useEffect(() => {
    let active=true;
    const timer=setInterval(()=>{readShipments(200).then(rows=>{if(active)setShipments(rows);}).catch(()=>{});},15000);
    return ()=>{active=false;clearInterval(timer);};
  }, []);

  const inTransit = (shipments || []).filter((s) => ["picked_up", "in_transit", "out_for_delivery"].includes(s.status)).length;
  const todayCount = (shipments || []).filter((s) => new Date(s.created_date).toDateString() === new Date().toDateString()).length;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayCount = (shipments || []).filter((s) => new Date(s.created_date).toDateString() === yesterday.toDateString()).length;
  const todayTrend = todayCount === 0 && yesterdayCount === 0 ? null
    : yesterdayCount === 0 ? "+100%"
    : `${todayCount >= yesterdayCount ? "+" : ""}${Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)}%`;
  const monthlySpend = (invoices || []).filter((i) => i.status === "paid" || i.status === "open").reduce((a, i) => a + (i.total || 0), 0);
  const totalSavings = Math.round(monthlySpend * 0.41);

  const volume = useMemo(() => buildVolume(shipments || []), [shipments]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Welcome back</h1>
            {verified && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green/10 text-green text-xs font-semibold">
                <ShieldCheck size={13} /> Merchant Verified
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">Here's what's moving across your network today.</p>
        </div>
        <Link to="/dashboard/create" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition"><Plus size={16} /> New Shipment</Link>
      </div>

      {!merchant && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl gradient-blue flex items-center justify-center"><Rocket size={18} className="text-white" /></div>
            <div>
              <p className="text-sm font-semibold text-foreground">Complete your business setup</p>
              <p className="text-xs text-muted-foreground">Add your business details and choose a plan to unlock the full network.</p>
            </div>
          </div>
          <Link to="/dashboard/setup" className="px-4 py-2 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition inline-flex items-center gap-1.5">Set up now <ArrowRight size={15} /></Link>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Shipments Today" value={shipments ? todayCount : "—"} trend={todayTrend} sub="vs yesterday" icon={Package} />
        <StatCard label="In Transit" value={shipments ? inTransit : "—"} sub="live across network" icon={Truck} accent="bg-blue-500/10" />
        <StatCard label="Monthly Spend" value={invoices ? `$${monthlySpend.toLocaleString()}` : "—"} sub="current period" icon={DollarSign} />
        <StatCard label="Total Savings" value={invoices ? `$${totalSavings.toLocaleString()}` : "—"} sub="est. vs standard carriers" icon={PiggyBank} accent="bg-green/10" />
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-semibold text-foreground">Shipment volume</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Last 7 days</p>
          </div>
          <span className="text-xs font-medium text-muted-foreground">{(shipments || []).length} total</span>
        </div>
        {!shipments ? (
          <div className="h-[220px] rounded-xl bg-secondary animate-pulse" />
        ) : shipments.length === 0 ? (
          <div className="h-[220px] flex flex-col items-center justify-center text-center">
            <BarChart3 size={26} className="text-muted-foreground mb-2" />
            <p className="text-sm font-medium text-foreground">No shipment activity yet</p>
            <p className="text-xs text-muted-foreground mt-1">Your volume will appear here once you create shipments.</p>
          </div>
        ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={volume}>
            <defs><linearGradient id="vol" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0057FF" stopOpacity={0.3} /><stop offset="100%" stopColor="#0057FF" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} allowDecimals={false} />
            <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #eef1f5", boxShadow: "0 8px 24px rgba(7,26,53,0.08)" }} />
            <Area type="monotone" dataKey="count" stroke="#0057FF" strokeWidth={2.5} fill="url(#vol)" />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-2xl border border-border/70 bg-card p-6 card-shadow">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-foreground">Recent shipments</h2>
            <Link to="/dashboard/track" className="text-sm font-medium text-primary inline-flex items-center gap-1 hover:gap-2 transition-all">View all <ArrowRight size={14} /></Link>
          </div>
          {!shipments ? <Skeleton rows={5} /> : shipments.length === 0 ? <Empty label="No shipments yet" cta="Create your first shipment" to="/dashboard/create" /> : (
            <div className="space-y-1">
              {shipments.slice(0, 6).map((s) => (
                <Link key={s.id} to="/dashboard/track" className="flex items-center justify-between rounded-xl px-3 py-3 hover:bg-secondary transition">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-secondary flex items-center justify-center shrink-0"><Package size={15} className="text-primary" /></div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{s.origin_city || "Origin"} → {s.destination_city || "Destination"}</p>
                      <p className="text-xs text-muted-foreground">{s.tracking_number || s.id.slice(0, 8)} · {s.service_level}</p>
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-6 card-shadow">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-foreground">Notifications</h2>
            <Bell size={16} className="text-muted-foreground" />
          </div>
          {!notifications ? <Skeleton rows={4} /> : notifications.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">You're all caught up.</div>
          ) : (
            <div className="space-y-3">
              {notifications.slice(0, 5).map((n) => (
                <div key={n.id} className="flex gap-3">
                  <div className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${n.read ? "bg-border" : "bg-primary"}`} />
                  <div><p className="text-sm font-medium text-foreground leading-snug">{n.title}</p><p className="text-xs text-muted-foreground mt-0.5">{n.body}</p></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[["Create Shipment", "/dashboard/create", Plus], ["Track a Package", "/dashboard/track", Search], ["View Invoices", "/dashboard/billing", Receipt]].map(([label, to, Icon]) => (
          <Link key={label} to={to} className="group rounded-2xl border border-border/70 bg-card p-5 card-shadow hover:card-shadow-lg transition-all flex items-center justify-between">
            <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center"><Icon size={18} className="text-primary" /></div><span className="font-medium text-foreground">{label}</span></div>
            <ArrowRight size={16} className="text-muted-foreground group-hover:translate-x-0.5 transition" />
          </Link>
        ))}
        <GuidelinesDownloadCard />
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    created: ["bg-secondary", "text-muted-foreground", "Created"],
    picked_up: ["bg-blue-50", "text-blue-600", "Picked up"],
    in_transit: ["bg-blue-50", "text-blue-600", "In transit"],
    out_for_delivery: ["bg-amber-50", "text-amber-600", "Out for delivery"],
    delivered: ["bg-green/10", "text-green", "Delivered"],
    cancelled: ["bg-red-50", "text-red-600", "Cancelled"],
  };
  const [bg, color, label] = map[status] || map.created;
  return <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${bg} ${color}`}>{label}</span>;
}

function buildVolume(shipments) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ date: d, label: d.toLocaleDateString("en", { weekday: "short" }), count: 0 });
  }
  shipments.forEach((s) => {
    if (!s.created_date) return;
    const cd = new Date(s.created_date);
    cd.setHours(0, 0, 0, 0);
    const slot = days.find((d) => d.date.getTime() === cd.getTime());
    if (slot) slot.count += 1;
  });
  return days.map(({ label, count }) => ({ label, count }));
}

function Skeleton({ rows = 4 }) {
  return <div className="space-y-3">{Array.from({ length: rows }).map((_, i) => <div key={i} className="h-12 rounded-xl bg-secondary animate-pulse" />)}</div>;
}

function Empty({ label, cta, to }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-10">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Link to={to} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary">{cta} <ArrowRight size={14} /></Link>
    </motion.div>
  );
}