// v2.23.0 — the full bug-list batch:
//  1) a receipt under review extends the deadline 24h (no expiry mid-review),
//     bot receipts for closed payments are refused;
//  2) web orders/history caps raised (55 orders visible);
//  3) admin pending list sorted newest-first with a total count;
//  4) splash retry watchdog markup; 5) kvList parallel batches (structural);
//  6) crypto expected-amount collision regeneration (stubbed Math.random);
//  7) EN amount prompt + EN expiry notification + login slogan key;
//  8) /pay seen/expired views use SVG, no emoji; 9) admin receipt message is
//     closed on user cancel (buttons stripped); 10) stale text updated.
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
      return json({ ok: true, result: { message_id: 4242, photo: [{ file_id: "ph_small" }, { file_id: "ph_big" }] } });
    }
    sent.push({ method, body });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (method === "getMe") return json({ ok: true, result: { username: "testbot" } });
    if (method === "getChatMember") return json({ ok: true, result: { status: "member" } });
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
put("user:555", { id: "555", balance: 5, state: null, createdAt: NOW, lang: "fa" });
put("user:556", { id: "556", balance: 5, state: null, createdAt: NOW, lang: "en" });
// Fix 1 pair: same age (40 min), one WITH a receipt under review, one without.
put("topup:t-rcpt", { id: "t-rcpt", userId: "555", creditUsd: 25, method: "card", status: "pending", createdAt: NOW - 40 * 60000, expiresAt: NOW - 10 * 60000, amountToman: 6262500, receiptFileId: "fid1", receiptCount: 1, receiptAt: NOW - 15 * 60000, adminMsgId: 4242 });
put("topup:t-plain", { id: "t-plain", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: NOW - 40 * 60000, expiresAt: NOW - 10 * 60000 });
put("topup:t-en", { id: "t-en", userId: "556", creditUsd: 25, method: "session", status: "pending", createdAt: NOW - 40 * 60000, expiresAt: NOW - 10 * 60000 });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { (ctx.jobs ||= []).push(Promise.resolve(p).catch(() => {})); }, jobs: [] };
const worker = (await import("../src/index.js")).default;
const call = (req) => worker.fetch(req, env, ctx);
const drain = async () => { while (ctx.jobs.length) await ctx.jobs.shift(); };
const upd = async (u) => { await call(new Request("https://w.test/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "s3cr3t", "content-type": "application/json" }, body: JSON.stringify(u) })); await drain(); };
const cb = (from, data) => upd({ callback_query: { id: "q" + Math.random(), from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" } }, data } });
const msg = (from, extra) => upd({ message: { message_id: 3, from: { id: from }, chat: { id: from, type: "private" }, ...extra } });
const textsTo = (id) => sent.filter((x) => String(x.body?.chat_id) === String(id) && x.body?.text).map((x) => x.body.text);
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// --- Fix 1: cron must NOT expire the receipt topup, must expire the others ---
await worker.scheduled({}, env, ctx); await drain();
check("receipt topup survives past its 30-min deadline", get("topup:t-rcpt")?.status === "pending");
check("plain topup expires as before", get("topup:t-plain")?.status === "expired");

// --- Fix 7b: the EN user's expiry notice is English ---
check("EN expiry notification is English", textsTo("556").some((t) => t.includes("Payment window closed")));

// --- Fix 1: admin can still approve the receipt topup afterwards ---
sent.length = 0;
await cb(111, "apr:t-rcpt");
check("admin approval credits the receipt topup after the old deadline", get("topup:t-rcpt")?.status === "approved" && Number(get("user:555")?.balance) === 30);

// --- Fix 1b: bot receipt for a closed (expired) payment is refused ---
put("user:557", { id: "557", balance: 0, state: "await_card_receipt", stateData: "t-plain", createdAt: NOW });
await msg(557, { photo: [{ file_id: "zz1" }] });
check("bot receipt for an expired payment is refused", textsTo("557").some((t) => t.includes("بسته شده است")) && get("topup:t-plain")?.status === "expired");

// --- Fix 3: pending list sorted + count ---
for (let i = 1; i <= 12; i++) {
  put(`topup:tp-${i}`, { id: `tp-${i}`, userId: String(9000 + i), creditUsd: 10, method: "card", status: "pending", createdAt: NOW + i * 1000, receiptFileId: "f" + i, receiptCount: 1, amountToman: 2500000 });
}
sent.length = 0;
await cb(111, "adm_pending");
const pendText = sent.map((x) => x.body?.text || x.body?.caption || "").join("\n");
check("pending list shows the total count", pendText.includes("(۱۲)"));
check("pending list notes the hidden remainder", pendText.includes("و ۲ مورد دیگر"));
check("pending list is newest-first", pendText.indexOf("۹۰۱۲") !== -1 && pendText.indexOf("۹۰۱۲") < pendText.indexOf("۹۰۰۳"));

// --- Fix 2: web orders beyond 50 are returned ---
for (let i = 0; i < 55; i++) put(`act:a-${i}`, { id: `a-${i}`, userId: "555", price: 6, phoneNumber: "5511999" + i, serviceName: "Telegram", status: "finished", createdAt: NOW - i * 1000, charged: true });
const payload = { id: 555, first_name: "T", auth_date: Math.floor(Date.now() / 1000) };
const secret = createHash("sha256").update("T").digest();
payload.hash = createHmac("sha256", secret).update(Object.keys(payload).sort().map((k) => `${k}=${payload[k]}`).join("\n")).digest("hex");
const authRes = await call(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
const { token } = await authRes.json();
const orders = await (await call(new Request("https://w.test/api/orders", { headers: { authorization: "Bearer " + token } }))).json();
check("orders API returns more than 50 records", (orders.orders || []).length === 55);

// --- Fix 9: web receipt stores adminMsgId; user cancel closes the message ---
put("topup:t-web", { id: "t-web", userId: "555", creditUsd: 25, method: "card", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000, amountToman: 6262500 });
const fd = new FormData();
fd.append("receipt", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "r.jpg");
const rc = await call(new Request("https://w.test/pay/receipt?t=t-web", { method: "POST", body: fd }));
const rcJ = await rc.json();
check("web receipt accepted", rcJ.ok === true);
check("receiptAt + adminMsgId stored", !!get("topup:t-web")?.receiptAt && get("topup:t-web")?.adminMsgId === 4242);
sent.length = 0;
const cx = await call(new Request("https://w.test/pay/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "t-web" }) }));
const cxJ = await cx.json();
check("user cancel works", cxJ.ok === true && get("topup:t-web")?.status === "cancelled");
check("admin receipt keyboard stripped on cancel", sent.some((x) => x.method === "editMessageReplyMarkup" && x.body?.message_id === 4242 && (x.body?.reply_markup?.inline_keyboard || []).length === 0));
check("admin receipt caption marked as cancelled", sent.some((x) => x.method === "editMessageCaption" && String(x.body?.caption || "").includes("توسط کاربر لغو شد")));

// --- Fix 6: deterministic collision regeneration via stubbed Math.random ---
const seq = [0.5, 0.5, 0.7];
const origRandom = Math.random;
Math.random = () => (seq.length ? seq.shift() : 0.31);
put("topup:t-c1", { id: "t-c1", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000 });
put("topup:t-c2", { id: "t-c2", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: NOW, expiresAt: NOW + 1800000 });
const sel = async (t) => call(new Request("https://w.test/pay/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t, m: "USDT_TRC20" }) }));
await sel("t-c1");
const amt1 = get("topup:t-c1")?.expectedCrypto;
await sel("t-c2");
Math.random = origRandom;
const amt2 = get("topup:t-c2")?.expectedCrypto;
check("first select uses the 0.5 tail", amt1 === Number((25 + (Math.floor(0.5 * 900) + 100) / 1e6).toFixed(4)));
check("colliding select regenerates to the 0.7 tail", amt2 === Number((25 + (Math.floor(0.7 * 900) + 100) / 1e6).toFixed(4)));

// --- Fixes 4/5/7/8: page-level structure ---
const app = await (await call(new Request("https://w.test/app"))).text();
check("splash watchdog present", app.includes('id="spRetry"') && app.includes("Loading is taking too long"));
check("login slogan has a translation key", app.includes('data-i="logoTag"') && app.includes("logoTag:['دروازه‌ای امن به دنیای پرسرعت','A secure gateway to a fast world']"));
const payExp = await (await call(new Request("https://w.test/pay?t=t-plain"))).text();
check("expired /pay view uses the SVG clock (no emoji)", !payExp.includes("⏱") && payExp.includes('stroke="currentColor"'));
put("topup:t-seen", { id: "t-seen", userId: "555", creditUsd: 25, method: "crypto", crypto: "USDT_TRC20", walletAddress: "TWALLET12345678901234567890123", expectedCrypto: 25.0005, status: "pending", createdAt: NOW, expiresAt: NOW + 1800000, seenAt: NOW - 60000 });
const paySeen = await (await call(new Request("https://w.test/pay?t=t-seen"))).text();
check("seen /pay view uses an SVG (no hourglass emoji)", !paySeen.includes("⏳") && paySeen.includes("تراکنش دیده شد"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let okS = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { okS = false; console.log("app script err:", e.message); } }
check("app scripts parse", okS);

console.log(fails ? `\n${fails} FAILURES` : "\nV223_ALL_OK");
process.exit(fails ? 1 : 0);
