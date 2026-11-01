import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { Check, ArrowRight, ArrowLeft, MapPin, Package, DollarSign, ShieldCheck, PackageCheck, Truck, Tag, Gift, Home, Store, Zap } from "lucide-react";
import PaymentMethodPicker from "@/components/shipment/PaymentMethodPicker";
import AddressBookPicker from "@/components/shipment/AddressBookPicker";
import ProfilePicker from "@/components/shipment/ProfilePicker";
import PartnerLocationPicker from "@/components/shipment/PartnerLocationPicker";
import AddressAutocomplete from "@/components/shipment/AddressAutocomplete";
import ShipmentOutputs from "@/components/shipment/ShipmentOutputs";
import TemplateBar from "@/components/shipment/TemplateBar";
import ComplianceSection from "@/components/shipping/ComplianceSection";
import { fetchCurrentMerchant } from "@/lib/currentMerchant";
import { SHIPMENT_STEPS, lastStepIndex } from "@/lib/shipmentSteps";
import useShipmentDraft from "@/hooks/useShipmentDraft";
import PaymentRequiredDialog from "@/components/shipment/PaymentRequiredDialog";
import BookingReadinessNotice from "@/components/shipment/BookingReadinessNotice";

const STEPS = SHIPMENT_STEPS;

// Carrier limit per parcel, from the Statelines Shipping Guidelines packaging checklist.
const MAX_PACKAGE_LB = 70;

// Package requirements gate: returns an explanatory error, or null when the
// package meets all requirements and the flow may proceed to the next step.
const validatePackage = (d) => {
  const w = Number(d.weight_lb) || 0;
  const l = Number(d.length_in) || 0;
  const wd = Number(d.width_in) || 0;
  const h = Number(d.height_in) || 0;
  if (!w || w <= 0) return "Enter the package weight — it must be greater than 0 lb.";
  if (w > MAX_PACKAGE_LB) return `Package weight of ${w} lb exceeds the 70 lb carrier limit per parcel. Split the shipment into lighter parcels or use a freight carrier.`;
  if (!l || !wd || !h) return "Enter all three package dimensions (length, width, and height) — each must be greater than 0 in.";
  if (Number(d.declared_value) < 0) return "Declared value cannot be negative — remove the minus sign or enter 0.";
  return null;
};

// The shipment form's starting state, reused when a saved draft is restored
// and when "Create another" starts over.
const EMPTY_DATA = {
  intake_method: "dropoff",
  origin_address: "", origin_city: "", destination_address: "", destination_city: "",
  weight_lb: 0, length_in: 0, width_in: 0, height_in: 0, declared_value: 0, insurance: false,
  service_level: "standard",
  delivery_method: "home",
  origin_location_id: "", origin_location_name: "",
  destination_location_id: "", destination_location_name: "",
  drop_off_code: "",
  payment_method_id: "", payment_method_label: "",
  compliance: {},
};

const PROMOS = {
  SAVE10: { code: "SAVE10", percent: 0.10, label: "10% off" },
  STAT15: { code: "STAT15", percent: 0.15, label: "15% off" },
  WELCOME5: { code: "WELCOME5", percent: 0.05, label: "5% off" },
};

const POINTS_PER_DOLLAR = 100; // 100 pts = $1

