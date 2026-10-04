"use strict";
/**
 * nazaakat.ai mock Delhivery server (zero dependencies).
 *
 * REST part mirrors Delhivery's documented endpoint paths:
 *   GET  /c/api/pin-codes/json/?filter_codes=<pin>      pincode serviceability
 *   GET  /waybill/api/bulk/json/?cl=&token=&count=      bulk waybill
 *   POST /api/cmu/create.json   (format=json&data=...)  package order creation
 *   GET  /api/v1/packages/json/?waybill=&token=         order tracking
 *   POST /api/p/edit            {waybill, cancellation} cancel order
 *
 * Simulated capabilities the real partners do not offer today (max 3):
 *   POST /gnani/v1/stt/uncertainty         Gnani   -> uncertainty_score
 *   POST /pinelabs/v1/checkout/hesitation  PineLabs -> checkout_hesitation
 *   POST /delhivery/v1/return-risk         Delhivery -> return_risk
 *
 * MCP (streamable HTTP, JSON-RPC 2.0) is served at POST /mcp and wraps all of the above.
 *
 * Everything is deterministic and stateless so it works on Vercel: failure modes are chosen by
 * magic pincodes (or the X-Mock-Scenario header / mock_scenario param), and a shipment's
 * behaviour is encoded inside its waybill number.
 */

const crypto = require("crypto");

// ---------------------------------------------------------------- config
const CFG = {
  REQUIRE_AUTH: process.env.REQUIRE_AUTH === "1",
  API_TOKEN: process.env.MOCK_API_TOKEN || "nazaakat-demo-token",
  TIMEOUT_MS: Number(process.env.MOCK_TIMEOUT_MS || 8000),
  // minutes per tracking stage. 1 => a shipment is "Delivered" about 4 minutes after booking,
  // so the "3 days later" check-in can be recorded in a couple of minutes.
  STAGE_MINUTES: Number(process.env.MOCK_STAGE_MINUTES || 1),
  FLAKY_RATE: Number(process.env.MOCK_FLAKY_RATE || 0), // 0..1 chance create fails with no_rider
  WAREHOUSE: process.env.MOCK_WAREHOUSE || "NAZAAKAT-WH",
  COD_LIMIT: 50000,
};

const SCENARIOS = [
  "not_serviceable",
  "no_rider",
  "timeout",
  "malformed",
  "prepaid_unavailable",
  "pickup_cancelled",
  "ndr",
  "rto",
  "create_timeout", // pincode check passes, booking times out (after payment)
  "create_malformed", // pincode check passes, booking returns a garbled reply
];

// magic destination pincodes -> scenario
const MAGIC_PINS = {
  "999001": "not_serviceable",
  "999002": "no_rider",
  "999003": "timeout",
  "999004": "malformed",
  "999005": "prepaid_unavailable",
  "999006": "pickup_cancelled",
  "999007": "ndr",
  "999008": "rto",
  "999009": "create_timeout",
  "999010": "create_malformed",
};

// waybill scenario code (digits 3-4)
const WB_CODE = { none: "00", pickup_cancelled: "06", ndr: "07", rto: "08" };
const WB_CODE_REV = { "00": "none", "06": "pickup_cancelled", "07": "ndr", "08": "rto" };

// ---------------------------------------------------------------- pincode data
const KNOWN_PINS = {
  "110001": ["New Delhi", "DL"],
  "122001": ["Gurgaon", "HR"],
  "141001": ["Ludhiana", "PB"],
  "147001": ["Patiala", "PB"],
  "160017": ["Chandigarh", "CH"],
  "201301": ["Noida", "UP"],
  "226001": ["Lucknow", "UP"],
  "302001": ["Jaipur", "RJ"],
  "380001": ["Ahmedabad", "GJ"],
  "395003": ["Surat", "GJ"],
  "400001": ["Mumbai", "MH"],
  "411001": ["Pune", "MH"],
  "452001": ["Indore", "MP"],
  "500001": ["Hyderabad", "TG"],
  "560001": ["Bengaluru", "KA"],
  "600001": ["Chennai", "TN"],
  "641001": ["Coimbatore", "TN"],
  "682001": ["Kochi", "KL"],
  "700001": ["Kolkata", "WB"],
  "751001": ["Bhubaneswar", "OD"],
  "781001": ["Guwahati", "AS"],
  "800001": ["Patna", "BR"],
};
const PREFIX_STATE = [
  [11, "DL"], [12, "HR"], [13, "HR"], [14, "PB"], [15, "PB"], [16, "CH"], [17, "HP"], [18, "JK"], [19, "JK"],
  [20, "UP"], [21, "UP"], [22, "UP"], [23, "UP"], [24, "UP"], [25, "UP"], [26, "UP"], [27, "UP"], [28, "UP"],
  [30, "RJ"], [31, "RJ"], [32, "RJ"], [33, "RJ"], [34, "RJ"], [36, "GJ"], [37, "GJ"], [38, "GJ"], [39, "GJ"],
  [40, "MH"], [41, "MH"], [42, "MH"], [43, "MH"], [44, "MH"], [45, "MP"], [46, "MP"], [47, "MP"], [48, "MP"],
  [49, "CG"], [50, "TG"], [51, "AP"], [52, "AP"], [53, "AP"], [56, "KA"], [57, "KA"], [58, "KA"], [59, "KA"],
  [60, "TN"], [61, "TN"], [62, "TN"], [63, "TN"], [64, "TN"], [67, "KL"], [68, "KL"], [69, "KL"],
  [70, "WB"], [71, "WB"], [72, "WB"], [73, "WB"], [74, "WB"], [75, "OD"], [76, "OD"], [77, "OD"], [78, "AS"],
  [80, "BR"], [81, "BR"], [82, "JH"], [83, "JH"], [84, "BR"], [85, "BR"],
];
const STATE_NAME = {
  DL: "Delhi", HR: "Haryana", PB: "Punjab", CH: "Chandigarh", HP: "Himachal Pradesh", JK: "Jammu & Kashmir",
  UP: "Uttar Pradesh", RJ: "Rajasthan", GJ: "Gujarat", MH: "Maharashtra", MP: "Madhya Pradesh", CG: "Chhattisgarh",
  TG: "Telangana", AP: "Andhra Pradesh", KA: "Karnataka", TN: "Tamil Nadu", KL: "Kerala", WB: "West Bengal",
  OD: "Odisha", AS: "Assam", BR: "Bihar", JH: "Jharkhand",
};
// pincodes in these states are treated as out-of-delivery-area (ODA) for realism
const ODA_PIN_PREFIX = ["78", "79", "18", "19"];

