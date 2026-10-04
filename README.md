# nazaakat.ai: mock Delhivery server (MCP + REST)

A zero-dependency Node server that

1. **mocks Delhivery** using their documented endpoint paths and request/response fields,
2. fails **on purpose and repeatably** (no rider, timeout, garbled reply, not serviceable, and more),
3. hosts the **three simulated capabilities** the real partners do not offer today, and
4. exposes everything as an **MCP server** at `POST /mcp`, so you can register it as a custom connector on AgenticOrg (A2A / MCP page).

Not affiliated with Delhivery, Gnani or Pine Labs. The three simulated capabilities are labelled `"simulated": true` in every response; say so in your write-up.

## Run it locally (2 minutes)

```bash
cd nazaakat-delhivery-mock
npm test                 # 73 checks: every endpoint, every failure mode, the MCP handshake
node server.js           # http://localhost:3000   (PORT=... to change)
curl localhost:3000/health
curl "localhost:3000/c/api/pin-codes/json/?filter_codes=110001"
```

No `npm install` needed.

## Deploy to Vercel (5 minutes)

1. Put this folder in a new GitHub repo (or run `npx vercel` inside it).
2. In Vercel, import the repo. No build command, no framework preset needed.
3. After deploy, open `https://<your-app>.vercel.app/health`. You should see `{"status":"ok",...}`.
4. Your MCP URL is `https://<your-app>.vercel.app/mcp`.

Notes:
- `vercel.json` rewrites every path to the single function and keeps the original path.
- Timeout simulation waits `MOCK_TIMEOUT_MS` (default 8000 ms) and then returns 504. Max function duration is set to 30 s.
- Server memory is not shared between invocations, so the mock is **stateless on purpose**: a shipment's behaviour is encoded in its waybill number and failures are chosen by the destination pincode.

Optional environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MOCK_STAGE_MINUTES` | 1 | Minutes per tracking stage. At 1, a shipment is Delivered about 4 minutes after booking, so "3 days later" fits a recording |
| `MOCK_TIMEOUT_MS` | 8000 | How long a simulated timeout waits before the 504 |
| `MOCK_FLAKY_RATE` | 0 | 0 to 1: random chance that booking fails with "no rider" (leave 0 for repeatable tests) |
| `REQUIRE_AUTH` / `MOCK_API_TOKEN` | off / `nazaakat-demo-token` | If `REQUIRE_AUTH=1`, REST calls need `Authorization: Token <token>`. `/mcp` and `/health` stay open |
| `MOCK_WAREHOUSE` | `NAZAAKAT-WH` | Registered pickup-location name that create-shipment must match (case-sensitive, like the real API) |

## Register it on the platform

1. Open **A2A / MCP** (left sidebar) and add a custom MCP server.
2. URL: `https://<your-app>.vercel.app/mcp`. Auth: none (or the token if you turned `REQUIRE_AUTH` on and the platform lets you send a header).
3. Run the **health check**, then check that **7 tools** are visible:
   `delhivery_check_pincode`, `delhivery_create_shipment`, `delhivery_track_shipment`, `delhivery_cancel_shipment`, `gnani_uncertainty_score`, `pinelabs_checkout_hesitation`, `delhivery_return_risk`.
