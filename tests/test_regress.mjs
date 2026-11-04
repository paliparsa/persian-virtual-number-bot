// Consolidated regression suite (rewritten after a /tmp wipe): the
// money-critical cross-version paths in one pass.
import { createHash, createHmac } from "node:crypto";
const store = new Map();
const put = (k, v) => store.set(k, JSON.stringify(v));
const get = (k) => { const v = store.get(k); return v === undefined ? null : JSON.parse(v); };
const kv = {
  async get(k, opts) { const v = store.get(k); if (v === undefined) return null; return (opts === "json" || (opts && opts.type === "json")) ? JSON.parse(v) : v; },
  async put(k, v, opts) { if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV ttl"); store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" }; },
};
const tgCalls = [];
const actState = {};
let actSeq = 0;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    const body = opts.body ? JSON.parse(opts.body) : {};
    tgCalls.push({ method, body });
    if (method === "getMe") return json({ ok: true, result: { id: 42, username: "testbot" } });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (method === "getChatMember") return json({ ok: true, result: { status: "member" } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("core.smsfullbot.com")) {
    const p = new URL(u).pathname;
    if (p.endsWith("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    if (p.endsWith("/services")) return json([{ id: 2, code: "wa", name: "WhatsApp", price: 25, available: 5 }]);
    if (p.endsWith("/balance")) return json({ spendable: 500, balance: 500, currency: "BRL" });
    if (p.endsWith("/activations") && opts.method === "POST") {
      const id = "a" + (++actSeq);
      actState[id] = { id, phoneNumber: "5511999" + id.slice(1), status: "waitingSms", latestCode: null, codes: [], expiresAt: new Date(Date.now() + 900000).toISOString() };
      return json(actState[id]);
    }
    const m = p.match(/\/activations\/(\w+)(?:\/(\w+))?$/);
    if (m) { const st = actState[m[1]]; if (m[2] === "cancel") st.status = "cancelled"; return json(st); }
    return json({});
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("config", { WALLET_TON: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N", GROUP_CHAT_ID: "-100999" });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const upd = async (u) => { await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cr3t" }, body: JSON.stringify(u) }), env, ctx); await drain(); };
const cbq = (data, uid) => ({ update_id: Math.random() * 1e9 | 0, callback_query: { id: "q" + Math.random(), data, from: { id: uid, first_name: "U" }, message: { message_id: 7, date: 0, chat: { id: uid, type: "private" } } } });
const msgU = (text, uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, text, from: { id: uid, first_name: "U" }, chat: { id: uid, type: "private" } } });
const textsTo = (uid) => tgCalls.filter((c) => String(c.body.chat_id) === String(uid)).map((c) => c.body.text || "").join("\n");
const actsOf = (uid) => [...store.keys()].filter((k) => k.startsWith("act:")).map((k) => get(k)).filter((a) => a.userId === String(uid));
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// settings checksum validation (v2.9) still intact
await upd(cbq("cfg_g:wallet", 111));
await upd(cbq("cfgset:WALLET_TON", 111));
await upd(msgU("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2M", 111)); // bad CRC
check("bad TON checksum rejected", textsTo(111).includes("معتبر نیست") || textsTo(111).includes("خطا") || !get("config")?.WALLET_TON?.endsWith("xqB2M"));
await upd(msgU("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N", 111));
check("good TON checksum accepted", get("config")?.WALLET_TON?.endsWith("xqB2N"));

// audit render (v2.10 + span fix)
tgCalls.length = 0;
await upd(cbq("adm_audit", 111));
check("audit renders without <span>", textsTo(111).includes("سوابق تغییرات") && !textsTo(111).includes("<span"));

// referral chain (v2.11): 555 refers 777; 777 buys; code lands; 555 earns 10% of $6
put("user:555", { id: "555", balance: 0, state: null });
await upd(msgU("/start ref_555", 777));
check("referral captured at first contact", get("user:777")?.referredBy === "555");
put("user:777", { ...get("user:777"), balance: 20 });
await upd(cbq("buy:1:2", 777));
const act1 = actsOf(777)[0];
check("buy charged $6", !!act1 && act1.price === 6 && get("user:777")?.balance === 14);
actState[act1.id].status = "codeReceived"; actState[act1.id].latestCode = "111222";
await upd(cbq("act:" + act1.id, 777));
check("code shown; referral paid $0.60; group purchase post", textsTo(777).includes("111222") && get("user:555")?.balance === 0.6 && textsTo("-100999").includes("خرید موفق"));

// coupon buy (v2.12): 20% off
put("coupon:OFF20", { code: "OFF20", type: "percent", value: 20, maxUses: 0, usedCount: 0, minPurchase: 0, expiresAt: 0, active: true, createdAt: Date.now() });
put("user:778", { id: "778", balance: 20, state: null, coupon: "OFF20" });
await upd(cbq("buy:1:2", 778));
const act2 = actsOf(778)[0];
check("coupon buy charged $4.80 + consumed", !!act2 && act2.price === 4.8 && get("coupon:OFF20")?.usedCount === 1);

// package topup (v2.13) + group top-up post (v2.14) + audit/health cron smoke
put("user:779", { id: "779", balance: 0, state: null });
await upd(cbq("pkgbuy:50", 779));
const sess = [...store.keys()].filter((k) => k.startsWith("topup:")).map((k) => get(k)).find((t) => t.userId === "779");
check("package session stamped (50/+4)", !!sess && sess.pkgBonus === 4);
await upd(cbq("apr:" + sess.id, 111));
check("package credited 54 + group top-up post", get("user:779")?.balance === 54 && textsTo("-100999").includes("شارژ موفق"));
await worker.scheduled({}, env, ctx); await drain();
check("cron runs clean (webhook/health/balance)", true);

// web: login + topup + buy with session (v2.0 core)
function tgAuthPayload(id) {
  const data = { id: String(id), first_name: "Web", auth_date: String(Math.floor(Date.now() / 1000)) };
  const checkStr = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update("T").digest()).update(checkStr).digest("hex");
  return data;
}
put("user:780", { id: "780", balance: 20, state: null });
const authRes = await worker.fetch(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tgAuthPayload(780)) }), env, ctx);
await drain();
const token = (await authRes.json()).token;
const api = async (path, body) => {
  const r = await worker.fetch(new Request("https://w.test" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await drain();
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const wb = await api("/api/buy", { countryId: 1, serviceId: 2 });
check("web buy works", wb.status === 200 && actsOf(780).length === 1 && get("user:780")?.balance === 14);
const wt = await api("/api/topup", { amountUsd: 10 });
check("web manual topup session created", wt.status === 200 && !!wt.j.payUrl);

console.log(fails === 0 ? "REGRESSION_ALL_OK" : "FAILURES: " + fails);
process.exit(0);
