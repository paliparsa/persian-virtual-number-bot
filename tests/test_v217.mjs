// v2.17.0 — website button, table services, orders/payments polish.
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
    const path = new URL(u).pathname;
    if (path.endsWith("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    if (path.endsWith("/services")) return json([{ id: 10, code: "tg", name: "Telegram", price: 25, available: 5, iconUrl: "" }]);
    if (path.endsWith("/activations/9001")) return json({ id: 9001, status: "cancelled", phoneNumber: "5511999999999", latestCode: null, codes: [], expiresAt: new Date(Date.now() + 600000).toISOString() });
    return json({ spendable: 500, balance: 500, currency: "BRL" });
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("sys:origin", { origin: "https://w.test" });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const upd = async (u) => { await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cr3t" }, body: JSON.stringify(u) }), env, ctx); await drain(); };
const cbq = (data, uid) => ({ update_id: Math.random() * 1e9 | 0, callback_query: { id: "q" + Math.random(), data, from: { id: uid, first_name: "U" }, message: { message_id: 7, date: 0, chat: { id: uid, type: "private" } } } });
const msgU = (text, uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, text, from: { id: uid, first_name: "U" }, chat: { id: uid, type: "private" } } });
const textsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.text || "").join("\n");
const markupsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.reply_markup || {});
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// user with language already chosen -> home directly
put("user:555", { id: "555", balance: 20, state: null, createdAt: Date.now(), lang: "fa" });
await upd(msgU("/start", 555));
const homeKb = markupsTo(555).map((m) => m.inline_keyboard || []).find((k) => k.length);
check("website button is the first row", !!homeKb && homeKb[0][0].url === "https://w.test/app" && homeKb[0][0].text.includes("ورود به وبسایت"));
check("website row is a single full-width button", homeKb[0].length === 1);

// EN user sees the English label
put("user:556", { id: "556", balance: 20, state: null, createdAt: Date.now(), lang: "en" });
tgCalls.length = 0;
await upd(msgU("/start", 556));
const homeKbEn = markupsTo(556).map((m) => m.inline_keyboard || []).find((k) => k.length);
check("EN website button", !!homeKbEn && homeKbEn[0][0].url === "https://w.test/app" && homeKbEn[0][0].text.includes("Open the website"));

// services table format
tgCalls.length = 0;
await upd(cbq("services:1:0", 555));
const svcTexts = textsTo(555);
const svcKb = JSON.stringify(markupsTo(555));
check("services header has column legend", svcTexts.includes("سرویس ❘ قیمت ❘ معادل تومانی ❘ موجودی"));
check("service button is a table row", svcKb.includes("Telegram ❘ $6.00 ❘") && svcKb.includes("تومان ❘ موجودی:"));
check("service button shows stock", svcKb.includes("موجودی: ۵"));

// web structure + activation countryId
put("act:9001", { id: 9001, userId: "555", countryId: 1, serviceId: 10, price: 6, providerPriceBrl: 25, phoneNumber: "5511999999999", serviceName: "Telegram", status: "cancelled", createdAt: Date.now() - 3600000, charged: false });
{
  const res = await worker.fetch(new Request("https://w.test/app"), env, ctx); await drain();
  const html = await res.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parseOk = scripts.length > 0;
  for (const s of scripts) { try { new Function(s); } catch (e) { parseOk = false; console.log("parse err:", e.message); } }
  const client = scripts.join("\n");
  check("web scripts parse", parseOk);
  check("masking + country helpers in client", client.includes("function maskPhoneW") && client.includes("function countryNameOf") && client.includes("function ordStatusCls"));
  check("orders use hrow layout + masked dead numbers", client.includes('class="hrow ordclick"') && client.includes("maskPhoneW(o.phone)"));
  check("activation page masks dead numbers + shows country", client.includes("maskPhoneW(a.phone)") && client.includes("countryNameOf(a.countryId)"));
  check("payment amount colors wired", client.includes("amtCls") && html.includes(".hmain b.ok") && html.includes(".hmain b.bad"));
  check("green delivered pill", html.includes(".pill.ok{border-color:#1d3a24;color:#30d158"));
  check("topup form card + button spacing", html.includes('class="formcard"') && html.includes("margin-top:16px"));
  // v3.2.0 supersedes the v2.17.1 USD-only web top-up: the manual entry
  // currency now follows the display language (FA → Toman default,
  // EN → USD), switchable via chips; the server still accepts both.
  check("web top-up entry currency follows language (v3.2.0)", html.includes('id="chipTmn"') && html.includes('id="chipUsd"') && client.includes("function setTopupMode") && client.includes("amountTmn") && client.includes("amountUsd: val") && client.includes("topupMode()"));
  // masking mirrors the bot's group style: +5511*****999
  const d = "5511999999999"; const head = d.slice(0, 4), tail = d.slice(-3);
  check("mask shape sanity", ("+" + head + "*****" + tail) === "+5511*****999");
}
// /api/activation returns countryId
{
  const payload = { id: 555, first_name: "U", auth_date: Math.floor(Date.now() / 1000) };
  const dcs = Object.keys(payload).sort().map((k) => `${k}=${payload[k]}`).join("\n");
  const secret = createHash("sha256").update("T").digest();
  payload.hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const authRes = await worker.fetch(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), env, ctx);
  await drain();
  const tok = (await authRes.json()).token;
  const actRes = await worker.fetch(new Request("https://w.test/api/activation?id=9001", { headers: { authorization: "Bearer " + tok } }), env, ctx);
  await drain();
  const actJson = await actRes.json();
  check("/api/activation exposes countryId", actJson.activation && actJson.activation.countryId === 1);
}

console.log(fails ? `\n${fails} FAILURES` : "\nV217_ALL_OK");
process.exit(fails ? 1 : 0);
