// v2.22.0 — security fixes #3 (coupon oracle throttle), #7 (countryId sanitize),
// #8 (constant-time secret compares + diag key header), rebuy button redesign.
import { createHash, createHmac } from "node:crypto";
const store = new Map();
const put = (k, v) => store.set(k, JSON.stringify(v));
const kv = {
  async get(k, opts) { const v = store.get(k); if (v === undefined) return null; return (opts === "json" || (opts && opts.type === "json")) ? JSON.parse(v) : v; },
  async put(k, v, opts) { if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV ttl"); store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" }; },
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    if (u.includes("getWebhookInfo")) return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (u.includes("getMe")) return json({ ok: true, result: { username: "testbot" } });
    if (u.includes("getChatMember")) return json({ ok: true, result: { status: "member" } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("core.smsfullbot.com")) {
    if (u.includes("/balance")) return json({ spendable: 500, balance: 500, currency: "BRL" });
    if (u.includes("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    if (u.includes("/services")) return json([{ id: 10, code: "tg", name: "Telegram", price: 25, available: 5 }]);
    return json({});
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("user:777", { id: "777", balance: 100, state: null, createdAt: Date.now(), lang: "fa" });
put("coupon:SAVE10", { code: "SAVE10", type: "percent", value: 10, maxUses: 0, usedCount: 0, minPurchase: 0, expiresAt: 0, active: true, createdAt: Date.now() });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { (ctx.jobs ||= []).push(Promise.resolve(p).catch(() => {})); }, jobs: [] };
const worker = (await import("../src/index.js")).default;
const call = (req) => worker.fetch(req, env, ctx);
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// --- web login for user 777 ---
const payload = { id: 777, first_name: "T", auth_date: Math.floor(Date.now() / 1000) };
const secret = createHash("sha256").update("T").digest();
const dcs = Object.keys(payload).sort().map((k) => `${k}=${payload[k]}`).join("\n");
payload.hash = createHmac("sha256", secret).update(dcs).digest("hex");
const authRes = await call(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
const { token } = await authRes.json();
const H = { authorization: "Bearer " + token, "content-type": "application/json" };

// --- #3: coupon check works, then throttles ---
let last = null, okCount = 0;
for (let i = 0; i < 11; i++) {
  last = await call(new Request("https://w.test/api/coupon/check", { method: "POST", headers: H, body: JSON.stringify({ code: "SAVE10", price: 6 }) }));
  if (last.status === 200) okCount++;
}
check("coupon check answers before the limit", okCount === 10);
check("11th coupon check is throttled (429)", last.status === 429);

// --- #7: services countryId sanitize ---
const bad = await call(new Request("https://w.test/api/services?countryId=abc", { headers: H }));
check("services with non-numeric countryId -> 400", bad.status === 400);
const good = await call(new Request("https://w.test/api/services?countryId=1", { headers: H }));
const goodJ = await good.json();
check("services with numeric countryId works", good.status === 200 && goodJ.services?.[0]?.priceUsd === 6);

// --- #8: diag key — public without, full with query, full with header, wrong stays public ---
const pub = await (await call(new Request("https://w.test/health"))).json();
check("health without key is public-only", pub.ok === true && !("webhook" in pub) && !!pub.version);
const wrong = await (await call(new Request("https://w.test/health?k=nope"))).json();
check("health with wrong key stays public", !("webhook" in wrong));
const full = await (await call(new Request("https://w.test/health?k=s3cr3t"))).json();
check("health with ?k= gives full diagnostics", "webhook" in full);
const fullH = await (await call(new Request("https://w.test/health", { headers: { "x-diag-key": "s3cr3t" } }))).json();
check("health with x-diag-key header gives full diagnostics", "webhook" in fullH);

// --- #8: webhook secret compare ---
const whBad = await call(new Request("https://w.test/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong", "content-type": "application/json" }, body: "{}" }));
check("webhook with wrong secret -> 403", whBad.status === 403);
const whOk = await call(new Request("https://w.test/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "s3cr3t", "content-type": "application/json" }, body: "{}" }));
check("webhook with correct secret -> 200", whOk.status === 200);

// --- rebuy redesign structure ---
const app = await (await call(new Request("https://w.test/app"))).text();
check("rebuy is an outlined pill inside the side column",
  app.includes('class="rebuy"') && !app.includes('class="mini rebuy"') &&
  app.includes("'</span>' + rb + '</div></div>'") &&
  app.includes(".hrow .rebuy{display:inline-flex") && app.includes("border:1px solid rgba(255,255,255,.28)") &&
  app.includes(".hrow .hside{display:flex;flex-direction:column"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("app script err:", e.message); } }
check("app scripts parse", ok);

console.log(fails ? `\n${fails} FAILURES` : "\nV222_ALL_OK");
process.exit(fails ? 1 : 0);