function lookupPin(pin) {
  if (!/^\d{6}$/.test(pin)) return null;
  if (KNOWN_PINS[pin]) {
    const [district, state] = KNOWN_PINS[pin];
    return { district, state_code: state };
  }
  if (pin.startsWith("9") || pin.startsWith("0")) return null; // 9xxxxx / 0xxxxx are not real postal zones
  const p2 = Number(pin.slice(0, 2));
  const hit = PREFIX_STATE.find(([k]) => k === p2);
  if (!hit) return null;
  return { district: `District ${pin.slice(0, 3)}`, state_code: hit[1] };
}

function hash(str) {
  return parseInt(crypto.createHash("sha1").update(String(str)).digest("hex").slice(0, 8), 16);
}

// ---------------------------------------------------------------- scenario resolution
function resolveScenario({ pin, override }) {
  if (override && SCENARIOS.includes(String(override))) return String(override);
  if (pin && MAGIC_PINS[String(pin)]) return MAGIC_PINS[String(pin)];
  return "none";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- core logic
// Each function returns { status, body, raw?, delayMs? } where body is an object (serialised
// as JSON) or raw is a literal string (used for malformed replies).

const MALFORMED_SNIPPETS = {
  serviceability: '{"delivery_codes": [{"postal_code": {"pin": 1410',
  create: '{"success": true, "package_count": 1, "packages": [{"status": "Succ',
  track: '{"ShipmentData": [{"Shipment": {"AWB": "49',
  cancel: '{"status": tr',
  generic: '{"result": [',
};

function failure(kind, scenario, extra = {}) {
  if (scenario === "timeout") {
    return { status: 504, delayMs: CFG.TIMEOUT_MS, body: { error: "Gateway Timeout", detail: "upstream did not respond in time" } };
  }
  if (scenario === "malformed") {
    return { status: 200, raw: MALFORMED_SNIPPETS[kind] || MALFORMED_SNIPPETS.generic };
  }
  return { status: 500, body: { error: "unexpected", ...extra } };
}

function checkPincode(pinRaw, { scenarioOverride } = {}) {
  const pin = String(pinRaw || "").trim();
  if (!/^\d{6}$/.test(pin)) {
    return { status: 200, body: { delivery_codes: [] }, note: "invalid pincode format" };
  }
  const scenario = resolveScenario({ pin, override: scenarioOverride });
  if (scenario === "timeout" || scenario === "malformed") return failure("serviceability", scenario);
  if (scenario === "not_serviceable") return { status: 200, body: { delivery_codes: [] } };
  const loc = lookupPin(pin) || (scenario !== "none" ? { district: "Test District", state_code: "DL" } : null);
  if (!loc) return { status: 200, body: { delivery_codes: [] } };
  const oda = ODA_PIN_PREFIX.some((p) => pin.startsWith(p));
  const prepaidOk = scenario !== "prepaid_unavailable";
  return {
    status: 200,
    body: {
      delivery_codes: [
        {
          postal_code: {
            pin: Number(pin),
            district: loc.district,
            state_code: loc.state_code,
            pre_paid: prepaidOk ? "Y" : "N",
            cash: oda ? "N" : "Y",
            cod: oda ? "N" : "Y",
            pickup: "Y",
            repl: oda ? "N" : "Y",
            is_oda: oda ? "Y" : "N",
            max_amount: oda ? 0 : CFG.COD_LIMIT,
            max_weight: 0,
            remarks: "",
            country_code: "IN",
            sort_code: `${loc.state_code}/${pin.slice(0, 3)}`,
          },
        },
      ],
    },
  };
}

function encodeWaybill(scenarioKey, pin) {
  const minutes = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000);
  const code = WB_CODE[scenarioKey] || "00";
  const p = /^\d{6}$/.test(String(pin)) ? String(pin) : "000000";
  return `49${code}${p}${String(minutes).padStart(7, "0")}`;
}

function decodeWaybill(wb) {
  const s = String(wb || "").trim();
  if (!/^49\d{15}$/.test(s)) return null;
  const code = s.slice(2, 4);
  const pin = s.slice(4, 10);
  const minutes = Number(s.slice(10));
  const createdMs = Date.UTC(2026, 0, 1) + minutes * 60000;
  return { scenario: WB_CODE_REV[code] || "none", pin, createdMs };
}

