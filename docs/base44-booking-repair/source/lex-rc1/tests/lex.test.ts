import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as binding from "../candidate/base44/shared/lexAuthorityBinding.ts";
const root = new URL("../candidate/base44/", import.meta.url);
function load(path: string, bindings: any, names = ["handler"]) {
  let s = readFileSync(new URL(path, root), "utf8").replace(
    /^import\s[\s\S]*?;\s*$/gm,
    "",
  );
  s = s.replace(
    "export default async function",
    "const handler = async function",
  );
  const js = stripTypeScriptTypes(s, { mode: "transform" }).replace(
    /^export /gm,
    "",
  );
  return new Function(
    ...Object.keys(bindings),
    js + `\nreturn {${names.join(",")}}`,
  )(...Object.values(bindings));
}
const uuid = "12345678-1234-4234-8234-123456789abc",
  other = "22345678-1234-4234-8234-123456789abc";
const shp = "SHP_" + uuid.replaceAll("-", ""),
  mer = "MER_" + uuid.replaceAll("-", "");
const subject = "6ac144d7ba5eefb2dc02e410",
  local = "6ae34e39a9b77923c0e445ab";
function fixture() {
  const secretsMap: any = {
    LEX_API_URL: "https://backend.unit",
    LEX_SANDBOX_ALPHA_CLIENT_ID: "sbx-alpha-lex-01",
    LEX_SANDBOX_ALPHA_CLIENT_SECRET: "UNIT-ONLY-SECRET",
  };
  const row: any = {
    id: "auth-alpha",
    merchant_id: "SBX-BIZ-ALPHA-001",
    canonical_merchant_id: mer,
    approved_subjects: [subject],
    credential_ref: "LEX_SANDBOX_ALPHA",
    status: "provisioned",
    synthetic: true,
    sandbox: true,
    activation_state: "prepared",
    booking_enabled: false,
    validation_status: "unverified",
  };
  const backend: any = {
    merchant_id: mer,
    client_id: "sbx-alpha-lex-01",
    subject,
    sandbox_isolated: true,
  };
  const reads: any[] = [];
  const credential = {
    clientId: "sbx-alpha-lex-01",
    secret: "UNIT-ONLY-SECRET",
  };
  const globals = {
    ...binding,
    secrets: { get: (n: string) => secretsMap[n] },
    renderBaseUrl: () => secretsMap.LEX_API_URL,
    signedRenderHeadersWith: async () => ({ Authorization: "UNIT-ONLY" }),
    fetch: async (u: any, o: any) => {
      reads.push({ url: String(u), options: o });
      return Response.json(backend);
    },
  };
  const ctx = load("shared/lexMerchantContext.ts", globals, [
    "evaluateMerchantRow",
    "resolveDedicatedCredential",
    "validateMerchantAgainstBackend",
    "recordMerchantValidation",
    "loadMerchantContext",
    "loadMerchantRowForSubject",
    "loadMerchantRowByMerchantId",
    "publicMerchantContext",
    "clientFingerprint",
  ]);
  const sb = load("shared/lexSandbox.ts", globals, [
    "SANDBOX_BUSINESSES",
    "SANDBOX_INTRODUCED_SECRETS",
    "sandboxBookingGrant",
    "sandboxBusinessForMerchantId",
    "sandboxBusinessForCredentialRef",
    "liveEngine",
    "sandboxSwitchOpen",
    "sandboxViolation",
    "redactedBusinessLine",
  ]);
  const base44: any = {
    asServiceRole: {
      entities: {
        MerchantAuthorization: {
          filter: async () => [row],
          update: async (_id: any, b: any) => Object.assign(row, b),
        },
      },
    },
  };
  return {
    secretsMap,
    row,
    backend,
    reads,
    credential,
    globals,
    ctx,
    sb,
    base44,
  };
}
async function verify(f: any) {
  const v = await f.ctx.validateMerchantAgainstBackend(
    f.row,
    subject,
    f.credential,
  );
  await f.ctx.recordMerchantValidation(f.base44, f.row.id, {
    status: v.status,
    subject,
    credential_ref: f.row.credential_ref,
    validation: v,
  });
  return v;
}
test("local SBX registry stays local; backend compares explicit canonical MER", async () => {
  const f = fixture();
  const v = await verify(f);
  assert.equal(v.matched, true);
  assert.equal(v.expected.merchant_id, mer);
  const c = await f.ctx.evaluateMerchantRow(f.row, subject);
  assert.equal(c.merchant_id, mer);
  assert.equal(c.business_id, "SBX-BIZ-ALPHA-001");
  assert.equal(c.validation_matches_caller, true);
  assert.equal(
    f.sb.sandboxBusinessForMerchantId(c.business_id).credential_ref,
    "LEX_SANDBOX_ALPHA",
  );
});
test("SBX alone cannot pass canonical validation and missing backend marker fails", async () => {
  const f = fixture();
  delete f.row.canonical_merchant_id;
  assert.equal((await verify(f)).matched, false);
  f.row.canonical_merchant_id = mer;
  delete f.backend.sandbox_isolated;
  assert.equal((await verify(f)).matched, false);
});
test("validation invalidates canonical, actual client, secret, subject, approvals and target drift", async () => {
  for (const change of [
    "canonical",
    "client",
    "secret",
    "subject",
    "approvals",
    "target",
  ]) {
    const f = fixture();
    await verify(f);
    let caller = subject;
    if (change === "canonical")
      f.row.canonical_merchant_id = "MER_" + other.replaceAll("-", "");
    if (change === "client")
      f.secretsMap.LEX_SANDBOX_ALPHA_CLIENT_ID = "different-client";
    if (change === "secret")
      f.secretsMap.LEX_SANDBOX_ALPHA_CLIENT_SECRET = "ROTATED-UNIT-ONLY";
    if (change === "subject") caller = "different-subject";
    if (change === "approvals")
      f.row.approved_subjects.push("new-approved-subject");
    if (change === "target") f.secretsMap.LEX_API_URL = "https://another.unit";
    assert.equal(
      (await f.ctx.evaluateMerchantRow(f.row, caller))
        .validation_matches_caller,
      false,
      change,
    );
  }
});
test("a reference-only legacy stamp cannot be recorded as verified", async () => {
  const f = fixture();
  await f.ctx.recordMerchantValidation(f.base44, f.row.id, {
    status: "verified",
    subject,
    credential_ref: f.row.credential_ref,
  });
  assert.equal(f.row.validation_status, "failed");
  assert.equal(
    (await f.ctx.evaluateMerchantRow(f.row, subject)).validation_matches_caller,
    false,
  );
});
test("fresh backend revocation/mismatch denies requests despite a matching stored stamp", async () => {
  const f = fixture();
  await verify(f);
  f.backend.subject = "other";
  const c = await f.ctx.loadMerchantContext(f.base44, subject);
  assert.equal(c.request_authorized, false);
  assert.equal(c.validation_matches_caller, false);
});
test("duplicate subject mappings fail closed instead of picking the first", async () => {
  const f = fixture();
  f.base44.asServiceRole.entities.MerchantAuthorization.filter = async () => [
    f.row,
    { ...f.row, id: "other" },
  ];
  assert.equal(await f.ctx.loadMerchantRowForSubject(f.base44, subject), null);
});
test("active names resolve only dedicated credentials; all gates unset keep closed", async () => {
  const f = fixture();
  assert.equal(
    f.ctx.resolveDedicatedCredential("LEX_SANDBOX_ALPHA").clientId,
    "sbx-alpha-lex-01",
  );
  const c = await f.ctx.evaluateMerchantRow(f.row, subject);
  assert.equal(f.sb.sandboxBookingGrant(c, subject).allowed, false);
  delete f.secretsMap.LEX_SANDBOX_ALPHA_CLIENT_SECRET;
  assert.equal(f.ctx.resolveDedicatedCredential("LEX_SANDBOX_ALPHA"), null);
});
function isolationFixture(isolated = true) {
  const row: any = {
    id: uuid,
    tracking_id: "LEX-" + uuid.toUpperCase(),
    sandbox_isolated: isolated,
  };
  let fail = false;
  const localRow: any = { id: local, tracking_id: row.tracking_id };
  const calls: any[] = [];
  const base44: any = {
    asServiceRole: {
      entities: {
        Shipment: {
          get: async (id: string) => {
            if (id !== local) throw new Error("not found");
            return localRow;
          },
          filter: async () => [localRow],
        },
      },
    },
  };
  const globals = {
    ...binding,
    renderBaseUrl: () => "https://backend.unit",
    signedRenderHeaders: async () => ({ Authorization: "UNIT-ONLY" }),
    fetch: async (u: any) => {
      calls.push(String(u));
      if (fail) throw new Error("offline");
      const p = new URL(u).pathname;
      return p === "/v1/shipments"
        ? Response.json({ items: [row], next_cursor: null })
        : Response.json({
            shipment: { ...row, id: p.endsWith(other) ? other : row.id },
          });
    },
  };
  const resolver = load("shared/lexTrustedIsolation.ts", globals, [
    "resolveTrustedIsolation",
    "isolationDenied",
    "operationalLocal",
    "engineUuid",
    "ordinaryEventCopy",
  ]);
  return {
    row,
    localRow,
    calls,
    base44,
    resolver,
    globals,
    setFail: () => {
      fail = true;
    },
  };
}
test("SHP-only, UUID-only, tracking-only and local-only resolve isolated without a payload marker", async () => {
  const f = isolationFixture();
  for (const input of [
    { shipment_id: shp },
    { shipment_id: uuid },
    { tracking_id: f.row.tracking_id },
    { shipment_id: local },
  ])
    assert.equal(
      (await f.resolver.resolveTrustedIsolation(f.base44, input)).kind,
      "isolated",
    );
});
test("unknown, failed lookup, missing persisted marker and contradictory identifiers never permit", async () => {
  const f = isolationFixture();
  assert.equal(
    (await f.resolver.resolveTrustedIsolation(f.base44, {})).kind,
    "unknown",
  );
  assert.equal(
    (
      await f.resolver.resolveTrustedIsolation(f.base44, {
        shipment_id: "deadbeefdeadbeefdeadbeef00",
        tracking_id: f.row.tracking_id,
      })
    ).kind,
    "unknown",
  );
  assert.equal(
    (
      await f.resolver.resolveTrustedIsolation(f.base44, {
        shipment_id: uuid,
        engine_shipment_id: other,
      })
    ).kind,
    "unknown",
  );
  delete f.row.sandbox_isolated;
  assert.equal(
    (await f.resolver.resolveTrustedIsolation(f.base44, { shipment_id: uuid }))
      .kind,
    "unknown",
  );
  f.setFail();
  assert.equal(
    (
      await f.resolver.resolveTrustedIsolation(f.base44, {
        tracking_id: f.row.tracking_id,
      })
    ).kind,
    "unknown",
  );
});
test("ordinary merchant cannot suppress processing by supplying isolation flags or SBX labels", async () => {
  const f = isolationFixture(false);
  const r = await f.resolver.resolveTrustedIsolation(f.base44, {
    shipment_id: uuid,
    sandbox_isolated: true,
    synthetic: true,
    note: "SBX-BIZ-ALPHA-001",
  });
  assert.equal(r.kind, "ordinary");
  assert.equal(f.resolver.isolationDenied(r), null);
});
test("tracking scan cap and repeated cursor are unknown, never clean", async () => {
  const f = isolationFixture();
  const resolver = load(
    "shared/lexTrustedIsolation.ts",
    {
      ...f.globals,
      fetch: async () => Response.json({ items: [f.row], next_cursor: uuid }),
    },
    ["resolveTrustedIsolation"],
  );
  assert.equal(
    (
      await resolver.resolveTrustedIsolation(f.base44, {
        tracking_id: f.row.tracking_id,
      })
    ).kind,
    "unknown",
  );
});
function handler(path: string, f: any, extras: any = {}) {
  return load(path, {
    ...f.globals,
    ...f.ctx,
    ...f.sb,
    ...extras,
    createClientFromRequest: () => f.base44,
  }).handler;
}
test("lexApi keeps legacy UUID routes and adds canonical SHP routes without altering signatures", async () => {
  const f = fixture();
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  const urls: string[] = [];
  const api = handler("functions/lexApi/entry.ts", f, {
    engineUuid: isolationFixture().resolver.engineUuid,
    signedRenderHeaders: async () => ({ Authorization: "UNIT-ONLY" }),
    signedRenderHeadersWith: async () => ({}),
    normalizeShipmentRead: () => null,
    fetch: async (u: any) => {
      urls.push(String(u));
      return Response.json({ ok: true });
    },
  });
  const req = (b: any) =>
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify(b),
    });
  assert.equal(
    (await api(req({ action: "getShipment", id: uuid }))).status,
    200,
  );
  assert.equal(
    (await api(req({ action: "getShipment", id: shp }))).status,
    400,
  );
  assert.equal(
    (await api(req({ action: "getCanonicalShipment", id: shp }))).status,
    200,
  );
  assert.equal(
    (await api(req({ action: "replayDelivery", id: shp, payload: {} }))).status,
    400,
  );
  assert.ok(urls[0].includes("/v1/shipments/" + uuid));
  assert.ok(urls[1].includes("/api/v1/shipments/" + shp));
});
test("lifecycle transition denies a synthetic canonical id before effects", async () => {
  const f = isolationFixture();
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  let effects = 0;
  const fn = load("functions/lexLifecycle/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    nowIso: () => "",
    STAGE_TO_STATUS: { created: "created" },
    requirePerm: async () => null,
    transitionShipment: async () => {
      effects++;
      return { ok: true };
    },
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({
        op: "transition",
        shipment_id: shp,
        to_status: "matched",
      }),
    }),
  );
  assert.equal(r.status, 403);
  assert.equal(effects, 0);
});
test("stored outbox retry/sync resolves each event rather than trusting marker-free sync request", async () => {
  const f = isolationFixture();
  let sends = 0;
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  Object.assign(f.base44.asServiceRole.entities, {
    PlatformConnection: { filter: async () => [{ id: "p" }] },
    PlatformConfig: { filter: async () => [], create: async () => {} },
    EventLog: {
      update:async()=>{},
      filter: async () => [
        {
          id: "e1",
          aggregate: { type: "shipment", id: shp },
          created_date: "2026-01-01",
        },
      ],
    },
    PlatformDelivery: { list: async () => [] },
  });
  const fn = load("functions/lexPublishToPlatforms/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    secrets: { get: () => "UNIT-ONLY" },
    nowIso: () => "",
    appendToOutbox: async () => {
      throw new Error("no append");
    },
    deliver: async () => {
      sends++;
      return { ok: true };
    },
    isSubscribed: () => true,
    recordDelivery: async () => {},
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({ mode: "sync" }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).isolated, 1);
  assert.equal(sends, 0);
});
test("Carrier list excludes synthetic records while preserving bearer key contract", async () => {
  const f = isolationFixture();
  let transitions = 0;
  Object.assign(f.localRow, { assigned_carrier_id: "carrier-local" });
  Object.assign(f.base44.asServiceRole.entities, {
    CommunityCarrier: {
      filter: async () => [
        { id: "carrier-local", status: "online", name: "Unit" },
      ],
    },
    CrossAppPackage: { filter: async () => [] },
  });
  const fn = load("functions/lexCarrierGateway/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    CUSTODY_TO_STATUS: {},
    STAGE_TO_STATUS: {},
    transitionShipment: async () => {
      transitions++;
      return { ok: true };
    },
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      headers: { Authorization: "Bearer UNIT-CARRIER-KEY" },
      body: JSON.stringify({ action: "listMyShipments" }),
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).shipments, []);
  assert.equal(transitions, 0);
});
test("control-plane canonical binding preserves SBX registry and closes validation/booking", async () => {
  const f = fixture();
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  f.base44.asServiceRole.entities.MerchantAuthorization.list = async () => [
    f.row,
  ];
  const fn = handler("functions/lexSandboxBooking/entry.ts", f);
  const next = "MER_" + other.replaceAll("-", "");
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({
        action: "bindCanonical",
        business_id: f.row.merchant_id,
        canonical_merchant_id: next,
      }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(f.row.merchant_id, "SBX-BIZ-ALPHA-001");
  assert.equal(f.row.canonical_merchant_id, next);
  assert.equal(f.row.booking_enabled, false);
  assert.equal(f.row.validation_status, "unverified");
});
test("actual signer keeps HS256 issuer/audience/user subject/role and 120-second lifetime", async () => {
  const f = fixture();
  const signer = load("shared/lexRenderJwt.ts", f.globals, [
    "signedRenderHeadersWith",
  ]);
  const headers = await signer.signedRenderHeadersWith(
    f.credential,
    subject,
    "merchant",
  );
  const token = headers.Authorization.slice(7),
    [head, payload, sig] = token.split(".");
  const json = (p: string) =>
    JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(json(head).alg, "HS256");
  const c = json(payload);
  assert.equal(c.iss, "sbx-alpha-lex-01");
  assert.equal(c.aud, "statelines-lex");
  assert.equal(c.sub, subject);
  assert.equal(c.role, "merchant");
  assert.equal(c.exp - c.iat, 120);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(f.credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  assert.equal(
    await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(head + "." + payload),
    ),
    true,
  );
});
test("ordinary persisted shipment reaches publisher even if caller supplies misleading sandbox flag", async () => {
  const f = isolationFixture(false);
  let appended = 0,
    sent = 0;
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  f.base44.asServiceRole.entities.PlatformConnection = {
    filter: async () => [{ id: "p" }],
  };
  const fn = load("functions/lexPublishToPlatforms/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    secrets: { get: () => "UNIT-ONLY" },
    nowIso: () => "",
    appendToOutbox: async (_b: any, x: any) => {
      assert.equal(x.payload.sandbox_isolated, false);
      appended++;
      return { id: "e", payload: x.payload };
    },
    deliver: async (_c: any, e: any) => {
      assert.equal(e.sandbox_isolated, false);
      sent++;
      return { ok: true };
    },
    isSubscribed: () => true,
    recordDelivery: async () => {},
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({
        mode: "publish",
        event_name: "shipment.created",
        payload: { shipment_id: uuid, sandbox_isolated: true },
      }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(appended, 1);
  assert.equal(sent, 1);
});
test("unknown retry event never sends and never advances checkpoint past it", async () => {
  const f = isolationFixture();
  let sends = 0,
    writes = 0;
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  f.setFail();
  Object.assign(f.base44.asServiceRole.entities, {
    PlatformConnection: { filter: async () => [{ id: "p" }] },
    PlatformConfig: {
      filter: async () => [],
      create: async () => {
        writes++;
      },
    },
    EventLog: {
      update:async()=>{},
      filter: async () => [
        {
          id: "e1",
          aggregate: { type: "shipment", id: uuid },
          created_date: "2026-01-01",
        },
      ],
    },
    PlatformDelivery: { list: async () => [] },
  });
  const fn = load("functions/lexPublishToPlatforms/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    secrets: { get: () => "UNIT-ONLY" },
    nowIso: () => "",
    appendToOutbox: async () => {},
    deliver: async () => {
      sends++;
      return { ok: true };
    },
    isSubscribed: () => true,
    recordDelivery: async () => {},
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({ mode: "sync" }),
    }),
  );
  assert.equal((await r.json()).blocked, 1);
  assert.equal(sends, 0);
  assert.equal(writes, 0);
});
test("synthetic create has no general-gate bypass and adds only backend isolation assertion", async () => {
  const f = fixture();
  await verify(f);
  Object.assign(f.row, {
    activation_state: "active",
    booking_enabled: true,
    isolation_confirmed_at: "2026-10-29",
  });
  f.secretsMap.LEX_MERCHANT_BOOKING_ENABLED = "true"; // adversarial fixture, never real config
  f.base44.auth = { me: async () => ({ id: subject, role: "user" }) };
  let posted = 0,
    wire: any;
  const api = handler("functions/lexApi/entry.ts", f, {
    engineUuid: isolationFixture().resolver.engineUuid,
    signedRenderHeadersWith: async () => ({}),
    signedRenderHeaders: async () => {
      throw new Error("shared fallback forbidden");
    },
    normalizeShipmentRead: () => null,
    fetch: async (_u: any, o: any) => {
      posted++;
      wire = JSON.parse(o.body);
      return Response.json({ ok: true });
    },
  });
  const req = () =>
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({
        action: "createShipment",
        payload: { command_id: uuid },
      }),
    });
  assert.equal((await api(req())).status, 409);
  assert.equal(posted, 0);
  f.secretsMap.LEX_SANDBOX_BOOKING_ENABLED = "true";
  assert.equal((await api(req())).status, 200);
  assert.equal(posted, 1);
  assert.equal(wire.sandbox_isolated, true);
});
test("publisher blocks missing identity before outbox insertion", async () => {
  const f = isolationFixture(false);
  f.base44.auth = { me: async () => ({ id: "admin", role: "admin" }) };
  let writes = 0,
    sends = 0;
  const fn = load("functions/lexPublishToPlatforms/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    secrets: { get: () => "UNIT-ONLY" },
    nowIso: () => "",
    appendToOutbox: async () => {
      writes++;
    },
    deliver: async () => {
      sends++;
    },
    isSubscribed: () => true,
    recordDelivery: async () => {},
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      body: JSON.stringify({
        mode: "publish",
        event_name: "shipment.created",
        payload: { note: "no identity" },
      }),
    }),
  );
  assert.equal(r.status, 409);
  assert.equal(writes, 0);
  assert.equal(sends, 0);
});
test("Carrier synthetic mutation is denied without requiring any caller marker", async () => {
  const f = isolationFixture();
  Object.assign(f.localRow, { assigned_carrier_id: "carrier-local" });
  f.base44.asServiceRole.entities.CommunityCarrier = {
    filter: async () => [{ id: "carrier-local", status: "online" }],
  };
  let effects = 0;
  const fn = load("functions/lexCarrierGateway/entry.ts", {
    ...f.resolver,
    eventIsolation:load('shared/lexEventIsolation.ts',{...f.resolver,localAuthority:async()=>null},['eventIsolation']).eventIsolation,
    createClientFromRequest: () => f.base44,
    CUSTODY_TO_STATUS: { picked_up: "picked_up" },
    STAGE_TO_STATUS: {},
    transitionShipment: async () => {
      effects++;
      return { ok: true };
    },
  }).handler;
  const r = await fn(
    new Request("https://unit.invalid", {
      method: "POST",
      headers: { Authorization: "Bearer UNIT-CARRIER-KEY" },
      body: JSON.stringify({
        action: "acceptAssignment",
        shipment_id: shp,
        command_id: uuid,
        location: "unit",
        signature: "unit",
      }),
    }),
  );
  assert.equal(r.status, 403);
  assert.equal(effects, 0);
});