export default function CreateShipment() {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  const [merchant, setMerchant] = useState(null);
  const [promoApplied, setPromoApplied] = useState(null);
  const [promoInput, setPromoInput] = useState("");
  const [rewardsRedeem, setRewardsRedeem] = useState(0);
  const [validating, setValidating] = useState(false);
  const [addrResult, setAddrResult] = useState({});
  const [data, setData] = useState(EMPTY_DATA);
  const [complianceState, setComplianceState] = useState({ canProceed: false, result: null });
  // The billing popup that opens when the account has no card on file.
  const [gate, setGate] = useState({ open: false, publishableKey: "", noAccount: false });
  // Merchant-context pre-flight. Booking stays disabled until the server
  // confirms this account has an authorized domain merchant scope; a failed or
  // unavailable check is treated as "not ready" (fail-closed).
  const [readiness, setReadiness] = useState({ loading: true, ready: false, code: "", message: "", action: "" });

  useEffect(() => {
    fetchCurrentMerchant()
      .then(setMerchant)
      .catch(() => setMerchant(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    base44.functions
      .invoke("merchantBookingReadiness", {})
      .then((res) => {
        if (!cancelled) setReadiness({ loading: false, ...(res.data || {}) });
      })
      .catch(() => {
        if (cancelled) return;
        setReadiness({
          loading: false,
          ready: false,
          code: "unavailable",
          message: "Booking authorization could not be confirmed.",
          action: "Carrier booking stays disabled until the backend confirms this account's merchant scope.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resuming an unfinished shipment: restore every entered detail, and the
  // last compliance decision, so the merchant carries on where they stopped.
  const restoreDraft = useCallback((draft) => {
    if (draft?.data) setData({ ...EMPTY_DATA, ...draft.data });
    setStep(Math.min(Math.max(Number(draft?.step) || 0, 0), STEPS.length - 1));
    const result = null; // Revalidate; a stored browser result never authorizes booking.
    const declared = !!draft?.declaration_checked;
    setComplianceState({ result, declarationChecked: declared, canProceed: result?.status === "permitted" && declared });
    const options = draft?.options || {};
    setPromoApplied(PROMOS[String(options.promo_input || "").trim().toUpperCase()] || null);
    setPromoInput(options.promo_input || "");
    setRewardsRedeem(0); // Recorded balances are retained; redemption requires trusted payment/balance evidence.
  }, []);

  // Auto-save: every entered detail is written to this account's draft as the
  // merchant works, so a refresh, a trip to Billing, or leaving the page never
  // loses the shipment. Booking is turned off once the draft is a real
  // shipment, so a draft is never booked twice.
  const { draftId, saveNow, finishBooking, startNew } = useShipmentDraft({
    data,
    step,
    complianceResult: complianceState.result,
    declarationChecked: complianceState.declarationChecked,
    promoApplied,
    promoInput,
    rewardsRedeem,
    enabled: !done,
    onRestore: restoreDraft,
  });

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));
  // Editing an address field invalidates any earlier confirmation for that step,
  // so a stale "verified" badge can never carry through to finalization.
  const setAddrField = (stepIndex, k, v) => {
    set(k, v);
    setAddrResult((r) => ({ ...r, [stepIndex]: undefined }));
  };
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const cost = computeCost(data);
  const rewardsPoints = merchant?.rewards_points || 0;

  const subtotal = cost + (data.insurance ? 2.5 : 0);
  const promoDiscount = promoApplied ? subtotal * promoApplied.percent : 0;
  const rewardsDiscount = Math.min(rewardsRedeem / POINTS_PER_DOLLAR, Math.max(0, subtotal - promoDiscount));
  const taxable = Math.max(0, subtotal - promoDiscount - rewardsDiscount);
  const tax = taxable * 0.08;
  const total = Math.max(0, taxable + tax);

  // The price that is booked is the server-issued quote, not the local estimate.
  // It is fetched on entry to Review and again at booking time, so the amount
  // shown, the amount accepted and the amount stored on the shipment are the
  // same number.
  const [serverQuote, setServerQuote] = useState(null);

  const requestQuote = useCallback(async () => {
    const res = await base44.functions.invoke("requestLiveRate", {
      weight_lb: data.weight_lb,
      declared_value: data.declared_value,
      service_level: data.service_level,
      insurance: data.insurance === true,
      promo_code: promoApplied?.code || "",
      rewards_points: rewardsRedeem || 0,
      origin_city: data.origin_city,
      destination_city: data.destination_city,
    });
    setServerQuote(res.data);
    return res.data;
  }, [data.weight_lb, data.declared_value, data.service_level, data.insurance, data.origin_city, data.destination_city, promoApplied, rewardsRedeem]);

  useEffect(() => {
    if (step !== lastStepIndex) return;
    let cancelled = false;
    requestQuote().catch(() => { if (!cancelled) setServerQuote(null); });
    return () => { cancelled = true; };
  }, [step, requestQuote]);

  const stepError = () => {
    switch (step) {
      case 0: if (data.intake_method === "pickup" && (!data.origin_address.trim() || !data.origin_city.trim())) return "Enter your pickup street address and city."; return null;
      case 1: if (!data.destination_address.trim() || !data.destination_city.trim()) return "Enter the recipient's street address and city."; return null;
      case 2: return validatePackage(data);
      case 3: return null;
      case 4: if (data.intake_method === "dropoff" && !data.origin_location_id) return "Select an origin Partner Location for drop-off."; return null;
      case 5: if (data.delivery_method === "location_collection" && !data.destination_location_id) return "Select a Partner Location for collection."; return null;
      case 6: {
        const r = complianceState.result;
        if (!r) return "Run the compliance check on your package contents to proceed.";
        if (r.status === "prohibited") return "This item is prohibited (illegal or unsafe to ship) and cannot be shipped via Statelines. Remove it from the shipment.";
        if (r.status === "restricted" || r.status === "unknown") return "This item is restricted and needs Statelines compliance approval before it can ship.";
        if (!complianceState.declarationChecked) return "Accept the shipper declaration to proceed.";
        return null;
      }
      case 7: if (!data.payment_method_id) return "Select a payment method to finalize this shipment."; return null;
      default: return null;
    }
  };
  const err = stepError();

  // Reads the account's saved cards and opens the billing popup when there are
  // none. Returns { ok } so callers can stop the flow.
  const requirePaymentMethod = async () => {
    if (!merchant?.id) {
      setGate({ open: true, publishableKey: "", noAccount: true });
      return { ok: false };
    }
    try {
      const res = await base44.functions.invoke("listPaymentMethods", { merchant_id: merchant.id });
      const methods = res.data?.methods || [];
      if (methods.length === 0) {
        setGate({ open: true, publishableKey: res.data?.publishable_key || "", noAccount: false });
        return { ok: false };
      }
      return { ok: true };
    } catch (e) {
      toast({ title: "Couldn't check your payment methods", description: e.message, variant: "destructive" });
      return { ok: false };
    }
  };

  // A card was just saved: carry on into the confirmation page.
  const onPaymentMethodSaved = () => {
    setGate((g) => ({ ...g, open: false }));
    toast({ title: "Payment method added", description: "Continue to review and confirm this shipment." });
    setStep(STEPS.length - 1);
  };

  const validateAddress = async (address, city, stepIndex, place = null) => {
    const role = stepIndex === 0 ? "origin" : "destination";
    setValidating(true);
    try {
      const payload = { address, city, role };
      if (place) payload.place = place;
      const res = await base44.functions.invoke("validateServiceArea", payload);
      const result = res.data;
      setAddrResult((r) => ({ ...r, [stepIndex]: result }));
      // Service area confirmed: autofill the city / state boxes from the
      // verified address, so the form shows exactly what was checked.
      if (result?.valid && result.geocoded?.city && result.geocoded?.state) {
        set(role === "origin" ? "origin_city" : "destination_city", `${result.geocoded.city}, ${result.geocoded.state}`);
      }
      return result;
    } catch (e) {
      toast({ title: "Address validation failed", description: e.message, variant: "destructive" });
      return null;
    } finally {
      setValidating(false);
    }
  };

  const validateAndNext = async () => {
    if (err) return;
    // The confirmation page is only reached with a saved payment method on the
    // account; otherwise the billing popup opens and the draft stays saved.
    if (step === STEPS.length - 2) {
      const check = await requirePaymentMethod();
      if (!check.ok) return;
    }
    const needsValidation =
      (step === 0 && data.intake_method === "pickup" && data.origin_address.trim()) ||
      (step === 1 && data.destination_address.trim());
    if (!needsValidation) { next(); return; }

    const isOrigin = step === 0;
    const address = isOrigin ? data.origin_address : data.destination_address;
    const city = isOrigin ? data.origin_city : data.destination_city;
    const result = await validateAddress(address, city, step);
    if (!result) return;
    if (!result.valid) {
      toast({
        title: isOrigin ? "Origin address not serviceable" : "Destination address not serviceable",
        description: result.reason === "geocoding_failed"
          ? "We couldn't verify that address. Please check it and try again."
          : "Statelines doesn't operate in this area yet.",
        variant: "destructive",
      });
      return;
    }
    next();
  };

  const applyPromo = () => {
    const code = promoInput.trim().toUpperCase();
    if (PROMOS[code]) { setPromoApplied(PROMOS[code]); toast({ title: "Promo applied", description: PROMOS[code].label }); }
    else { setPromoApplied(null); toast({ title: "Invalid promo code", variant: "destructive" }); }
  };

  const reset = () => {
    setDone(null); setStep(0); setPromoApplied(null); setPromoInput(""); setRewardsRedeem(0); setComplianceState({ canProceed: false, result: null });
    setData(EMPTY_DATA);
    startNew();
  };

  const submit = async () => {
    const pkgErr = validatePackage(data);
    if (pkgErr) {
      toast({ title: "Package requirements not met", description: pkgErr, variant: "destructive" });
      setStep(2);
      return;
    }
    if (!data.origin_address.trim() || !data.destination_address.trim()) {
      toast({ title: "Missing required fields", description: "Origin and destination addresses are required.", variant: "destructive" });
      return;
    }
    if (!complianceState.canProceed) {
      const r = complianceState.result;
      const desc = r?.status === "prohibited"
        ? "The declared contents are prohibited and cannot be shipped via Statelines. Remove the item to continue."
        : "Complete the compliance check and accept the shipper declaration before creating a shipment.";
      toast({ title: r?.status === "prohibited" ? "Shipment blocked — prohibited item" : "Compliance required", description: desc, variant: "destructive" });
      return;
    }
    if (!data.payment_method_id) {
      const check = await requirePaymentMethod();
      if (!check.ok) return;
      toast({ title: "Choose a payment method", description: "Select a saved card to finalize this shipment.", variant: "destructive" });
      return;
    }
    // Booking is gated on an authorized merchant context. The server repeats
    // this check before any domain call, so this is only the user-facing gate.
    if (!readiness.ready) {
      toast({
        title: "Carrier booking disabled",
        description: readiness.message || "This account's merchant scope is not authorized yet.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      // Final gate: both real-world locations must be confirmed via Google
      // geocoding + service-area check before the shipment is finalized.
      // If an address was edited after its last check, re-validate now.
      if (data.intake_method === "pickup" && !addrResult[0]?.valid) {
        const r = await validateAddress(data.origin_address, data.origin_city, 0);
        if (!r?.valid) {
          toast({
            title: "Origin address not confirmed",
            description: r?.reason === "geocoding_failed" ? "We couldn't verify the pickup address. Please check it and try again." : "The pickup address is outside our service area.",
            variant: "destructive",
          });
          setStep(0);
          return;
        }
      }
      if (!addrResult[1]?.valid) {
        const r = await validateAddress(data.destination_address, data.destination_city, 1);
        if (!r?.valid) {
          toast({
            title: "Destination address not confirmed",
            description: r?.reason === "geocoding_failed" ? "We couldn't verify the delivery address. Please check it and try again." : "The delivery address is outside our service area.",
            variant: "destructive",
          });
          setStep(1);
          return;
        }
      }
      // Flush queued edits even when a draft already exists. The server owns
      // command identity, tracking and frozen payload; a browser cannot prime them.
      const bookingId = await saveNow();
      if (!bookingId) throw new Error("Draft save is not confirmed. Reload and reconcile before retrying.");
      // The quote the merchant accepted. If the price moved (expired quote or a
      // new rate version) the server refuses the booking and returns the real
      // amount, which is shown instead of booking a different price silently.
      const accepted = serverQuote || (await requestQuote());
      let booked;
      try {
        booked = await base44.functions.invoke("finalizeShipment", {
          draft_id: bookingId,
          shipment: data,
          quote: { quote_id: accepted.quote_id, accepted_total: accepted.total },
        });
      } catch (e) {
        const payload = e?.response?.data;
        if (["quote_expired", "rate_changed", "quote_mismatch"].includes(payload?.error)) {
          setServerQuote(payload.quote ? { ...accepted, ...payload.quote } : accepted);
          toast({
            title: "Price updated",
            description: `${payload.message} The total is now $${Number(payload.quote?.total ?? accepted.total).toFixed(2)} — review and confirm again.`,
            variant: "destructive",
          });
          return;
        }
        throw e;
      }
      if (booked.data?.pending || !booked.data?.shipment || booked.data?.shipment?.booking_ready !== true) {
        toast({ title: "Finalization pending", description: booked.data?.reason || "Keep this draft. Retry to reconcile the same persisted command; do not create a replacement.", variant: "destructive" });
        return;
      }
      const created = booked.data.shipment;
      const tracking = created.tracking_number;
      // Do not award points, emit notifications or dispatch operational events
      // from a replayable browser callback. These require an idempotent server path.
      const earned = 0;
      finishBooking();
      // Canonical shipment creation on LEX/Render. The result is read back, not
      // assumed: createOrderOnRender returns the real sync state and keeps the
      // persisted command_id for a safe retry.
      let synced = created;
      try {
        const sync = await base44.functions.invoke("createOrderOnRender", { shipment_id: created.id });
        if (sync.data?.ok) {
          synced = { ...created, sync_status: "synced", canonical_shipment_id: sync.data.canonical_shipment_id, tracking_id: sync.data.tracking_id };
        } else if (sync.data?.reason) {
          synced = { ...created, sync_status: "pending", sync_message: sync.data.detail || sync.data.reason };
        }
      } catch (e) {
        synced = { ...created, sync_status: "pending", sync_message: e?.response?.data?.error || e.message };
      }
      const needsSync = synced.sync_status !== "synced";
      setDone({ ...synced, _total: created.cost, _promo: promoApplied, _rewards: rewardsRedeem, _earned: earned, _needsSync: needsSync });
      toast({ title: "Shipment created", description: tracking });
      if (needsSync) {
        toast({
          title: "Carrier sync pending",
          description: "The local record is stored; network booking is not confirmed. Reconcile from Track using the existing command.",
          variant: "destructive",
        });
      }
    } catch (e) {
      if (["compliance_approval_required","declaration_required"].includes(e?.response?.data?.error)) {
        setStep(6);
        toast({title:"Compliance approval required",description:e.response.data.message || "Recheck and accept the contents declaration before booking.",variant:"destructive"});
        return;
      }
      // The server refuses a booking without a saved payment method; open the
      // billing popup rather than leaving the merchant with a bare error.
      if (e?.response?.status === 402 || /payment_method_required/.test(e?.message || "")) {
        await requirePaymentMethod();
        toast({
          title: "Payment method required",
          description: "Add a saved card to book this shipment — your details are saved as a draft.",
          variant: "destructive",
        });
        return;
      }
      if ([409, 202].includes(e?.response?.status)) {
        toast({ title: "Booking pending or blocked", description: e?.response?.data?.message || e?.response?.data?.reason || "Retain this draft and reconcile its persisted command before retrying.", variant: "destructive" });
        return;
      }
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  if (done) return <Confirmation shipment={done} onReset={reset} />;

  return (
    <>
    <div className="max-w-3xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Create a shipment</h1>
          <p className="text-sm text-muted-foreground mt-1">Step {step + 1} of {STEPS.length} · {STEPS[step]}</p>
        </div>
        <TemplateBar data={data} onApply={(patch) => setData((d) => ({ ...d, ...patch }))} merchantId={merchant?.id} />
      </div>

      <div className="flex items-center gap-1.5 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex-1">
            <div className={`h-1.5 rounded-full transition-all ${i <= step ? "gradient-blue" : "bg-secondary"}`} />
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-7 card-shadow">
        {step === 0 && <Sender data={data} set={set} setAddrField={setAddrField} addrResult={addrResult[0]} onValidate={validateAddress} />}
        {step === 1 && <Recipient data={data} set={set} setAddrField={setAddrField} addrResult={addrResult[1]} onValidate={validateAddress} />}
        {step === 2 && <PackageStep data={data} set={set} />}
        {step === 3 && <Service data={data} set={set} cost={cost} promoInput={promoInput} setPromoInput={setPromoInput} applyPromo={applyPromo} promoApplied={promoApplied} rewardsPoints={rewardsPoints} rewardsRedeem={rewardsRedeem} setRewardsRedeem={setRewardsRedeem} maxRewards={Math.floor((subtotal - promoDiscount) * POINTS_PER_DOLLAR)} />}
        {step === 4 && <Origin data={data} set={set} />}
        {step === 5 && <Destination data={data} set={set} />}
        {step === 6 && <ComplianceSection data={data} set={set} merchantId={merchant?.id} onComplianceStateChange={setComplianceState} initialDeclaration={complianceState.declarationChecked} />}
        {step === 7 && <Review data={data} set={set} merchantId={merchant?.id} addrResult={addrResult} cost={cost} subtotal={subtotal} promoDiscount={promoDiscount} rewardsDiscount={rewardsDiscount} tax={tax} total={total} promoApplied={promoApplied} rewardsRedeem={rewardsRedeem} quote={serverQuote} />}

        {err && <p className="mt-4 text-xs font-medium text-red-600">{err}</p>}

        <BookingReadinessNotice readiness={readiness} />

        <div className="mt-8 flex items-center justify-between">
          <button onClick={back} disabled={step === 0} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-border text-sm font-medium disabled:opacity-40 hover:bg-secondary transition"><ArrowLeft size={15} /> Back</button>
          {step < STEPS.length - 1 ? (
            <button onClick={validateAndNext} disabled={!!err || validating} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-50">{validating ? "Validating…" : "Continue"} <ArrowRight size={15} /></button>
          ) : (
            <button onClick={submit} disabled={submitting || readiness.loading || !readiness.ready} title={readiness.ready ? undefined : readiness.message || "Carrier booking is disabled for this account"} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium card-shadow hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed">{submitting ? "Creating…" : "Create shipment"} <Check size={15} /></button>
          )}
        </div>
      </div>
    </div>

    <PaymentRequiredDialog
      open={gate.open}
      onOpenChange={(open) => setGate((g) => ({ ...g, open }))}
      merchantId={merchant?.id || ""}
      publishableKey={gate.publishableKey}
      noAccount={gate.noAccount}
      onSaved={onPaymentMethodSaved}
      onContinueLater={() => {
        setGate((g) => ({ ...g, open: false }));
        toast({ title: "Saved as a draft", description: "Resume this shipment any time from your dashboard overview." });
      }}
    />
    </>
  );
}

function Sender({ data, set, setAddrField, addrResult, onValidate }) {
  const opts = [
    { key: "dropoff", icon: PackageCheck, title: "Drop off at a Partner Location", desc: "Bring your package to a staffed Partner Location and hand it to an authorised attendant." },
    { key: "pickup", icon: Truck, title: "Pickup from my address", desc: "A Community Carrier collects the package from your business and feeds it into the network." },
  ];
  return (
    <div className="space-y-5">
      <SectionTitle icon={Package} label="How should we receive your package?" />
      <div className="grid sm:grid-cols-2 gap-3">
        {opts.map((o) => (
          <button key={o.key} type="button" onClick={() => set("intake_method", o.key)} className={`text-left rounded-xl border p-5 transition ${data.intake_method === o.key ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:bg-secondary"}`}>
            <o.icon size={22} className={data.intake_method === o.key ? "text-primary" : "text-muted-foreground"} />
            <p className="font-medium text-foreground mt-3">{o.title}</p>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{o.desc}</p>
          </button>
        ))}
      </div>
      {data.intake_method === "pickup" && (
        <div className="space-y-4">
          <AddressAutocomplete
            label="Search pickup address"
            placeholder="Start typing your pickup address…"
            onSelect={(place) => {
              if (!place) { set("origin_address", ""); set("origin_city", ""); return; }
              const region = [place.city, place.state].filter(Boolean).join(", ");
              set("origin_address", place.street || "");
              set("origin_city", region);
              onValidate(place.formatted_address, region, 0, place);
            }}
          />
          <div className="grid sm:grid-cols-2 gap-4">
            <Input label="Street address" value={data.origin_address} onChange={(v) => setAddrField(0, "origin_address", v)} placeholder="123 Main St" />
            <Input label="City, State" value={data.origin_city} onChange={(v) => setAddrField(0, "origin_city", v)} placeholder="Winston-Salem, NC" />
          </div>
          {addrResult?.valid && (
            <div className="rounded-xl border border-green/30 bg-green/5 p-3 flex items-center gap-2">
              <MapPin size={14} className="text-green shrink-0" />
              <p className="text-xs text-green truncate">{addrResult.geocoded.formatted_address}</p>
            </div>
          )}
          {addrResult && !addrResult.valid && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 flex items-center gap-2">
              <MapPin size={14} className="text-red-500 shrink-0" />
              <p className="text-xs text-red-600">This address is outside our service area.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Recipient({ data, set, setAddrField, addrResult, onValidate }) {
  return (
    <div className="space-y-5">
      <SectionTitle icon={MapPin} label="Recipient" />
      <AddressBookPicker
        onSelect={(c) => { setAddrField(1, "destination_address", c.address || ""); setAddrField(1, "destination_city", c.city || ""); }}
      />
      <AddressAutocomplete
        label="Search delivery address"
        placeholder="Start typing the delivery address…"
        onSelect={(place) => {
          if (!place) { set("destination_address", ""); set("destination_city", ""); return; }
          const region = [place.city, place.state].filter(Boolean).join(", ");
          set("destination_address", place.street || "");
          set("destination_city", region);
          onValidate(place.formatted_address, region, 1, place);
        }}
      />
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Input label="Street address" value={data.destination_address} onChange={(v) => setAddrField(1, "destination_address", v)} placeholder="456 Oak Ave" />
          <Input label="City, State" value={data.destination_city} onChange={(v) => setAddrField(1, "destination_city", v)} placeholder="Charlotte, NC" />
        </div>
        {addrResult?.valid && (
          <div className="rounded-xl border border-green/30 bg-green/5 p-3 flex items-center gap-2">
            <MapPin size={14} className="text-green shrink-0" />
            <p className="text-xs text-green truncate">{addrResult.geocoded.formatted_address}</p>
          </div>
        )}
        {addrResult && !addrResult.valid && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 flex items-center gap-2">
            <MapPin size={14} className="text-red-500 shrink-0" />
            <p className="text-xs text-red-600">This address is outside our service area.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PackageStep({ data, set }) {
  return (
    <div className="space-y-5">
      <SectionTitle icon={Package} label="Package details" />
      <ProfilePicker
        onApply={(p) => { set("weight_lb", p.weight_lb); set("length_in", p.length_in); set("width_in", p.width_in); set("height_in", p.height_in); set("declared_value", p.declared_value); set("insurance", p.insurance); set("service_level", p.service_level); }}
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Input label="Weight (lb)" type="number" value={data.weight_lb} onChange={(v) => set("weight_lb", Number(v))} />
        <Input label="Length (in)" type="number" value={data.length_in} onChange={(v) => set("length_in", Number(v))} />
        <Input label="Width (in)" type="number" value={data.width_in} onChange={(v) => set("width_in", Number(v))} />
        <Input label="Height (in)" type="number" value={data.height_in} onChange={(v) => set("height_in", Number(v))} />
      </div>
      <Input label="Declared value ($)" type="number" value={data.declared_value} onChange={(v) => set("declared_value", Number(v))} />
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={data.insurance} onChange={(e) => set("insurance", e.target.checked)} className="h-4 w-4 rounded accent-blue-600" />
        <span className="text-sm text-foreground">Add shipment insurance (+$2.50)</span>
      </label>
    </div>
  );
}

function Service({ data, set, cost, promoInput, setPromoInput, applyPromo, promoApplied, rewardsPoints, rewardsRedeem, setRewardsRedeem, maxRewards }) {
  const opts = [
    { key: "saver", label: "Saver", eta: "5–7 days", mult: 0.85 },
    { key: "standard", label: "Standard", eta: "3–5 days", mult: 1 },
    { key: "priority", label: "Priority", eta: "2 days", mult: 1.6 },
    { key: "express", label: "Express", eta: "Next day", mult: 2.0 },
  ];
  const [quote, setQuote] = useState(null);
  const [fetchingQuote, setFetchingQuote] = useState(false);

  const getQuote = async () => {
    setFetchingQuote(true);
    try {
      const res = await base44.functions.invoke("requestLiveRate", {
        weight_lb: data.weight_lb,
        declared_value: data.declared_value,
        service_level: data.service_level,
        insurance: data.insurance === true,
        promo_code: promoApplied?.code || "",
        rewards_points: rewardsRedeem || 0,
        origin_city: data.origin_city,
        destination_city: data.destination_city,
      });
      setQuote(res.data);
    } catch (e) {
      setQuote({ live: false, rate: cost, source: "estimate", note: e.message });
    } finally {
      setFetchingQuote(false);
    }
  };

  return (
    <div className="space-y-5">
      <SectionTitle icon={DollarSign} label="Service level" />
      <div className="grid sm:grid-cols-2 gap-3">
        {opts.map((o) => (
          <button key={o.key} type="button" onClick={() => set("service_level", o.key)} className={`text-left rounded-xl border p-4 transition ${data.service_level === o.key ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:bg-secondary"}`}>
            <div className="flex items-center justify-between"><span className="font-medium text-foreground">{o.label}</span><span className="text-sm font-semibold text-primary">${(cost * o.mult).toFixed(2)}</span></div>
            <p className="text-xs text-muted-foreground mt-1">ETA: {o.eta}</p>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Zap size={15} className="text-primary" /><span className="text-sm font-medium text-foreground">Rate quote</span></div>
          <button type="button" onClick={getQuote} disabled={fetchingQuote} className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-secondary transition disabled:opacity-60">{fetchingQuote ? "Requesting…" : "Get live quote"}</button>
        </div>
        {quote && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{quote.live ? "Statelines rate engine" : "Estimated rate"}</span>
            <span className="font-semibold text-foreground">${Number(quote.rate).toFixed(2)}{quote.eta_days ? ` · ${quote.eta_days}d` : ""}</span>
          </div>
        )}
        {quote?.live && <p className="text-xs text-muted-foreground">Priced by the Statelines rate engine ({quote.rate_version}). It is not a LEX-quoted rate — the logistics engine has no quote route.</p>}
        {quote && !quote.live && quote.note && <p className="text-xs text-muted-foreground">{quote.note}</p>}
      </div>

      <div className="border-t border-border pt-5 space-y-4">
        <SectionTitle icon={Tag} label="Promo code" />
        <div className="flex gap-2">
          <input value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder="Enter code (try SAVE10)" className="flex-1 rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
          <button type="button" onClick={applyPromo} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">Apply</button>
        </div>
        {promoApplied && <p className="text-xs text-green font-medium">✓ {promoApplied.code} applied — {promoApplied.label}</p>}

        <SectionTitle icon={Gift} label="Rewards points" />
        <div className="rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Available balance</span>
            <span className="font-semibold text-foreground">{rewardsPoints.toLocaleString()} pts</span>
          </div>
          <div className="flex items-center gap-3">
            <input type="number" min={0} max={Math.max(0, maxRewards)} value={rewardsRedeem} onChange={(e) => setRewardsRedeem(Math.max(0, Math.min(Number(e.target.value) || 0, maxRewards)))} disabled={true} className="w-32 rounded-xl border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <span className="text-sm text-muted-foreground">pts → ${(Math.min(rewardsRedeem, maxRewards) / 100).toFixed(2)} off</span>
          </div>
          {<p className="text-xs text-muted-foreground">Rewards redemption is paused pending verified payment and balance evidence. Existing recorded balances are retained.</p>}
        </div>
      </div>
    </div>
  );
}

function Origin({ data, set }) {
  if (data.intake_method === "pickup") {
    return (
      <div className="space-y-5">
        <SectionTitle icon={Truck} label="Pickup confirmation" />
        <div className="rounded-xl border border-green/30 bg-green/5 p-4 flex items-center gap-3">
          <Truck size={18} className="text-green" />
          <div>
            <p className="text-sm font-medium text-foreground">{data.origin_address || "Pickup address"}</p>
            <p className="text-xs text-muted-foreground">{data.origin_city || "City"} · A Community Carrier will collect from this address</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <SectionTitle icon={MapPin} label="Origin Partner Location" />
      <p className="text-sm text-muted-foreground -mt-2">Search and select a staffed Partner Location where you'll hand your package to an authorised attendant.</p>
      <PartnerLocationPicker
        selectedId={data.origin_location_id}
        onSelect={(loc) => {
          set("origin_location_id", loc.id);
          set("origin_location_name", loc.name);
          if (!data.origin_address) set("origin_address", loc.address || "");
          if (!data.origin_city) set("origin_city", `${loc.city || ""}${loc.state ? ", " + loc.state : ""}`.trim());
        }}
      />
      {data.origin_location_id && (
        <div className="rounded-xl border border-green/30 bg-green/5 p-4 flex items-center gap-3">
          <MapPin size={18} className="text-green" />
          <div>
            <p className="text-sm font-medium text-foreground">{data.origin_location_name}</p>
            <p className="text-xs text-muted-foreground">Selected drop-off location · attendant will verify your drop-off code</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Destination({ data, set }) {
  const opts = [
    { key: "home", icon: Home, title: "Home delivery", desc: "Delivered to the recipient's street address." },
    { key: "location_collection", icon: Store, title: "Collect at a Partner Location", desc: "Recipient collects from a staffed Partner Location near them." },
  ];
  return (
    <div className="space-y-5">
      <SectionTitle icon={MapPin} label="Delivery method" />
      <div className="grid sm:grid-cols-2 gap-3">
        {opts.map((o) => (
          <button key={o.key} type="button" onClick={() => set("delivery_method", o.key)} className={`text-left rounded-xl border p-5 transition ${data.delivery_method === o.key ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:bg-secondary"}`}>
            <o.icon size={22} className={data.delivery_method === o.key ? "text-primary" : "text-muted-foreground"} />
            <p className="font-medium text-foreground mt-3">{o.title}</p>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{o.desc}</p>
          </button>
        ))}
      </div>
      {data.delivery_method === "location_collection" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Select a Partner Location for the recipient to collect from.</p>
          <PartnerLocationPicker
            selectedId={data.destination_location_id}
            onSelect={(loc) => { set("destination_location_id", loc.id); set("destination_location_name", loc.name); }}
          />
        </div>
      )}
    </div>
  );
}

function Review({ data, set, merchantId, addrResult, cost, subtotal, promoDiscount, rewardsDiscount, tax, total, promoApplied, rewardsRedeem, quote }) {
  // Prefer the server-issued quote: it is the exact amount that will be booked.
  const q = quote?.settlement || null;
  const shown = {
    cost: q ? q.rate : cost,
    subtotal: q ? q.subtotal : subtotal,
    promoDiscount: q ? q.promo_discount : promoDiscount,
    rewardsDiscount: q ? q.rewards_discount : rewardsDiscount,
    tax: q ? q.tax : tax,
    total: q ? q.total : total,
    insurance: q ? q.insurance_fee : (data.insurance ? 2.5 : 0),
  };
  return (
    <div className="space-y-5">
      <SectionTitle icon={ShieldCheck} label="Review & confirm" />
      <div className="rounded-xl bg-secondary p-5 space-y-2 text-sm">
        <Row label="Intake" value={data.intake_method === "pickup" ? "Pickup from address" : "Drop off at Partner Location"} />
        {data.origin_location_name && <Row label="Drop-off at" value={data.origin_location_name} />}
        <Row label="Route" value={`${data.origin_city || "Origin"} → ${data.destination_city || "Destination"}`} />
        {addrResult?.[0]?.valid && <Row label="Pickup address verified" value={addrResult[0].geocoded.formatted_address} accent="text-green" />}
        {addrResult?.[1]?.valid && <Row label="Delivery address verified" value={addrResult[1].geocoded.formatted_address} accent="text-green" />}
        <Row label="Delivery" value={data.delivery_method === "home" ? "Home delivery" : `Collect at ${data.destination_location_name || "Partner Location"}`} />
        <Row label="Weight" value={`${data.weight_lb} lb (${(Math.round((Number(data.weight_lb) || 0) * 0.45359237 * 100) / 100)} kg)`} />
        <Row label="Dimensions" value={`${data.length_in}×${data.width_in}×${data.height_in} in`} />
        <Row label="Service" value={data.service_level} />
        <Row label="Insurance" value={data.insurance ? "Yes" : "No"} />
      </div>

      <PaymentMethodPicker
        merchantId={merchantId}
        value={data.payment_method_id}
        onChange={(id, methodLabel) => { set("payment_method_id", id); set("payment_method_label", methodLabel); }}
      />

      <div className="rounded-xl bg-secondary p-4 space-y-2 text-sm">
        <Row label="Shipment cost" value={`$${shown.cost.toFixed(2)}`} />
        <Row label="Insurance" value={shown.insurance > 0 ? `$${shown.insurance.toFixed(2)}` : "—"} />
        <Row label="Subtotal" value={`$${shown.subtotal.toFixed(2)}`} />
        {(q ? q.promo_code : promoApplied?.code) && <Row label={`Promo (${q ? q.promo_code : promoApplied.code})`} value={`−$${shown.promoDiscount.toFixed(2)}`} accent="text-green" />}
        {(q ? q.rewards_points > 0 : rewardsRedeem > 0) && <Row label={`Rewards (${q ? q.rewards_points : rewardsRedeem} pts)`} value={`−$${shown.rewardsDiscount.toFixed(2)}`} accent="text-green" />}
        <Row label="Tax" value={`$${shown.tax.toFixed(2)}`} />
        <div className="border-t border-border pt-2"><Row label="Total" value={`$${shown.total.toFixed(2)}`} bold /></div>
        <p className="text-xs text-muted-foreground">
          {quote
            ? `Quote ${quote.quote_ref || quote.quote_id} · priced by the Statelines rate engine (${quote.rate_version}) · valid until ${new Date(quote.expires_at).toLocaleTimeString()}`
            : "Preparing your quote…"}
        </p>
      </div>
    </div>
  );
}

function Confirmation({ shipment, onReset }) {
  const [showOutputs, setShowOutputs] = useState(false);
  return (
    <div className="max-w-md mx-auto text-center py-10">
      <div className="h-16 w-16 rounded-full bg-green/10 flex items-center justify-center mx-auto mb-5"><Check size={28} className="text-green" /></div>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Shipment created</h1>
      <p className="text-sm text-muted-foreground mt-2">Your package is now on the Statelines network.</p>
      <div className="mt-6 rounded-2xl border border-border/70 bg-card p-5 card-shadow text-left space-y-2">
        <Row label="Tracking" value={shipment.tracking_number} bold />
        <Row label="Route" value={`${shipment.origin_city} → ${shipment.destination_city}`} />
        {shipment.origin_location_name && <Row label="Drop-off at" value={shipment.origin_location_name} />}
        <Row label="Drop-off Code" value={shipment.drop_off_code || "—"} />
        {shipment._rewards > 0 && <Row label="Points redeemed" value={`${shipment._rewards} pts`} />}
        <Row label="Points earned" value={`+${shipment._earned || 0} pts`} accent="text-green" />
        <Row label="Shipment total" value={`$${Number(shipment.cost ?? shipment._total ?? 0).toFixed(2)}`} bold />
      </div>
      {shipment._needsSync && (
        <p className="mt-3 text-xs text-amber-600 max-w-sm mx-auto">Network sync did not complete yet. The shipment is booked and stored; carrier sync can be retried from Track.</p>
      )}
      <p className="mt-4 text-xs text-muted-foreground max-w-sm mx-auto">Hand your package to an attendant at the selected Partner Location and share your drop-off code. You'll receive confirmation once the attendant accepts the package.</p>
      <div className="mt-6 flex flex-wrap gap-3 justify-center">
        <a href="/dashboard/track" className="px-4 py-2.5 rounded-xl gradient-blue text-white text-sm font-medium">Track shipment</a>
        <button onClick={() => setShowOutputs(true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition"><Package size={15} /> Label & receipt</button>
        <button onClick={onReset} className="px-4 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">Create another</button>
      </div>
      {showOutputs && <ShipmentOutputs shipment={shipment} onClose={() => setShowOutputs(false)} />}
    </div>
  );
}

function SectionTitle({ icon: Icon, label }) {
  return <div className="flex items-center gap-2 mb-1"><Icon size={16} className="text-primary" /><h3 className="font-semibold text-foreground">{label}</h3></div>;
}
function Input({ label, value, onChange, type = "text", ...props }) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground mb-1.5 block">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" {...props} />
    </div>
  );
}
function Row({ label, value, bold, accent }) {
  return <div className="flex items-center justify-between"><span className={bold ? "font-semibold text-foreground" : "text-muted-foreground"}>{label}</span><span className={`${bold ? "font-semibold text-foreground" : "text-foreground"} ${accent || ""}`}>{value}</span></div>;
}
function computeCost(d) {
  const base = 3 + (d.weight_lb || 1) * 0.8 + (d.declared_value || 0) * 0.01;
  const mult = { saver: 0.85, standard: 1, priority: 1.6, express: 2.0, same_day: 2.4, overnight: 2.0 }[d.service_level] || 1;
  return Math.max(2.99, base * mult);
}