function bulkWaybill(count) {
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 10000);
  const out = [];
  for (let i = 0; i < Math.min(n, 100); i++) out.push(encodeWaybill("none", "000000") + "");
  return { status: 200, body: out.length === 1 ? out[0] : out };
}

function createShipment(payload, { scenarioOverride } = {}) {
  const shipments = Array.isArray(payload && payload.shipments) ? payload.shipments : [];
  const pickup = (payload && payload.pickup_location) || {};
  if (!shipments.length) {
    return { status: 200, body: { success: false, rmk: "No shipments provided in data", packages: [] } };
  }
  if (pickup.name !== CFG.WAREHOUSE) {
    return {
      status: 200,
      body: {
        success: false,
        rmk: "ClientWarehouse matching query does not exist.",
        error: true,
        package_count: 0,
        packages: [],
      },
    };
  }

  const first = shipments[0];
  const pin = String(first.pin || "").trim();
  let scenario = resolveScenario({ pin, override: scenarioOverride });
  if (scenario === "create_timeout") scenario = "timeout";
  if (scenario === "create_malformed") scenario = "malformed";
  if (scenario === "timeout" || scenario === "malformed") return failure("create", scenario);

  const packages = [];
  let allOk = true;
  let cod = 0;
  let prepaid = 0;
  let codAmount = 0;

  for (const s of shipments) {
    const spin = String(s.pin || "").trim();
    const mode = String(s.payment_mode || "");
    const addr = s.add || s.address || "";
    const order = s.order || s.order_id || "";
    const phone = String(s.phone || "").replace(/\D/g, "").slice(-10);
    const sc = spin === pin ? scenario : resolveScenario({ pin: spin, override: scenarioOverride });
    if (sc === "create_timeout" || sc === "create_malformed") continue; // handled above for the first shipment
    const remarks = [];

    if (!/^\d{6}$/.test(spin)) remarks.push("Invalid pin code");
    if (!addr) remarks.push("Address is mandatory");
    if (phone.length !== 10) remarks.push("Phone number must be 10 digits");
    if (!["Prepaid", "COD", "Pickup", "REPL"].includes(mode)) remarks.push("Invalid payment_mode. Use Prepaid, COD, Pickup or REPL");
    if (!order) remarks.push("Order id is mandatory");

    const loc = /^\d{6}$/.test(spin) ? lookupPin(spin) || (sc !== "none" ? { district: "Test District", state_code: "DL" } : null) : null;
    const serviceable = !!loc && sc !== "not_serviceable";
    if (!remarks.length && !serviceable) remarks.push("Non serviceable pincode: delivery not available for this pin");
    if (!remarks.length && sc === "prepaid_unavailable" && mode === "Prepaid") remarks.push("Prepaid service is not available for this pincode");
    const codAmt = Number(s.cod_amount || 0);
    if (!remarks.length && mode === "COD" && codAmt > CFG.COD_LIMIT) remarks.push(`COD amount exceeds the limit of ${CFG.COD_LIMIT} for this pincode`);
    if (!remarks.length && sc === "no_rider") remarks.push("No rider available for pickup at this time. Please retry later");
    if (!remarks.length && CFG.FLAKY_RATE > 0 && Math.random() < CFG.FLAKY_RATE) remarks.push("No rider available for pickup at this time. Please retry later");

    if (remarks.length) {
      allOk = false;
      packages.push({
        status: "Fail",
        client: CFG.WAREHOUSE,
        sort_code: "",
        remarks,
        waybill: "",
        cod_amount: 0.0,
        payment: mode,
        serviceable,
        refnum: order,
      });
      continue;
    }

    const wb = encodeWaybill(WB_CODE[sc] ? sc : "none", spin);
    if (mode === "COD") { cod += 1; codAmount += codAmt; } else prepaid += 1;
    packages.push({
      status: "Success",
      client: CFG.WAREHOUSE,
      sort_code: `${loc.state_code}/${spin.slice(0, 3)}`,
      remarks: [""],
      waybill: wb,
      cod_amount: mode === "COD" ? codAmt : 0.0,
      payment: mode,
      serviceable: true,
      refnum: order,
    });
  }

  const okCount = packages.filter((p) => p.status === "Success").length;
  return {
    status: 200,
    body: {
      cash_pickups_count: 0.0,
      package_count: okCount,
      upload_wbn: allOk ? `UPL${Date.now().toString().slice(-10)}` : null,
      replacement_count: 0,
      rmk: allOk ? "" : packages.flatMap((p) => p.remarks).filter(Boolean).join("; "),
      pickups_count: 0,
      packages,
      cash_pickups: 0.0,
      cod_count: cod,
      success: allOk,
      prepaid_count: prepaid,
      cod_amount: codAmount,
    },
  };
}