4. Add the connector to your agent (Step 4 or the agent's Config / Scopes tab) and authorise those tools.
5. If the tools do not appear, send Prakhar: MCP URL, auth configuration, screenshot of the error, the 7 expected tool names, and the tools actually visible.

Quick MCP check from a terminal:

```bash
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Delhivery endpoints mirrored

Paths, methods and request parameters below come from Delhivery's published API documentation (Last-Mile API Integration Document).

| Endpoint | Method | Notes |
|---|---|---|
| `/c/api/pin-codes/json/?filter_codes=<pin>` | GET | Pincode serviceability. Empty `delivery_codes` means not serviceable |
| `/waybill/api/bulk/json/?cl=&token=&count=` | GET | Bulk waybills |
| `/api/cmu/create.json` | POST | Form body `format=json&data=<json>` with `shipments[]` and `pickup_location.name` |
| `/api/v1/packages/json/?waybill=&token=` | GET | Tracking: `ShipmentData[].Shipment.Status` and `Scans[].ScanDetail` |
| `/api/p/edit` | POST | Cancel with `{"waybill": "...", "cancellation": "true"}` |

**Be upfront about one thing:** the documentation pages I could read confirm the paths, methods, content types and request fields, but their response examples did not load. Response bodies here follow the shapes commonly seen in Delhivery integrations (`delivery_codes[].postal_code.*`, `packages[].status/waybill/remarks`, `ShipmentData/Shipment/Status/Scans`). Before you submit, open the Delhivery docs' response tab for each endpoint and compare field names; if one differs, it is a one-line change in `lib/mock.js`. Create-shipment accepts both `add`/`order` and `address`/`order_id`, because the docs and real integrations use both.

## Failure triggers (deterministic)

Type these as the **destination pincode**. They also work as `X-Mock-Scenario: <name>` header, `?mock_scenario=<name>` query param, or the optional `mock_scenario` tool argument.

| Pincode | Scenario | Pincode check | Create shipment | Tracking |
|---|---|---|---|---|
| any real-looking pin (e.g. 110001, 560001, 141001) | none | serviceable | success, waybill returned | progresses Manifested, In Transit, Dispatched, Delivered |
| 999001 | not_serviceable | empty `delivery_codes` | fails: non-serviceable pincode | n/a |
| 999002 | no_rider | serviceable | fails: no rider available for pickup | n/a |
| 999003 | timeout | 504 after delay | 504 after delay | 504 with override |
| 999004 | malformed | truncated JSON | truncated JSON | truncated JSON with override |
| 999005 | prepaid_unavailable | `pre_paid: "N"` | Prepaid fails, COD works up to 50,000 | n/a |
| 999006 | pickup_cancelled | serviceable | success | stuck on "Pending: pickup cancelled by rider" from minute 1 to 4, then recovers |
| 999007 | ndr | serviceable | success | ends on "Pending: delivery attempt failed, consignee unavailable" |
| 999008 | rto | serviceable | success | ends on "Returned" (consignee refused) |
| 999009 | create_timeout | serviceable | 504 after delay | n/a |
| 999010 | create_malformed | serviceable | truncated JSON | n/a |

Other realistic checks built in: pincode must be 6 digits, phone 10 digits, address and order id required, `payment_mode` in Prepaid/COD/Pickup/REPL, COD above 50,000 rejected, wrong warehouse name rejected (`ClientWarehouse matching query does not exist.`), pincodes starting 78/79/18/19 are out-of-delivery-area (no COD), cancelling an already delivered shipment is refused.

## The three simulated capabilities

| Capability | Partner | Endpoint | Data the partner already holds that makes it possible |
|---|---|---|---|
| `uncertainty_score`: how unsure the buyer sounds | Gnani | `POST /gnani/v1/stt/uncertainty` | They process the audio already: pauses, filler words, pitch, speech rate, plus the transcript |
| `checkout_hesitation`: is the buyer wavering at payment | Pine Labs | `POST /pinelabs/v1/checkout/hesitation` | They see the checkout session: link opens, dwell time, retries, method switches, abandonment |
| `return_risk`: chance this order comes back | Delhivery | `POST /delhivery/v1/return-risk` | They hold return and RTO history by pincode and category, plus order value and payment mode |

All three are deterministic heuristics (same input, same output), return their `signals`/`drivers` so the agent can explain itself, and include a `suggested_agent_behaviour` string. The agent should call them through MCP tools of the same names.

## Files

```
api/index.js        Vercel entry
lib/mock.js         all logic: REST, MCP, failure modes, simulated capabilities
server.js           local server
test/run-tests.js   73 checks
vercel.json         rewrites + function config
docs/eval_cases.md  10 eval cases (+6 bonus) with triggers and pass criteria
docs/prompt_v2.md   system prompt v2 with real tool names
docs/laptop_catalogue.csv  sample catalogue (illustrative prices; replace with real ones)
```

`GET /__log` returns the last 50 requests (useful on screen while recording; on Vercel it only covers the warm instance). Each request is also written to the platform logs as one JSON line.
