import { readShipments } from "@/lib/merchantShipmentReads";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useMerchant } from "@/lib/MerchantContext";
import StatCard from "@/components/dashboard/StatCard";
import { Package, Truck, DollarSign, MapPin, ArrowRight, Plus, Users, BarChart3, Building2, Receipt } from "lucide-react";
import { motion } from "framer-motion";
import GuidelinesDownloadCard from "@/components/shipping/GuidelinesDownloadCard";

export default function OrganizationHome() {
  const { merchant } = useMerchant();
  const [shipments, setShipments] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [team, setTeam] = useState([]);
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [s, inv, u, l] = await Promise.all([
          readShipments(200),
          base44.entities.Invoice.list("-created_date", 50),
          base44.entities.User.list().catch(() => []),
          base44.entities.Location.list().catch(() => []),
        ]);
        setShipments(s); setInvoices(inv); setTeam(u || []); setLocations(l || []);
      } catch {
        setShipments([]); setInvoices([]); setTeam([]); setLocations([]);
      }
    })();
  }, []);

  useEffect(() => {
    let active=true;
    const timer=setInterval(()=>{readShipments(200).then(rows=>{if(active)setShipments(rows);}).catch(()=>{});},15000);
    return ()=>{active=false;clearInterval(timer);};
  }, []);

  const inTransit = (shipments || []).filter((s) => ["picked_up", "in_transit", "out_for_delivery"].includes(s.status)).length;
  const monthlySpend = (invoices || []).filter((i) => i.status === "paid" || i.status === "open").reduce((a, i) => a + (i.total || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">{merchant?.company_name || "Organization"}</h1>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-500/10 text-violet-600 text-xs font-semibold">
              <Building2 size={13} /> Organization
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">Your company shipping overview across teams and locations.</p>
        </div>
        <Link to="/dashboard/create" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition"><Plus size={16} /> New Shipment</Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Active Shipments" value={shipments ? inTransit : "—"} sub="in transit" icon={Truck} accent="bg-blue-500/10" />
        <StatCard label="Monthly Spend" value={invoices ? `$${monthlySpend.toLocaleString()}` : "—"} sub="current period" icon={DollarSign} />
        <StatCard label="Team Members" value={team.length} sub="with access" icon={Users} accent="bg-violet-500/10" />
        <StatCard label="Locations" value={locations.length} sub="business sites" icon={MapPin} accent="bg-green/10" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-2xl border border-border/70 bg-card p-6 card-shadow">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-foreground">Recent shipments</h2>
            <Link to="/dashboard/track" className="text-sm font-medium text-primary inline-flex items-center gap-1 hover:gap-2 transition-all">View all <ArrowRight size={14} /></Link>
          </div>
          {!shipments ? <Skeleton rows={5} /> : shipments.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-sm text-muted-foreground">No shipments yet</p>
              <Link to="/dashboard/create" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary">Create your first shipment <ArrowRight size={14} /></Link>
            </div>
          ) : (
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
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-foreground">Team</h2>
            <Link to="/dashboard/team" className="text-sm font-medium text-primary inline-flex items-center gap-1 hover:gap-2 transition-all">Manage <ArrowRight size={14} /></Link>
          </div>
          {team.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team members yet. Invite teammates to collaborate.</p>
          ) : (
            <div className="space-y-2">
              {team.slice(0, 5).map((u) => (
                <div key={u.id} className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-600 text-xs font-semibold">
                    {(u.full_name || u.email || "U").slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{u.full_name || u.email}</p>
                    <p className="text-xs text-muted-foreground capitalize">{u.role || "user"}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[["Create Shipment", "/dashboard/create", Plus], ["Manage Team", "/dashboard/team", Users], ["Analytics", "/dashboard/analytics", BarChart3]].map(([label, to, Icon]) => (
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

function Skeleton({ rows = 4 }) {
  return <div className="space-y-3">{Array.from({ length: rows }).map((_, i) => <div key={i} className="h-12 rounded-xl bg-secondary animate-pulse" />)}</div>;
}