// ---- tracking
const HUB = "Gurgaon_Bilaspur_HB (Haryana)";
function stageTimeline(scenario) {
  // [startMinuteMultiplier, Status, StatusType, StatusCode, Instructions, locationKind]
  const normal = [
    [0, "Manifested", "UD", "X-UCI", "Consignment manifested", "origin"],
    [1, "In Transit", "UD", "UD-PUC", "Shipment picked up", "origin"],
    [2, "In Transit", "UD", "UD-RCF", "Shipment received at destination facility", "dest"],
    [3, "Dispatched", "UD", "EOD-6", "Out for delivery", "dest"],
    [4, "Delivered", "DL", "EOD-38", "Delivered to consignee", "dest"],
  ];
  if (scenario === "pickup_cancelled") {
    return [
      [0, "Manifested", "UD", "X-UCI", "Consignment manifested", "origin"],
      [1, "Pending", "UD", "X-PCR", "Pickup cancelled by rider. Reattempt will be scheduled", "origin"],
      [4, "In Transit", "UD", "UD-PUC", "Shipment picked up on reattempt", "origin"],
      [5, "In Transit", "UD", "UD-RCF", "Shipment received at destination facility", "dest"],
      [6, "Dispatched", "UD", "EOD-6", "Out for delivery", "dest"],
      [7, "Delivered", "DL", "EOD-38", "Delivered to consignee", "dest"],
    ];
  }
  if (scenario === "ndr") {
    return normal.slice(0, 4).concat([[4, "Pending", "UD", "EOD-74", "Delivery attempt failed: consignee unavailable", "dest"]]);
  }
  if (scenario === "rto") {
    return normal.slice(0, 4).concat([
      [4, "Pending", "UD", "EOD-86", "Consignee refused to accept the shipment", "dest"],
      [5, "Returned", "RT", "RT-101", "Shipment returned to origin", "origin"],
    ]);
  }
  return normal;
}

function iso(ms) {
  return new Date(ms).toISOString().replace("Z", "").slice(0, 19);
}

function trackShipment(waybill, { scenarioOverride } = {}) {
  const override = scenarioOverride;
  if (override === "timeout" || override === "malformed") return failure("track", override);
  const info = decodeWaybill(waybill);
  if (!info) {
    return { status: 200, body: { Error: `Waybill ${waybill || ""} not found. Please check the waybill number`.trim() } };
  }
  const loc = lookupPin(info.pin) || { district: "Test District", state_code: "DL" };
  const destination = `${loc.district} (${STATE_NAME[loc.state_code] || loc.state_code})`;
  const timeline = stageTimeline(info.scenario);
  const elapsedMin = (Date.now() - info.createdMs) / 60000;
  const step = CFG.STAGE_MINUTES;
  let idx = 0;
  timeline.forEach((t, i) => { if (elapsedMin >= t[0] * step) idx = i; });
  const reached = timeline.slice(0, idx + 1);
  const locName = (kind) => (kind === "origin" ? HUB : destination);

  const scans = reached.map((t) => ({
    ScanDetail: {
      ScanDateTime: iso(info.createdMs + t[0] * step * 60000),
      ScanType: t[2],
      Scan: t[1],
      StatusDateTime: iso(info.createdMs + t[0] * step * 60000),
      ScannedLocation: locName(t[5]),
      Instructions: t[4],
      StatusCode: t[3],
    },
  }));
  const cur = reached[reached.length - 1];
  const delivered = cur[1] === "Delivered";
  const pickedUp = reached.some((t) => t[3] === "UD-PUC");
  const edd = info.createdMs + 5 * 86400000;

  return {
    status: 200,
    body: {
      ShipmentData: [
        {
          Shipment: {
            AWB: String(waybill),
            ReferenceNo: "",
            OrderType: "Pre-paid",
            Origin: HUB,
            Destination: destination,
            PickUpDate: pickedUp ? iso(info.createdMs + step * 60000) : null,
            ExpectedDeliveryDate: iso(edd),
            DeliveryDate: delivered ? iso(info.createdMs + cur[0] * step * 60000) : null,
            Status: {
              Status: cur[1],
              StatusLocation: locName(cur[5]),
              StatusDateTime: iso(info.createdMs + cur[0] * step * 60000),
              StatusType: cur[2],
              StatusCode: cur[3],
              Instructions: cur[4],
              RecievedBy: delivered ? "Consignee" : "",
            },
            Scans: scans,
          },
        },
      ],
    },
  };
}

function cancelShipment(payload, { scenarioOverride } = {}) {
  if (scenarioOverride === "timeout" || scenarioOverride === "malformed") return failure("cancel", scenarioOverride);
  const wb = payload && payload.waybill;
  const wantsCancel = String(payload && payload.cancellation).toLowerCase() === "true";
  if (!wantsCancel) {
    return { status: 200, body: { status: false, error: "Nothing to update. Send cancellation=true to cancel the order", waybill: wb || null } };
  }
  const info = decodeWaybill(wb);
  if (!info) return { status: 200, body: { status: false, error: `Waybill ${wb || ""} not found`.trim(), waybill: wb || null } };
  const t = trackShipment(wb).body.ShipmentData[0].Shipment.Status;
  if (["Delivered", "Returned"].includes(t.Status)) {
    return { status: 200, body: { status: false, error: `Shipment is not eligible for cancellation (current status: ${t.Status})`, waybill: wb } };
  }
  return { status: 200, body: { status: true, waybill: wb, order_id: "" } };
}

// ---------------------------------------------------------------- simulated capabilities
const HEDGES_EN = ["can't decide", "cant decide", "confused", "not sure", "maybe", "i guess", "unsure", "don't know", "dont know", "hmm", "umm", "um ", "kind of", "sort of", "or something", "whatever", "no idea", "too many"];
const HEDGES_HI = ["pata nahi", "pata nhi", "shayad", "samajh nahi", "samajh nhi", "confuse", "kya lun", "kya loon", "kaunsa", "kaun sa", "dimag kharab", "decide nahi", "decide nhi", "soch raha", "soch rahi", "pakka nahi", "thoda"];
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => Math.round(x * 100) / 100;

