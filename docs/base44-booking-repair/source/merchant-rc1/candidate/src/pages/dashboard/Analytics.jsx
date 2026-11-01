import { readShipments } from "@/lib/merchantShipmentReads";
import { useEffect, useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, AreaChart, Area, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { Download, TrendingDown, MapPin } from "lucide-react";

const COLORS = ["#0057FF", "#16C784", "#43a047", "#f59e0b", "#a855f7"];

export default function Analytics() {
  const [shipments, setShipments] = useState(null);
  const [invoices, setInvoices] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, inv] = await Promise.all([
          readShipments(200),
          base44.entities.Invoice.list("-created_date", 50),
        ]);
        setShipments(s); setInvoices(inv);
      } catch { setShipments([]); setInvoices([]); }
    })();
  }, []);

  const monthly = useMemo(() => buildMonthly(invoices || []), [invoices]);
  const destinations = useMemo(() => buildDestinations(shipments || []), [shipments]);
  const deliveryTimes = useMemo(() => buildDeliveryTimes(shipments || []), [shipments]);
  const totalSpend = (invoices || []).reduce((a, i) => a + (i.total || 0), 0);
  const totalSavings = Math.round(totalSpend * 0.41);
  const avgDeliveryDays = deliveryTimes.length ? +(deliveryTimes.reduce((a, d) => a + d.days, 0) / deliveryTimes.length).toFixed(1) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">Spend, savings, and delivery performance across your network.</p>
        </div>
        <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition"><Download size={15} /> Download report</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Mini label="Total spend" value={`$${totalSpend.toLocaleString()}`} />
        <Mini label="Total savings" value={`$${totalSavings.toLocaleString()}`} sub="41% vs standard" />
        <Mini label="Shipments" value={(shipments || []).length || "—"} />
        <Mini label="Avg delivery" value={avgDeliveryDays != null ? `${avgDeliveryDays} days` : "—"} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <ChartCard title="Monthly spend" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={monthly}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0057FF" stopOpacity={0.3} /><stop offset="100%" stopColor="#0057FF" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #eef1f5", boxShadow: "0 8px 24px rgba(7,26,53,0.08)" }} />
              <Area type="monotone" dataKey="spend" stroke="#0057FF" strokeWidth={2.5} fill="url(#g)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Top destinations">
          {destinations.length === 0 ? <div className="text-sm text-muted-foreground py-16 text-center">No destinations yet.</div> : (
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={destinations} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                {destinations.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #eef1f5" }} />
            </PieChart>
          </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <ChartCard title="Delivery time by service (days)">
          {deliveryTimes.length === 0 ? <div className="text-sm text-muted-foreground py-16 text-center">No delivered shipments to measure yet.</div> : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={deliveryTimes}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
              <XAxis dataKey="service" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#7a8499" }} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #eef1f5" }} cursor={{ fill: "#f5f7fa" }} />
              <Bar dataKey="days" fill="#16C784" radius={[6, 6, 0, 0]} barSize={36} />
            </BarChart>
          </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Delivery concentration" subtitle="Shipments by destination metro">
          {destinations.length === 0 ? <div className="text-sm text-muted-foreground py-16 text-center">No destinations yet.</div> : (
            <div className="space-y-3">
              {destinations.map((d) => {
                const max = destinations[0].value || 1;
                return (
                  <div key={d.name} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-28 truncate">{d.name}</span>
                    <div className="flex-1 h-2.5 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full rounded-full gradient-blue" style={{ width: `${(d.value / max) * 100}%` }} />
                    </div>
                    <span className="text-xs font-medium text-foreground w-8 text-right">{d.value}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><MapPin size={13} /> Volume reflects real shipments on the network.</div>
        </ChartCard>
      </div>
    </div>
  );
}

function Mini({ label, value, trend, good, sub }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 card-shadow">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      {(trend || sub) && <p className={`mt-1 text-xs font-medium ${good ? "text-green" : trend ? "text-primary" : "text-muted-foreground"}`}>{trend || sub}</p>}
    </div>
  );
}
function ChartCard({ title, subtitle, className, children }) {
  return (
    <div className={`rounded-2xl border border-border/70 bg-card p-6 card-shadow ${className || ""}`}>
      <div className="mb-5"><h3 className="font-semibold text-foreground">{title}</h3>{subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}</div>
      {children}
    </div>
  );
}
function buildMonthly(invoices) {
  const months = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("en", { month: "short" }), spend: 0 });
  }
  invoices.forEach((i) => {
    if (!i.created_date) return;
    const d = new Date(i.created_date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const slot = months.find((m) => m.key === key);
    if (slot) slot.spend += i.total || 0;
  });
  return months.map(({ label, spend }) => ({ month: label, spend }));
}
function buildDestinations(shipments) {
  const map = {};
  shipments.forEach((s) => { const c = s.destination_city || "Other"; map[c] = (map[c] || 0) + 1; });
  return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 5);
}
function buildDeliveryTimes(shipments) {
  const buckets = {};
  shipments.forEach((s) => {
    if (s.status !== "delivered" || !s.created_date || !s.updated_date) return;
    const days = (new Date(s.updated_date) - new Date(s.created_date)) / (1000 * 60 * 60 * 24);
    if (days < 0 || days > 30) return;
    const svc = s.service_level || "standard";
    if (!buckets[svc]) buckets[svc] = [];
    buckets[svc].push(days);
  });
  const labels = { saver: "Saver", standard: "Standard", priority: "Priority", express: "Express", same_day: "Same-day", overnight: "Overnight" };
  return Object.entries(buckets).map(([svc, arr]) => ({ service: labels[svc] || svc, days: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) }));
}