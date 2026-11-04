// v2.24.0 — round-2 bug fixes:
//  1) awaiting_receipt is a visible, actionable state (bot list, web open
//     list, admin pending, /pay review view, replacement receipts, cancel);
//  2) cron settle isolation (soft check: a malformed record can't stall the
//     tick); 3) bilingual join/blocked API errors + join sheet/banner markup;
//  4) /pay branding is BlueMajazi; 5) bot receipt edge messages in English;
//  6) card_verify label in the bot session message.
import { createHash, createHmac } from "node:crypto";
const store = new Map();
const put = (k, v) => store.set(k, JSON.stringify(v));
const get = (k) => { const v = store.get(k); return v === undefined ? null : JSON.parse(v); };
const kv = {
  async get(k, opts) { const v = store.get(k); if (v === undefined) return null; return (opts === "json" || (opts && opts.type === "json")) ? JSON.parse(v) : v; },
  async put(k, v, opts) { if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV ttl"); store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix, cursor }) {
    const all = [...store.keys()].filter((k) => k.startsWith(prefix));
    const start = cursor ? parseInt(cursor) : 0;
    const slice = all.slice(start, start + 1000);
    return { keys: slice.map((name) => ({ name })), list_complete: start + 1000 >= all.length, cursor: String(start + 1000) };
  },
};
const sent = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    let body = {};
    try { body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : {}; } catch (_) {}
    if (method === "sendPhoto" && opts.body instanceof FormData) {
      sent.push({ method, formData: true });
      return json({ ok: true, result: { message_id: 5151, photo: [{ file_id: "ph_big" }] } });
    }
    sent.push({ method, body });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (method === "getMe") return json({ ok: true, result: { username: "testbot" } });
    if (method === "getChatMember") {
      const left = [555, 556].includes(Number(body.user_id));
      return json({ ok: true, result: { status: left ? "left" : "member" } });
    }
    if (method === "sendPhoto") return json({ ok: true, result: { message_id: 777, photo: [{ file_id: "ph_big" }] } });
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
const NOW = Date.now();
put("config", { WALLET_USDT_TRC20: "TWALLET12345678901234567890123", CARD_NUMBER: "6037", CARD_HOLDER: "A B", CARD_BANK: "Melli" });
put("user:111", { id: "111", balance: 0, state: null, createdAt: NOW });
put("user:555", { id: "555", balance: 100, state: null, createdAt: NOW, lang: "fa" });
put("user:556", { id: "556", balance: 5, state: null, createdAt: NOW, lang: "en" });
// Approved card topup (with package bonus) to undo
put("topup:t-undo", { id: "t-undo", userId: "555", creditUsd: 50, pkgAmount: 50, pkgBonus: 4, bonusUsd: 4, method: "card", status: "approved", createdAt: NOW - 3600000, amountToman: 12537500, receiptFileId: "fid1", receiptCount: 1, receiptAt: NOW - 3500000, adminMsgId: 4242 });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { (ctx.jobs ||= []).push(Promise.resolve(p).catch(() => {})); }, jobs: [] };
const worker = (await import("../src/index.js")).default;
const call = (req) => worker.fetch(req, env, ctx);
const drain = async () => { while (ctx.jobs.length) await ctx.jobs.shift(); };
const upd = async (u) => { await call(new Request("https://w.test/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "s3cr3t", "content-type": "application/json" }, body: JSON.stringify(u) })); await drain(); };
const cb = (from, data, withPhoto) => upd({ callback_query: { id: "q" + Math.random(), from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" }, ...(withPhoto ? { photo: [{ file_id: "x" }], caption: "cap" } : {}) }, data } });
const msg = (from, extra) => upd({ message: { message_id: 3, from: { id: from }, chat: { id: from, type: "private" }, ...extra } });
const textsTo = (id) => sent.filter((x) => String(x.body?.chat_id) === String(id) && x.body?.text).map((x) => x.body.text);
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// --- Fix 1: undo → awaiting_receipt, visible + actionable ---
await cb(111, "undo:t-undo", true);
check("undo flips to awaiting_receipt and deducts credit+bonus", get("topup:t-undo")?.status === "awaiting_receipt" && Number(get("user:555")?.balance) === 46);
check("undo re-arms the bot receipt state", get("user:555")?.state === "await_card_receipt" && get("user:555")?.stateData === "t-undo");
sent.length = 0;
await cb(555, "pays");
check("bot pending list shows the re-review state", textsTo("555").some((t) => t.includes("بررسی مجدد")));
sent.length = 0;
await cb(111, "adm_pending");
check("admin pending list includes the undone topup", sent.some((x) => String(x.body?.text || "").includes("۵۵۵")));
const payReview = await (await call(new Request("https://w.test/pay?t=t-undo"))).text();
check("/pay shows the re-review view (not closed/expired)", payReview.includes("بررسی مجدد") && !payReview.includes("این پرداخت بسته شده است"));
// web open list contains it
const payload = { id: 555, first_name: "T", auth_date: Math.floor(Date.now() / 1000) };
const secret = createHash("sha256").update("T").digest();
payload.hash = createHmac("sha256", secret).update(Object.keys(payload).sort().map((k) => `${k}=${payload[k]}`).join("\n")).digest("hex");
const authRes = await call(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
const { token } = await authRes.json();
const tops = await (await call(new Request("https://w.test/api/topups", { headers: { authorization: "Bearer " + token } }))).json();
check("web open list includes awaiting_receipt", (tops.pending || []).some((t) => t.id === "t-undo"));
// replacement receipt via web
const fd = new FormData();
fd.append("receipt", new Blob([new Uint8Array([9, 9])], { type: "image/jpeg" }), "r2.jpg");
const rc = await call(new Request("https://w.test/pay/receipt?t=t-undo", { method: "POST", body: fd }));
check("replacement receipt accepted for awaiting_receipt", (await rc.json()).ok === true && get("topup:t-undo")?.adminMsgId === 5151);
// admin re-approves → credited again incl. bonus snapshot
await cb(111, "apr:t-undo", true);
check("re-approval re-credits credit + package bonus", get("topup:t-undo")?.status === "approved" && Number(get("user:555")?.balance) === 100);
// undo again, then the user cancels the re-review
await cb(111, "undo:t-undo", true);
const cx = await call(new Request("https://w.test/pay/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "t-undo" }) }));
check("user can cancel an awaiting_receipt payment", (await cx.json()).ok === true && get("topup:t-undo")?.status === "cancelled");

// --- Fix 6: card_verify label in the bot session message ---
put("topup:t-vfy2", { id: "t-vfy2", userId: "555", creditUsd: 25, method: "card_verify", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000 });
sent.length = 0;
await cb(555, "pays");
check("card_verify session message names the verification step", textsTo("555").some((t) => t.includes("احراز")));

// --- Fix 5: EN bot receipt edge messages ---
put("topup:t-en1", { id: "t-en1", userId: "556", creditUsd: 25, method: "card", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000, amountToman: 6262500 });
const u556 = get("user:556"); u556.state = "await_card_receipt"; u556.stateData = "t-en1"; put("user:556", u556);
sent.length = 0;
await msg(556, { document: { file_id: "doc1" } });
check("EN document-instead-of-photo warning", textsTo("556").some((t) => t.includes("send the receipt as a «photo»")));
put("topup:t-en2", { id: "t-en2", userId: "556", creditUsd: 25, method: "card", status: "expired", createdAt: NOW - 3600000, expiresAt: NOW - 60000 });
const u556b = get("user:556"); u556b.state = "await_card_receipt"; u556b.stateData = "t-en2"; put("user:556", u556b);
sent.length = 0;
await msg(556, { photo: [{ file_id: "zz" }] });
check("EN closed-payment refusal", textsTo("556").some((t) => t.includes("This payment is closed")));
put("topup:t-en3", { id: "t-en3", userId: "556", creditUsd: 25, method: "card", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000, receiptCount: 3 });
const u556c = get("user:556"); u556c.state = "await_card_receipt"; u556c.stateData = "t-en3"; put("user:556", u556c);
sent.length = 0;
await msg(556, { photo: [{ file_id: "zz3" }] });
check("EN receipt-cap message", textsTo("556").some((t) => t.includes("receipt limit is full")));

// --- Fix 4: /pay branding ---
put("topup:t-brand", { id: "t-brand", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000 });
const payBrand = await (await call(new Request("https://w.test/pay?t=t-brand"))).text();
check("/pay brand is BlueMajazi with B monogram", payBrand.includes("<b>BlueMajazi</b>") && payBrand.includes('<div class="mark">B</div>') && !payBrand.includes("فروشگاه شماره مجازی"));

// --- Fix 3: bilingual gate errors + client wiring (structural) ---
put("config", { WALLET_USDT_TRC20: "TWALLET12345678901234567890123", CARD_NUMBER: "6037", CARD_HOLDER: "A B", CARD_BANK: "Melli", FORCE_JOIN_ENABLED: "1", FORCE_JOIN_CHANNEL: "@chan" });
const buyGate = await call(new Request("https://w.test/api/buy", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ countryId: 1, serviceId: 10 }) }));
const buyGateJ = await buyGate.json();
check("FA join gate: 403 + joinUrl", buyGate.status === 403 && !!buyGateJ.joinUrl && buyGateJ.error.includes("برای خرید"));
const payload6 = { id: 556, first_name: "E", auth_date: Math.floor(Date.now() / 1000) };
payload6.hash = createHmac("sha256", secret).update(Object.keys(payload6).sort().map((k) => `${k}=${payload6[k]}`).join("\n")).digest("hex");
const auth6 = await call(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload6) }));
const { token: token6 } = await auth6.json();
const buyGateEn = await call(new Request("https://w.test/api/buy", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token6 }, body: JSON.stringify({ countryId: 1, serviceId: 10 }) }));
const buyGateEnJ = await buyGateEn.json();
check("EN join gate error is English", buyGateEn.status === 403 && buyGateEnJ.error.includes("To buy, first join"));
const app = await (await call(new Request("https://w.test/app"))).text();
check("client join sheet + blocked banner wired", app.includes("function apiErr(e)") && app.includes('id="blockedBar"') && app.includes("updBlockedBar();") && app.includes("status === 'awaiting_receipt'"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let okS = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { okS = false; console.log("app script err:", e.message); } }
check("app scripts parse", okS);

// --- Fix 2 (soft): cron completes with a malformed record present ---
put("topup:t-bad", { id: "t-bad", status: "pending", method: "crypto", crypto: "USDT_TRC20" });
put("topup:t-exp2", { id: "t-exp2", userId: "555", creditUsd: 10, method: "session", status: "pending", createdAt: NOW - 3600000, expiresAt: NOW - 60000 });
await worker.scheduled({}, env, ctx); await drain();
check("cron still expires the healthy record", get("topup:t-exp2")?.status === "expired");

console.log(fails ? `\n${fails} FAILURES` : "\nV224_ALL_OK");
process.exit(fails ? 1 : 0);