function uncertaintyScore(input = {}) {
  const t = String(input.transcript || "").toLowerCase();
  const af = input.audio_features || {};
  const signals = [];
  let score = 0.1;

  const hits = [...HEDGES_EN, ...HEDGES_HI].filter((h) => t.includes(h));
  if (hits.length) {
    const add = Math.min(0.45, 0.15 * hits.length);
    score += add;
    signals.push({ signal: "hedging_words", weight: r2(add), evidence: hits.slice(0, 5) });
  }
  const q = (t.match(/\?/g) || []).length;
  if (q) { const add = Math.min(0.12, 0.06 * q); score += add; signals.push({ signal: "question_marks", weight: r2(add), count: q }); }
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 0 && words < 6) { score += 0.05; signals.push({ signal: "very_short_message", weight: 0.05 }); }
  if (typeof af.pause_ratio === "number") {
    const add = clamp(af.pause_ratio) * 0.25;
    score += add; signals.push({ signal: "pause_ratio", weight: r2(add), value: af.pause_ratio });
  }
  if (typeof af.filler_count === "number") {
    const add = Math.min(0.15, 0.03 * af.filler_count);
    score += add; signals.push({ signal: "filler_count", weight: r2(add), value: af.filler_count });
  }
  if (typeof af.pitch_variance === "number") {
    const add = clamp(af.pitch_variance) * 0.1;
    score += add; signals.push({ signal: "pitch_variance", weight: r2(add), value: af.pitch_variance });
  }
  if (typeof af.speech_rate_wpm === "number" && af.speech_rate_wpm < 100) {
    score += 0.05; signals.push({ signal: "slow_speech_rate", weight: 0.05, value: af.speech_rate_wpm });
  }
  score = r2(clamp(score));
  const level = score >= 0.6 ? "high" : score >= 0.35 ? "medium" : "low";
  return {
    status: 200,
    body: {
      capability: "uncertainty_score",
      partner: "gnani",
      simulated: true,
      language: input.language || "auto",
      uncertainty_score: score,
      level,
      signals,
      suggested_agent_behaviour:
        level === "high" ? "Slow down: ask one question at a time and reassure before recommending." :
        level === "medium" ? "Ask the two questions, keep the recommendation short and decisive." :
        "User sounds sure: be brief and move to the recommendation fast.",
      basis: "Computed from the transcript plus voice features Gnani already extracts (pauses, fillers, pitch, rate). Simulated for this competition.",
    },
  };
}

function checkoutHesitation(input = {}) {
  const secs = Number(input.seconds_on_payment_page || 0);
  const sinceSent = Number(input.seconds_since_link_sent || 0);
  const retries = Number(input.payment_retries || 0);
  const switches = Number(input.method_switches || 0);
  const opened = input.payment_link_opened === true || input.payment_link_opened === "true";
  const last = String(input.last_event || "");
  const signals = [];
  let score = 0.05;
  if (!opened && sinceSent > 120) { score += 0.35; signals.push({ signal: "link_not_opened", weight: 0.35, seconds_since_link_sent: sinceSent }); }
  else if (!opened && sinceSent > 45) { score += 0.15; signals.push({ signal: "link_slow_to_open", weight: 0.15 }); }
  if (secs > 90) { const add = Math.min(0.3, (secs - 90) / 300); score += add; signals.push({ signal: "idle_on_payment_page", weight: r2(add), seconds: secs }); }
  if (retries) { const add = Math.min(0.25, 0.1 * retries); score += add; signals.push({ signal: "payment_retries", weight: r2(add), count: retries }); }
  if (switches) { const add = Math.min(0.15, 0.05 * switches); score += add; signals.push({ signal: "method_switches", weight: r2(add), count: switches }); }
  if (["payment_failed", "abandoned", "back_pressed"].includes(last)) { score += 0.2; signals.push({ signal: `last_event_${last}`, weight: 0.2 }); }
  score = r2(clamp(score));
  const level = score >= 0.6 ? "high" : score >= 0.3 ? "medium" : "low";
  let action = "none";
  if (level === "high") action = last === "payment_failed" ? "offer_retry_or_other_method" : "send_reassurance_and_offer_help";
  else if (level === "medium") action = "gentle_nudge";
  return {
    status: 200,
    body: {
      capability: "checkout_hesitation",
      partner: "pinelabs",
      simulated: true,
      order_id: input.order_id || null,
      hesitation_score: score,
      level,
      recommended_action: action,
      signals,
      basis: "Computed from checkout-session events Pine Labs already holds (link opens, dwell time, retries, method switches). Simulated for this competition.",
    },
  };
}

function returnRisk(input = {}) {
  const pin = String(input.pin || "");
  const loc = lookupPin(pin);
  const price = Number(input.price_inr || 0);
  const mode = String(input.payment_mode || "Prepaid");
  const category = String(input.category || "laptop");
  const unc = clamp(Number(input.uncertainty_score || 0));
  const hes = clamp(Number(input.hesitation_score || 0));
  const pinRto = loc ? 0.02 + (hash(pin) % 1600) / 10000 : 0.2; // 2% - 18% per pincode, stable
  const drivers = [{ driver: "pincode_rto_history", contribution: r2(pinRto * 0.6), detail: `${r2(pinRto * 100)}% historical RTO rate for ${pin || "unknown pin"}` }];
  let p = 0.04 + pinRto * 0.6;
  if (mode === "COD") { p += 0.07; drivers.push({ driver: "cod_order", contribution: 0.07 }); }
  if (price > 60000) { p += 0.04; drivers.push({ driver: "high_value_order", contribution: 0.04, detail: `${price} INR` }); }
  if (category === "laptop") { p += 0.02; drivers.push({ driver: "category_laptop", contribution: 0.02 }); }
  if (unc) { const add = unc * 0.12; p += add; drivers.push({ driver: "buyer_uncertainty", contribution: r2(add) }); }
  if (hes) { const add = hes * 0.1; p += add; drivers.push({ driver: "checkout_hesitation", contribution: r2(add) }); }
  p = r2(clamp(p, 0.01, 0.95));
  const band = p >= 0.22 ? "high" : p >= 0.12 ? "medium" : "low";
  return {
    status: 200,
    body: {
      capability: "return_risk",
      partner: "delhivery",
      simulated: true,
      return_probability: p,
      band,
      drivers,
      suggested_agent_behaviour:
        band === "high" ? "Check in sooner, re-confirm fit and the trade-off, and offer to help with setup before the return window decision." :
        band === "medium" ? "Send the normal follow-up and ask a pointed question about the known trade-off." :
        "Standard follow-up is enough.",
      basis: "Computed from return/RTO history Delhivery already holds by pincode and category, plus buyer signals passed in. Simulated for this competition.",
    },
  };
}

