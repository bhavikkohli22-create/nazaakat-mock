"use strict";
// Run: npm test   (starts the server in-process and checks every endpoint and failure mode)
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { handler, CFG } = require("../lib/mock");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

const WAREHOUSE = CFG.WAREHOUSE;
function shipment(over = {}) {
  return {
    shipments: [{
      name: "Aarav Mehta", add: "12 MG Road", pin: "110001", city: "New Delhi", state: "Delhi", country: "India",
      phone: "9876543210", order: "NZK-1001", payment_mode: "Prepaid", products_desc: "Laptop", total_amount: 54990,
      cod_amount: 0, quantity: 1, weight: 1800, ...over,
    }],
    pickup_location: { name: WAREHOUSE },
  };
}
const form = (data) => `format=json&data=${encodeURIComponent(JSON.stringify(data))}`;

(async () => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); const t = await r.text(); return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() }; };
  const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: "POST", headers, body }); const t = await r.text(); return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() }; };
  const create = (data, headers = {}) => post("/api/cmu/create.json", form(data), { "Content-Type": "application/x-www-form-urlencoded", ...headers });
  const mcp = async (method, params, id = 1, headers = {}) => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const t = await r.text();
    return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() };
  };
  const call = async (name, args) => (await mcp("tools/call", { name, arguments: args })).json.result;
  const wbAt = (code, pin, minutesAgo) => {
    const m = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000) - minutesAgo;
    return `49${code}${pin}${String(m).padStart(7, "0")}`;
  };

  console.log("health and index");
  let r = await get("/health");
  check("health ok", r.status === 200 && r.json.status === "ok");
  r = await get("/");
  check("index lists endpoints", r.json && r.json.delhivery_endpoints.length === 5);

  console.log("pincode serviceability");
  r = await get("/c/api/pin-codes/json/?filter_codes=110001");
  const pc = r.json.delivery_codes[0].postal_code;
  check("serviceable pin returns postal_code fields", pc.pin === 110001 && pc.pre_paid === "Y" && pc.cod === "Y" && pc.is_oda === "N" && pc.max_amount === 50000);
  r = await get("/c/api/pin-codes/json/?filter_codes=999001");
  check("999001 not serviceable -> empty delivery_codes", r.json.delivery_codes.length === 0);
  r = await get("/c/api/pin-codes/json/?filter_codes=999005");
  check("999005 prepaid unavailable", r.json.delivery_codes[0].postal_code.pre_paid === "N" && r.json.delivery_codes[0].postal_code.cod === "Y");
  r = await get("/c/api/pin-codes/json/?filter_codes=781001");
  check("ODA pin has no COD", r.json.delivery_codes[0].postal_code.is_oda === "Y" && r.json.delivery_codes[0].postal_code.cod === "N");
  r = await get("/c/api/pin-codes/json/?filter_codes=12345");
  check("bad pin format -> empty", r.json.delivery_codes.length === 0);
  let t0 = Date.now();
  r = await get("/c/api/pin-codes/json/?filter_codes=999003");
  check("999003 timeout -> 504 after delay", r.status === 504 && Date.now() - t0 >= CFG.TIMEOUT_MS - 50, `status=${r.status} ms=${Date.now() - t0}`);
  r = await get("/c/api/pin-codes/json/?filter_codes=999004");
  check("999004 malformed -> unparsable body", r.status === 200 && r.json === undefined && r.text.length > 5);
  r = await get("/c/api/pin-codes/json/?filter_codes=110001", { "X-Mock-Scenario": "not_serviceable" });
  check("header override forces not_serviceable on a normal pin", r.json.delivery_codes.length === 0);
  r = await get("/c/api/pin-codes/json/?filter_codes=110001&mock_scenario=prepaid_unavailable");
  check("query override works", r.json.delivery_codes[0].postal_code.pre_paid === "N");

  console.log("bulk waybill");
  r = await get("/waybill/api/bulk/json/?cl=NAZAAKAT&token=x&count=3");
  check("bulk waybill returns list", Array.isArray(r.json) && r.json.length === 3);

  console.log("create shipment");
  r = await create(shipment());
  check("create success", r.json.success === true && r.json.packages[0].status === "Success" && /^49\d{15}$/.test(r.json.packages[0].waybill));
  check("create response has Delhivery fields", ["cash_pickups_count", "package_count", "upload_wbn", "replacement_count", "rmk", "pickups_count", "packages", "cash_pickups", "cod_count", "success", "prepaid_count", "cod_amount"].every((k) => k in r.json));
  check("package has refnum + serviceable + payment", r.json.packages[0].refnum === "NZK-1001" && r.json.packages[0].serviceable === true && r.json.packages[0].payment === "Prepaid");
  const goodWb = r.json.packages[0].waybill;
  r = await create(shipment({ pin: "999002" }));
  check("999002 -> no rider available", r.json.success === false && /rider/i.test(r.json.rmk) && r.json.packages[0].status === "Fail");
  r = await create(shipment({ pin: "999001" }));
  check("999001 -> non serviceable", r.json.success === false && /serviceable/i.test(r.json.rmk));
  r = await create(shipment({ pin: "999005" }));
  check("999005 prepaid fails", r.json.success === false && /Prepaid/.test(r.json.rmk));
  r = await create(shipment({ pin: "999005", payment_mode: "COD", cod_amount: 20000 }));
  check("999005 COD succeeds", r.json.success === true && r.json.cod_count === 1);
  r = await create(shipment({ payment_mode: "COD", cod_amount: 75000 }));
  check("COD over limit fails", r.json.success === false && /COD amount/.test(r.json.rmk));
  r = await create(shipment({ phone: "123" }));
  check("bad phone fails", r.json.success === false && /Phone/.test(r.json.rmk));
  r = await create(shipment({ add: "" }));
  check("missing address fails", r.json.success === false && /Address/.test(r.json.rmk));
  const bad = shipment(); bad.pickup_location.name = "wrong-wh";
  r = await create(bad);
  check("unregistered warehouse fails", r.json.success === false && /ClientWarehouse/.test(r.json.rmk));
  t0 = Date.now();
  r = await create(shipment({ pin: "999003" }));
  check("999003 create timeout", r.status === 504 && Date.now() - t0 >= CFG.TIMEOUT_MS - 50);
  r = await create(shipment({ pin: "999004" }));
  check("999004 create malformed", r.json === undefined && r.text.includes("Succ"));
  r = await get("/c/api/pin-codes/json/?filter_codes=999009");
  check("999009 passes the pincode check (fails later at booking)", r.json.delivery_codes.length === 1 && r.json.delivery_codes[0].postal_code.pre_paid === "Y");
  r = await get("/c/api/pin-codes/json/?filter_codes=999010");
  check("999010 passes the pincode check", r.json.delivery_codes.length === 1);
  t0 = Date.now();
  r = await create(shipment({ pin: "999009" }));
  check("999009 booking times out", r.status === 504 && Date.now() - t0 >= CFG.TIMEOUT_MS - 50);
  r = await create(shipment({ pin: "999010" }));
  check("999010 booking returns garbled reply", r.json === undefined && r.text.includes("Succ"));
  r = await create(shipment({ address: "A1", add: undefined }));
  check("accepts `address` and `order_id` aliases", r.json.success === true || /Order id/.test(r.json.rmk));
  r = await post("/api/cmu/create.json", "format=json", { "Content-Type": "application/x-www-form-urlencoded" });
  check("missing data field handled", r.json && r.json.success === false);

  console.log("tracking");
  r = await get(`/api/v1/packages/json/?waybill=${goodWb}&token=x`);
  let s = r.json.ShipmentData[0].Shipment;
  check("fresh shipment is Manifested", s.Status.Status === "Manifested" && s.AWB === goodWb && s.Scans.length === 1);
  check("track has ScanDetail fields", ["ScanDateTime", "ScanType", "Scan", "StatusDateTime", "ScannedLocation", "Instructions", "StatusCode"].every((k) => k in s.Scans[0].ScanDetail));
  const step = CFG.STAGE_MINUTES;
  r = await get(`/api/v1/packages/json/?waybill=${wbAt("00", "110001", 4 * step + 1)}`);
  s = r.json.ShipmentData[0].Shipment;
  check("normal shipment reaches Delivered", s.Status.Status === "Delivered" && s.Status.StatusType === "DL" && s.DeliveryDate !== null && s.Scans.length === 5);
  r = await get(`/api/v1/packages/json/?waybill=${wbAt("06", "999006", 2 * step)}`);
  s = r.json.ShipmentData[0].Shipment;
  check("pickup_cancelled shows rider cancellation", s.Status.Status === "Pending" && /rider/i.test(s.Status.Instructions));
  r = await get(`/api/v1/packages/json/?waybill=${wbAt("07", "999007", 5 * step)}`);
  s = r.json.ShipmentData[0].Shipment;
  check("ndr shows failed delivery attempt", s.Status.Status === "Pending" && /unavailable/i.test(s.Status.Instructions));
  r = await get(`/api/v1/packages/json/?waybill=${wbAt("08", "999008", 6 * step)}`);
  s = r.json.ShipmentData[0].Shipment;
  check("rto shows Returned", s.Status.Status === "Returned" && s.Status.StatusType === "RT");
  r = await get("/api/v1/packages/json/?waybill=123");
  check("unknown waybill -> Error", r.json && typeof r.json.Error === "string");
  t0 = Date.now();
  r = await get(`/api/v1/packages/json/?waybill=${goodWb}&mock_scenario=timeout`);
  check("track timeout override", r.status === 504 && Date.now() - t0 >= CFG.TIMEOUT_MS - 50);
  r = await get(`/api/v1/packages/json/?waybill=${goodWb}&mock_scenario=malformed`);
  check("track malformed override", r.json === undefined);

  console.log("cancel");
  r = await post("/api/p/edit", JSON.stringify({ waybill: goodWb, cancellation: "true" }), { "Content-Type": "application/json" });
  check("cancel in-flight shipment", r.json.status === true && r.json.waybill === goodWb);
  r = await post("/api/p/edit", JSON.stringify({ waybill: wbAt("00", "110001", 10 * step), cancellation: "true" }), { "Content-Type": "application/json" });
  check("cannot cancel delivered", r.json.status === false && /not eligible/.test(r.json.error));
  r = await post("/api/p/edit", JSON.stringify({ waybill: "nope", cancellation: "true" }), { "Content-Type": "application/json" });
  check("cancel unknown waybill", r.json.status === false);

  console.log("simulated capabilities");
  r = await post("/gnani/v1/stt/uncertainty", JSON.stringify({ transcript: "laptop, under 60k, coding aur thoda gaming, pata nahi kaunsa lun, can't decide, confused", language: "hi-en", audio_features: { pause_ratio: 0.4, filler_count: 4 } }), { "Content-Type": "application/json" });
  const high = r.json;
  check("uncertainty high for hesitant hinglish", high.uncertainty_score >= 0.6 && high.level === "high" && high.simulated === true && high.signals.length >= 2, JSON.stringify(high));
  r = await post("/gnani/v1/stt/uncertainty", JSON.stringify({ transcript: "I want the Dell Inspiron 15 under fifty thousand rupees for office work, please order it today." }), { "Content-Type": "application/json" });
  check("uncertainty low for decisive speaker", r.json.uncertainty_score < 0.35 && r.json.level === "low", JSON.stringify(r.json));
  r = await post("/pinelabs/v1/checkout/hesitation", JSON.stringify({ order_id: "NZK-1001", payment_link_opened: false, seconds_since_link_sent: 200 }), { "Content-Type": "application/json" });
  check("hesitation flags unopened link", r.json.hesitation_score >= 0.3 && r.json.recommended_action !== "none", JSON.stringify(r.json));
  r = await post("/pinelabs/v1/checkout/hesitation", JSON.stringify({ order_id: "NZK-1001", payment_link_opened: true, seconds_since_link_sent: 20, seconds_on_payment_page: 15, last_event: "link_opened" }), { "Content-Type": "application/json" });
  check("hesitation low for quick payer", r.json.level === "low");
  r = await post("/pinelabs/v1/checkout/hesitation", JSON.stringify({ order_id: "NZK-1001", payment_link_opened: true, seconds_on_payment_page: 300, payment_retries: 3, method_switches: 3, last_event: "payment_failed" }), { "Content-Type": "application/json" });
  check("hesitation high after retries and failure", r.json.level === "high" && r.json.recommended_action === "offer_retry_or_other_method", JSON.stringify(r.json));
  const lo = (await post("/delhivery/v1/return-risk", JSON.stringify({ pin: "110001", price_inr: 40000, payment_mode: "Prepaid" }), { "Content-Type": "application/json" })).json;
  const hi = (await post("/delhivery/v1/return-risk", JSON.stringify({ pin: "110001", price_inr: 90000, payment_mode: "COD", uncertainty_score: 0.8, hesitation_score: 0.7 }), { "Content-Type": "application/json" })).json;
  check("return risk rises with COD, price and buyer signals", hi.return_probability > lo.return_probability && hi.band !== "low", `${lo.return_probability} vs ${hi.return_probability}`);
  const again = (await post("/delhivery/v1/return-risk", JSON.stringify({ pin: "110001", price_inr: 40000, payment_mode: "Prepaid" }), { "Content-Type": "application/json" })).json;
  check("return risk deterministic", again.return_probability === lo.return_probability);

  console.log("MCP");
  r = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check("initialize returns serverInfo + tools capability", r.json.result.serverInfo.name === "nazaakat-delhivery-mock" && r.json.result.capabilities.tools && r.json.result.protocolVersion === "2025-03-26");
  r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  check("notifications/initialized -> 202", r.status === 202);
  r = await mcp("tools/list");
  const names = r.json.result.tools.map((t) => t.name);
  check("tools/list has 7 tools", names.length === 7 && ["delhivery_check_pincode", "delhivery_create_shipment", "delhivery_track_shipment", "delhivery_cancel_shipment", "gnani_uncertainty_score", "pinelabs_checkout_hesitation", "delhivery_return_risk"].every((n) => names.includes(n)), names.join(","));
  check("every tool has an inputSchema", r.json.result.tools.every((t) => t.inputSchema && t.inputSchema.type === "object" && t.description.length > 20));
  let res = await call("delhivery_check_pincode", { pincode: "560001" });
  check("tool: check_pincode", res.isError === false && JSON.parse(res.content[0].text).delivery_codes.length === 1);
  res = await call("delhivery_create_shipment", { order_id: "NZK-2002", name: "Aarav Mehta", phone: "9876543210", address: "5 Residency Rd", pin: "560001", payment_mode: "Prepaid", total_amount: 58990, products_desc: "Lenovo LOQ 15" });
  const created = JSON.parse(res.content[0].text);
  check("tool: create_shipment success", created.success === true && created.packages[0].waybill);
  res = await call("delhivery_track_shipment", { waybill: created.packages[0].waybill });
  check("tool: track_shipment", JSON.parse(res.content[0].text).ShipmentData[0].Shipment.Status.Status === "Manifested");
  res = await call("delhivery_create_shipment", { order_id: "NZK-2003", name: "A", phone: "9876543210", address: "x", pin: "999002", payment_mode: "Prepaid" });
  check("tool: create_shipment no rider -> readable failure", /rider/i.test(res.content[0].text) && JSON.parse(res.content[0].text).success === false);
  res = await call("delhivery_create_shipment", { order_id: "NZK-2004", name: "A", phone: "9876543210", address: "x", pin: "999004", payment_mode: "Prepaid" });
  let parsed = true; try { JSON.parse(res.content[0].text); } catch { parsed = false; }
  check("tool: malformed reply passes through unparsable", parsed === false);
  t0 = Date.now();
  res = await call("delhivery_check_pincode", { pincode: "999003" });
  check("tool: timeout returns isError after delay", res.isError === true && /504/.test(res.content[0].text) && Date.now() - t0 >= CFG.TIMEOUT_MS - 50);
  res = await call("delhivery_cancel_shipment", { waybill: created.packages[0].waybill });
  check("tool: cancel_shipment", JSON.parse(res.content[0].text).status === true);
  res = await call("gnani_uncertainty_score", { transcript: "pata nahi yaar, confused hoon" });
  check("tool: gnani_uncertainty_score", JSON.parse(res.content[0].text).uncertainty_score > 0.3);
  res = await call("pinelabs_checkout_hesitation", { order_id: "NZK-2002", payment_link_opened: false, seconds_since_link_sent: 300 });
  check("tool: pinelabs_checkout_hesitation", JSON.parse(res.content[0].text).hesitation_score > 0.3);
  res = await call("delhivery_return_risk", { pin: "560001", price_inr: 58990 });
  check("tool: delhivery_return_risk", JSON.parse(res.content[0].text).return_probability > 0);
  r = await mcp("tools/call", { name: "nope", arguments: {} });
  check("unknown tool -> JSON-RPC error", r.json.error && r.json.error.code === -32602);
  r = await mcp("does/not/exist");
  check("unknown method -> -32601", r.json.error && r.json.error.code === -32601);
  r = await mcp("tools/list", undefined, 5, { Accept: "text/event-stream" });
  check("SSE-only Accept gets event-stream framing", r.text.startsWith("event: message") && r.text.includes('"tools"'));
  r = await get("/mcp");
  check("GET /mcp -> 405", r.status === 405);

  console.log("vercel-style routing");
  r = await get("/api/index?__p=c/api/pin-codes/json/&filter_codes=110001");
  check("?__p= path rewrite works", r.json && r.json.delivery_codes && r.json.delivery_codes.length === 1);
  r = await get("/api/index?__p=health");
  check("?__p=health works", r.json && r.json.status === "ok");

  server.close();

  console.log("auth mode");
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: "3917", REQUIRE_AUTH: "1", MOCK_API_TOKEN: "secret" }, stdio: "ignore" });
    setTimeout(async () => {
      try {
        const a = await fetch("http://localhost:3917/c/api/pin-codes/json/?filter_codes=110001");
        const b = await fetch("http://localhost:3917/c/api/pin-codes/json/?filter_codes=110001", { headers: { Authorization: "Token secret" } });
        const c = await fetch("http://localhost:3917/health");
        check("REQUIRE_AUTH=1 rejects missing token with 401", a.status === 401);
        check("REQUIRE_AUTH=1 accepts Token header", b.status === 200);
        check("health and MCP stay open", c.status === 200);
      } catch (e) { check("auth mode reachable", false, String(e)); }
      child.kill();
      resolve();
    }, 800);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failed:", failures.join("; ")); process.exit(1); }
})();
