// v2.16.0 — F13 English UI (bot + web), F14 web notifications, F15 rebuy + live stock.
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
    if (path.endsWith("/activations/9001")) return json({ id: 9001, status: "finished", phoneNumber: "5511999999999", latestCode: "12345", codes: ["12345"], expiresAt: new Date(Date.now() + 600000).toISOString() });
    return json({ spendable: 500, balance: 500, currency: "BRL" });
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const upd = async (u) => { await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cr3t" }, body: JSON.stringify(u) }), env, ctx); await drain(); };
const cbq = (data, uid) => ({ update_id: Math.random() * 1e9 | 0, callback_query: { id: "q" + Math.random(), data, from: { id: uid, first_name: "U" }, message: { message_id: 7, date: 0, chat: { id: uid, type: "private" } } } });
const msgU = (text, uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, text, from: { id: uid, first_name: "U" }, chat: { id: uid, type: "private" } } });
const textsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.text || c.body.caption || "").join("\n");
const markupsTo = (uid) => JSON.stringify(tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.reply_markup || {}));
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// ---------- bot: first /start asks language ----------
tgCalls.length = 0;
await upd(msgU("/start", 555));
check("fresh /start shows language picker", textsTo(555).includes("Choose your language") && markupsTo(555).includes("lang:en") && markupsTo(555).includes("lang:fa"));
check("home not shown before picking", !textsTo(555).includes("Welcome to the"));
await upd(cbq("lang:en", 555));
check("lang saved as en", get("user:555")?.lang === "en");
check("EN home after picking", textsTo(555).includes("Welcome to the") && markupsTo(555).includes("Buy number") && markupsTo(555).includes("langmenu"));
await upd(cbq("langmenu", 555));
check("langmenu reopens picker", markupsTo(555).includes("lang:fa"));

// EN countries + confirm
tgCalls.length = 0;
await upd(cbq("countries:0", 555));
check("EN countries header", textsTo(555).includes("Choose a country"));
await upd(cbq("services:1:0", 555));
tgCalls.length = 0;
await upd(cbq("confirm:1:10", 555));
check("EN confirm screen", textsTo(555).includes("Confirm purchase") && textsTo(555).includes("Telegram"));

// EN activation text + rebuy from a closed order
put("act:9001", { id: 9001, userId: "555", countryId: 1, serviceId: 10, price: 6, providerPriceBrl: 25, phoneNumber: "5511999999999", serviceName: "Telegram", status: "finished", createdAt: Date.now() - 3600000, charged: true, latestCode: "12345", codes: ["12345"] });
tgCalls.length = 0;
await upd(cbq("act:9001", 555));
check("EN activation text", textsTo(555).includes("Your number:") && textsTo(555).includes("Code:"));
check("closed order has Buy again", markupsTo(555).includes("rebuy:9001"));
tgCalls.length = 0;
await upd(cbq("rebuy:9001", 555));
check("rebuy opens EN confirm for same service", textsTo(555).includes("Confirm purchase") && textsTo(555).includes("Telegram"));
tgCalls.length = 0;
await upd(cbq("rebuy:9001", 999)); // not the owner
check("rebuy of someone else's order refused", !textsTo(999).includes("Confirm purchase"));

// FA user: picker then Persian home
tgCalls.length = 0;
await upd(msgU("/start", 556));
await upd(cbq("lang:fa", 556));
check("FA home after picking fa", get("user:556")?.lang === "fa" && markupsTo(556).includes("خرید شماره"));

// ---------- web: structure ----------
{
  const res = await worker.fetch(new Request("https://w.test/app"), env, ctx); await drain();
  const html = await res.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parseOk = scripts.length > 0;
  for (const s of scripts) { try { new Function(s); } catch (e) { parseOk = false; console.log("parse err:", e.message); } }
  const client = scripts.join("\n");
  const accStart = html.indexOf('id="v-account"');
  const installAt = html.indexOf('id="installCard"');
  const navAt = html.indexOf('<nav');
  check("web scripts parse", parseOk);
  check("language toggle + dictionary present", html.includes('id="langBtn"') && client.includes("function toggleLang") && client.includes("bm_lang") && html.includes("data-i="));
  check("landing = account", client.includes("showView('account')"));
  check("install card moved into account", accStart > -1 && installAt > accStart && installAt < navAt);
  check("notifications card + helpers present", html.includes('id="notifBtn"') && client.includes("function enableNotifs") && client.includes("function fireNotif") && client.includes("function watchTopups") && client.includes("function notifState"));
  check("code-arrival notification hook", client.includes("fireNotif(W('کد پیامک رسید'"));
  check("rebuy + live stock present", client.includes("function rebuyOrder") && client.includes("function startStockTimer") && client.includes("30000"));
  check("no native confirm() in client", !client.includes("confirm("));
}

// ---------- web: /api/orders exposes countryId/serviceId ----------
{
  const payload = { id: 555, first_name: "U", auth_date: Math.floor(Date.now() / 1000) };
  const dcs = Object.keys(payload).sort().map((k) => `${k}=${payload[k]}`).join("\n");
  const secret = createHash("sha256").update("T").digest();
  payload.hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const authRes = await worker.fetch(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), env, ctx);
  await drain();
  const authJson = await authRes.json();
  const tok = authJson.token;
  check("web auth ok", !!tok);
  const ordRes = await worker.fetch(new Request("https://w.test/api/orders", { headers: { authorization: "Bearer " + tok } }), env, ctx);
  await drain();
  const ordJson = await ordRes.json();
  const o = (ordJson.orders || []).find((x) => Number(x.id) === 9001);
  check("/api/orders exposes countryId/serviceId", !!o && o.countryId === 1 && o.serviceId === 10);
}

console.log(fails ? `\n${fails} FAILURES` : "\nV216_ALL_OK");
process.exit(fails ? 1 : 0);