// ---------------------------------------------------------------- MCP
const SCENARIO_PROP = {
  type: "string",
  enum: SCENARIOS,
  description: "Testing only. Force a failure mode for this call. Normally omit; failures are chosen by the destination pincode.",
};

const TOOLS = [
  {
    name: "delhivery_check_pincode",
    description: "Check whether Delhivery delivers to a pincode and whether Prepaid/COD is available (GET /c/api/pin-codes/json/?filter_codes=). An empty delivery_codes list means not serviceable. Call this after the user clearly says yes and before creating a payment.",
    inputSchema: { type: "object", properties: { pincode: { type: "string", description: "6-digit destination pincode" }, mock_scenario: SCENARIO_PROP }, required: ["pincode"] },
  },
  {
    name: "delhivery_create_shipment",
    description: "Book a shipment with Delhivery (POST /api/cmu/create.json). Call only after payment is confirmed. Returns packages[].waybill on success or packages[].remarks explaining a failure (for example no rider available).",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Unique order reference" },
        name: { type: "string", description: "Consignee name" },
        phone: { type: "string", description: "10-digit consignee phone" },
        address: { type: "string", description: "Delivery address" },
        city: { type: "string" },
        state: { type: "string" },
        pin: { type: "string", description: "6-digit destination pincode" },
        payment_mode: { type: "string", enum: ["Prepaid", "COD"] },
        cod_amount: { type: "number", description: "Amount to collect, COD only" },
        total_amount: { type: "number", description: "Order value in INR" },
        products_desc: { type: "string", description: "What is being shipped, e.g. the laptop model" },
        quantity: { type: "number" },
        weight: { type: "number", description: "Weight in grams" },
        pickup_location: { type: "string", description: `Registered warehouse name. Default ${CFG.WAREHOUSE}` },
        mock_scenario: SCENARIO_PROP,
      },
      required: ["order_id", "name", "phone", "address", "pin", "payment_mode"],
    },
  },
  {
    name: "delhivery_track_shipment",
    description: "Get the current status and scan history of a shipment (GET /api/v1/packages/json/?waybill=). Use it for the follow-up check-in.",
    inputSchema: { type: "object", properties: { waybill: { type: "string" }, mock_scenario: SCENARIO_PROP }, required: ["waybill"] },
  },
  {
    name: "delhivery_cancel_shipment",
    description: "Cancel a shipment that has not been delivered yet (POST /api/p/edit with cancellation=true).",
    inputSchema: { type: "object", properties: { waybill: { type: "string" }, mock_scenario: SCENARIO_PROP }, required: ["waybill"] },
  },
  {
    name: "gnani_uncertainty_score",
    description: "SIMULATED Gnani capability. Scores how unsure the buyer sounds (0 to 1) from the transcript and optional voice features. Call it on the first voice note.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Gnani speech-to-text transcript" },
        language: { type: "string", description: "e.g. hi, en, hi-en" },
        audio_features: {
          type: "object",
          properties: {
            pause_ratio: { type: "number", description: "0 to 1, share of the clip that is silence" },
            filler_count: { type: "number" },
            pitch_variance: { type: "number", description: "0 to 1" },
            speech_rate_wpm: { type: "number" },
          },
        },
      },
      required: ["transcript"],
    },
  },
  {
    name: "pinelabs_checkout_hesitation",
    description: "SIMULATED Pine Labs capability. Scores whether the buyer is hesitating at checkout (0 to 1) and suggests what to do. Call it when the payment link has been sent and nothing has happened for a while, or after a failed attempt.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        payment_link_opened: { type: "boolean" },
        seconds_since_link_sent: { type: "number" },
        seconds_on_payment_page: { type: "number" },
        payment_retries: { type: "number" },
        method_switches: { type: "number" },
        last_event: { type: "string", enum: ["link_sent", "link_opened", "payment_failed", "abandoned", "back_pressed", "payment_success"] },
      },
      required: ["order_id"],
    },
  },
  {
    name: "delhivery_return_risk",
    description: "SIMULATED Delhivery capability. Estimates the probability that this order is returned, from pincode return history and buyer signals. Use it to decide how early and how carefully to run the follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        pin: { type: "string" },
        price_inr: { type: "number" },
        payment_mode: { type: "string", enum: ["Prepaid", "COD"] },
        category: { type: "string", description: "default laptop" },
        uncertainty_score: { type: "number", description: "from gnani_uncertainty_score" },
        hesitation_score: { type: "number", description: "from pinelabs_checkout_hesitation" },
      },
      required: ["pin"],
    },
  },
];

