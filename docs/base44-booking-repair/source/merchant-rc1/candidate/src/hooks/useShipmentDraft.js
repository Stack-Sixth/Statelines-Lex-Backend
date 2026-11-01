import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

const SAVE_DELAY = 700;

// Whether the draft is worth keeping yet. An untouched, empty form is never
// saved, so simply opening the page leaves no blank draft behind.
const hasContent = ({ data, step }) =>
  Number(step) > 0 ||
  !!data?.origin_address?.trim() ||
  !!data?.destination_address?.trim() ||
  Number(data?.weight_lb) > 0;

// Keeps an in-progress shipment in the database instead of only in the page, so
// its details survive a refresh, a trip to Billing, or closing the browser.
//
// Saves in this hook are serialized. Cross-tab draft inserts are not unique;
// draft/quote CAS owns booking, and a draft is never booked from here — booking
// happens server-side, once, in finalizeShipment.
export default function useShipmentDraft({
  data,
  step,
  complianceResult,
  declarationChecked,
  promoApplied,
  promoInput,
  rewardsRedeem,
  enabled,
  onRestore,
}) {
  const [draftId, setDraftId] = useState(null);
  const [ready, setReady] = useState(false);

  const draftIdRef = useRef(null);
  const revisionRef = useRef(0);
  const saveChainRef = useRef(Promise.resolve());
  const generationRef = useRef(0);
  const enabledRef = useRef(!!enabled);
  const settledRef = useRef(false); // set once this draft has been booked
  const timerRef = useRef(null);
  const restoreRef = useRef(onRestore);
  const saveRef = useRef(null);

  const latestRef = useRef({});
  latestRef.current = {
    data,
    step,
    complianceResult,
    declarationChecked,
    promoApplied,
    promoInput,
    rewardsRedeem,
  };

  useEffect(() => {
    restoreRef.current = onRestore;
  });
  useEffect(() => {
    enabledRef.current = !!enabled;
  });

  // Resume: the draft named in the URL when the dashboard sent us here,
  // otherwise this account's own unfinished shipment.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await base44.auth.me();
        if (!active) return;

        const requested = new URLSearchParams(window.location.search).get(
          "draft",
        );
        let draft = null;
        if (requested) {
          const result = await base44.functions.invoke("merchantDraft", {
            action: "load",
            draft_id: requested,
          });
          draft = result.data?.draft || null;
        } else {
          const result = await base44.functions.invoke("merchantDraft", {
            action: "list",
            limit: 1,
          });
          draft = result.data?.items?.[0] || null;
        }
        if (!active || !draft) return;

        draftIdRef.current = draft.id;
        revisionRef.current = Number(draft.edit_revision) || 0;
        setDraftId(draft.id);
        restoreRef.current?.(draft);
      } catch (e) {
        console.error("Couldn't restore the shipment draft:", e.message);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Writes the current shipment state to this account's draft, creating it on
  // the first save. Returns the draft id, or null when there is nothing worth
  // saving yet.
  const saveOnce = useCallback(async () => {
    if (!enabledRef.current || settledRef.current) return null;
    const snapshot = latestRef.current;
    const generation = generationRef.current;
    if (!hasContent(snapshot)) return null;

    const doc = {
      action: "save",
      step: Number(snapshot.step) || 0,
      data: snapshot.data || {},
      options: {
        promo_input: snapshot.promoInput || "",
        rewards_redeem: Number(snapshot.rewardsRedeem) || 0,
      },
      declaration_checked: !!snapshot.declarationChecked,
    };
    const id = draftIdRef.current;
    const result = await base44.functions.invoke("merchantDraft", {
      ...doc,
      ...(id ? { draft_id: id, expected_revision: revisionRef.current } : {}),
    });
    const draft = result.data?.draft;
    if (!draft?.id)
      throw new Error(
        result.data?.code || "Draft save is pending; reload before retrying",
      );
    if (generation !== generationRef.current)
      throw new Error("Draft changed while saving; reload before booking");
    revisionRef.current = Number(draft.edit_revision) || 0;
    draftIdRef.current = draft.id;
    setDraftId(draft.id);
    return draft.id;
  }, []);

  const save = useCallback(() => {
    const operation = saveChainRef.current.then(() => saveOnce());
    // A failed operation poisons the chain until remount/reload: never blindly
    // insert another draft after a create acknowledgement may have been lost.
    saveChainRef.current = operation;
    return operation;
  }, [saveOnce]);
  saveRef.current = save;

  // Auto-save as the merchant types, on a short delay so a burst of edits
  // becomes one write.
  useEffect(() => {
    if (!ready || !enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      save().catch((e) => console.error("Draft save failed:", e.message));
    }, SAVE_DELAY);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    ready,
    enabled,
    data,
    step,
    complianceResult,
    declarationChecked,
    promoApplied,
    promoInput,
    rewardsRedeem,
    save,
  ]);

  // Leaving the page or refreshing: write whatever is still pending.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      saveRef.current?.().catch(() => {});
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // The draft has become a real shipment: stop writing to it.
  const finishBooking = useCallback(() => {
    settledRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    draftIdRef.current = null;
    setDraftId(null);
  }, []);

  // Starting another shipment opens a fresh draft.
  const startNew = useCallback(() => {
    if (!settledRef.current && draftIdRef.current)
      throw new Error(
        "Archive or reconcile the existing draft before starting another booking",
      );
    settledRef.current = false;
    generationRef.current++;
    saveChainRef.current = Promise.resolve();
    revisionRef.current = 0;
    draftIdRef.current = null;
    setDraftId(null);
  }, []);

  return { draftId, ready, saveNow: save, finishBooking, startNew };
}