function buildCreatePayload(a) {
  return {
    shipments: [
      {
        name: a.name,
        add: a.address,
        pin: String(a.pin),
        city: a.city || "",
        state: a.state || "",
        country: "India",
        phone: String(a.phone),
        order: a.order_id,
        payment_mode: a.payment_mode,
        return_pin: "",
        return_city: "",
        return_phone: "",
        return_add: "",
        return_state: "",
        return_country: "",
        products_desc: a.products_desc || "Laptop",
        hsn_code: "8471",
        cod_amount: a.payment_mode === "COD" ? Number(a.cod_amount || a.total_amount || 0) : 0,
        order_date: null,
        total_amount: Number(a.total_amount || 0),
        seller_add: "",
        seller_name: "nazaakat.ai",
        seller_inv: "",
        quantity: Number(a.quantity || 1),
        waybill: "",
        shipment_width: 0,
        shipment_height: 0,
        weight: Number(a.weight || 2000),
        shipping_mode: "Surface",
        address_type: "home",
      },
    ],
    pickup_location: { name: a.pickup_location || CFG.WAREHOUSE },
  };
}

async function callTool(name, args = {}) {
  const ov = args.mock_scenario;
  switch (name) {
    case "delhivery_check_pincode": return checkPincode(args.pincode, { scenarioOverride: ov });
    case "delhivery_create_shipment": return createShipment(buildCreatePayload(args), { scenarioOverride: ov });
    case "delhivery_track_shipment": return trackShipment(args.waybill, { scenarioOverride: ov });
    case "delhivery_cancel_shipment": return cancelShipment({ waybill: args.waybill, cancellation: "true" }, { scenarioOverride: ov });
    case "gnani_uncertainty_score": return uncertaintyScore(args);
    case "pinelabs_checkout_hesitation": return checkoutHesitation(args);
    case "delhivery_return_risk": return returnRisk(args);
    default: return null;
  }
}

async function handleMcp(msg) {
  // returns a JSON-RPC response object, or null for notifications
  const id = msg.id;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const isNotification = id === undefined || id === null;
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params && msg.params.protocolVersion;
      const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
      return ok({
        protocolVersion: supported.includes(requested) ? requested : supported[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nazaakat-delhivery-mock", version: "1.0.0" },
        instructions: "Mock Delhivery plus three simulated capabilities for the nazaakat.ai case competition.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (!TOOLS.find((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      const res = await callTool(name, args);
      if (res.delayMs) await sleep(res.delayMs);
      let text;
      let isError = false;
      if (res.raw !== undefined) text = res.raw; // malformed reply, passed through untouched
      else {
        text = JSON.stringify(res.body, null, 2);
        isError = res.status >= 400;
        if (isError) text = `HTTP ${res.status}\n${text}`;
      }
      return ok({ content: [{ type: "text", text }], isError });
    }
    default:
      return isNotification ? null : err(-32601, `Method not found: ${msg.method}`);
  }
}

// ---------------------------------------------------------------- HTTP layer
const RECENT = [];
function logReq(entry) {
  RECENT.push(entry);
  if (RECENT.length > 100) RECENT.shift();
  console.log(JSON.stringify(entry));
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) return resolve(req.body.toString("utf8"));
      return resolve(typeof req.body === "string" ? req.body : req.body);
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function send(res, status, bodyObj, raw) {
  const payload = raw !== undefined ? raw : JSON.stringify(bodyObj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(payload);
}

function parseData(bodyText, contentType) {
  // Delhivery create.json: application/x-www-form-urlencoded with format=json&data={...}
  if (bodyText && typeof bodyText === "object") {
    if (bodyText.data) {
      try { return typeof bodyText.data === "string" ? JSON.parse(bodyText.data) : bodyText.data; } catch { return null; }
    }
    return bodyText;
  }
  const text = String(bodyText || "").trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.parse(text); } catch { return null; }
  }
  const params = new URLSearchParams(text);
  const data = params.get("data");
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

function authOk(req) {
  if (!CFG.REQUIRE_AUTH) return true;
  const h = String(req.headers["authorization"] || "");
  return h === `Token ${CFG.API_TOKEN}` || h === `Bearer ${CFG.API_TOKEN}`;
}

function indexDoc(host) {
  return {
    name: "nazaakat.ai mock Delhivery server",
    note: "Mock of Delhivery's documented endpoints plus 3 simulated capabilities. Not affiliated with Delhivery, Gnani or Pine Labs.",
    mcp: `POST ${host}/mcp`,
    health: `GET ${host}/health`,
    delhivery_endpoints: [
      "GET  /c/api/pin-codes/json/?filter_codes=<pin>",
      "GET  /waybill/api/bulk/json/?cl=<client>&token=<token>&count=<n>",
      "POST /api/cmu/create.json  (form body: format=json&data=<json>)",
      "GET  /api/v1/packages/json/?waybill=<awb>&token=<token>",
      "POST /api/p/edit  {waybill, cancellation: 'true'}",
    ],
    simulated_capabilities: [
      "POST /gnani/v1/stt/uncertainty",
      "POST /pinelabs/v1/checkout/hesitation",
      "POST /delhivery/v1/return-risk",
    ],
    failure_triggers: {
      by_destination_pincode: MAGIC_PINS,
      by_header: "X-Mock-Scenario: " + SCENARIOS.join(" | "),
      by_query_or_tool_arg: "mock_scenario=<scenario>",
    },
    config: { stage_minutes: CFG.STAGE_MINUTES, timeout_ms: CFG.TIMEOUT_MS, warehouse: CFG.WAREHOUSE, require_auth: CFG.REQUIRE_AUTH, flaky_rate: CFG.FLAKY_RATE },
  };
}

async function handler(req, res) {
  const started = Date.now();
  const urlObj = new URL(req.url, "http://localhost");
  // On Vercel the rewrite passes the original path as ?__p=
  let path = urlObj.searchParams.get("__p");
  if (path !== null) { path = "/" + path.replace(/^\/+/, ""); urlObj.searchParams.delete("__p"); }
  else path = urlObj.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const q = urlObj.searchParams;
  const method = req.method || "GET";
  const headerScenario = req.headers["x-mock-scenario"];
  const override = headerScenario || q.get("mock_scenario") || undefined;
  const host = `https://${req.headers.host || "localhost"}`;

  const finish = (status, extra = {}) => logReq({ t: new Date().toISOString(), method, path, query: Object.fromEntries(q), status, ms: Date.now() - started, ...extra });

  try {
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.end();
      return;
    }

    if (path === "/" ) { send(res, 200, indexDoc(host)); return finish(200); }
    if (path === "/health" || path === "/healthz") { send(res, 200, { status: "ok", service: "nazaakat-delhivery-mock", time: new Date().toISOString() }); return finish(200); }
    if (path === "/__log") { send(res, 200, { recent: RECENT.slice(-50) }); return; }

    // ---------------- MCP
    if (path === "/mcp" || path === "/mcp/") {
      if (method === "GET" || method === "DELETE") {
        send(res, 405, { error: "This MCP server uses POST (streamable HTTP, stateless)" });
        return finish(405);
      }
      const bodyRaw = await readBody(req);
      let msg;
      try { msg = typeof bodyRaw === "object" ? bodyRaw : JSON.parse(bodyRaw); } catch { send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return finish(400); }
      const wantsSse = String(req.headers["accept"] || "").includes("text/event-stream") && !String(req.headers["accept"] || "").includes("application/json");
      const batch = Array.isArray(msg);
      const msgs = batch ? msg : [msg];
      const responses = [];
      for (const m of msgs) {
        const r = await handleMcp(m);
        if (r) responses.push(r);
      }
      finish(200, { mcp: msgs.map((m) => m.method + (m.params && m.params.name ? `:${m.params.name}` : "")) });
      if (!responses.length) { res.statusCode = 202; res.end(); return; }
      const out = batch ? responses : responses[0];
      if (wantsSse) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      } else send(res, 200, out);
      return;
    }

    // ---------------- auth for REST
    if (!authOk(req)) { send(res, 401, { detail: "Authentication credentials were not provided or invalid." }); return finish(401); }

    // ---------------- Delhivery REST
    if (path === "/c/api/pin-codes/json" && method === "GET") {
      const r = checkPincode(q.get("filter_codes"), { scenarioOverride: override });
      if (r.delayMs) await sleep(r.delayMs);
      send(res, r.status, r.body, r.raw); return finish(r.status);
    }
    if (path === "/waybill/api/bulk/json" && method === "GET") {
      const r = bulkWaybill(q.get("count"));
      send(res, r.status, r.body); return finish(r.status);
    }
    if (path === "/api/cmu/create.json" && method === "POST") {
      const body = await readBody(req);
      const data = parseData(body, req.headers["content-type"]);
      if (!data) {
        send(res, 200, { success: false, rmk: "Invalid request: send form field data=<json> with format=json", packages: [] }); return finish(200);
      }
      const r = createShipment(data, { scenarioOverride: override });
      if (r.delayMs) await sleep(r.delayMs);
      send(res, r.status, r.body, r.raw); return finish(r.status, { scenario: resolveScenario({ pin: data.shipments && data.shipments[0] && data.shipments[0].pin, override }) });
    }
    if (path === "/api/v1/packages/json" && method === "GET") {
      const r = trackShipment(q.get("waybill"), { scenarioOverride: override });
      if (r.delayMs) await sleep(r.delayMs);
      send(res, r.status, r.body, r.raw); return finish(r.status);
    }
    if (path === "/api/p/edit" && method === "POST") {
      const body = await readBody(req);
      const data = parseData(body, req.headers["content-type"]) || {};
      const r = cancelShipment(data, { scenarioOverride: override });
      if (r.delayMs) await sleep(r.delayMs);
      send(res, r.status, r.body, r.raw); return finish(r.status);
    }

    // ---------------- simulated capabilities
    if (method === "POST" && ["/gnani/v1/stt/uncertainty", "/pinelabs/v1/checkout/hesitation", "/delhivery/v1/return-risk"].includes(path)) {
      const body = await readBody(req);
      const data = parseData(body, req.headers["content-type"]) || {};
      const fn = path.startsWith("/gnani") ? uncertaintyScore : path.startsWith("/pinelabs") ? checkoutHesitation : returnRisk;
      const r = fn(data);
      send(res, r.status, r.body); return finish(r.status);
    }

    send(res, 404, { detail: "Not found", path });
    finish(404);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "internal_error", message: String(e && e.message) });
    finish(500, { error: String(e && e.message) });
  }
}

module.exports = {
  handler, handleMcp, TOOLS, callTool, CFG, SCENARIOS, MAGIC_PINS,
  checkPincode, createShipment, trackShipment, cancelShipment, uncertaintyScore, checkoutHesitation, returnRisk,
  decodeWaybill, encodeWaybill, buildCreatePayload,
};
