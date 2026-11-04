// v2.15.0 — web package confirm modal, F11 user management, F12 xlsx export.
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
let docBytes = null, docCaption = "";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    if (opts.body instanceof FormData) {
      const doc = opts.body.get("document");
      if (doc) { docBytes = new Uint8Array(await doc.arrayBuffer()); docCaption = opts.body.get("caption") || ""; }
      tgCalls.push({ method, form: true });
      return json({ ok: true, result: { message_id: 1 } });
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    tgCalls.push({ method, body });
    if (method === "getMe") return json({ ok: true, result: { id: 42, username: "testbot" } });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("core.smsfullbot.com")) {
    if (new URL(u).pathname.endsWith("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    return json({ spendable: 500, balance: 500, currency: "BRL" });
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("config", { WALLET_TRX: "TGWebkNU8jH4PqRNBATGPw5pLhBxcu9A8C" });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const upd = async (u) => { await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cr3t" }, body: JSON.stringify(u) }), env, ctx); await drain(); };
const cbq = (data, uid) => ({ update_id: Math.random() * 1e9 | 0, callback_query: { id: "q" + Math.random(), data, from: { id: uid, first_name: "U" }, message: { message_id: 7, date: 0, chat: { id: uid, type: "private" } } } });
const msgU = (text, uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, text, from: { id: uid, first_name: "U" }, chat: { id: uid, type: "private" } } });
const textsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.text || "").join("\n");
const markupsTo = (uid) => JSON.stringify(tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.reply_markup || {}));
const cbAnswers = () => tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text || "").join("\n");
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// ---------- web package confirm modal ----------
{
  const res = await worker.fetch(new Request("https://w.test/app"), env, ctx); await drain();
  const html = await res.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let parseOk = scripts.length > 0;
  for (const s of scripts) { try { new Function(s); } catch (e) { parseOk = false; console.log("parse err:", e.message); } }
  const client = scripts.join("\n");
  const pkgFn = client.slice(client.indexOf("function doTopupPkg"), client.indexOf("function closePkgConfirm"));
  check("modal exists, script parses, pkg click no longer posts directly", parseOk && html.includes('id="pkgConfirm"') && html.includes("تأیید شارژ پکیج")
    && pkgFn.includes("pkgConfirm") && !pkgFn.includes("/api/topup") && client.includes("function confirmPkgTopup"));
}

// ---------- F11: user management ----------
put("user:777", { id: "777", balance: 10, state: null, createdAt: Date.now() - 86400000, refCount: 2, refEarned: 1.5 });
await upd(cbq("adm_users", 111));
check("users home renders", textsTo(111).includes("مدیریت کاربران"));
await upd(cbq("usr_search", 111));
await upd(msgU("777", 111));
check("user card shows balance + actions", textsTo(111).includes("کاربر ۷۷۷") && markupsTo(111).includes("uadj:777:add") && markupsTo(111).includes("ublock:777"));
await upd(cbq("usr_search", 111));
await upd(msgU("424242", 111));
check("unknown user handled", textsTo(111).includes("پیدا نشد"));
// adjust: +5 with reason
await upd(cbq("uadj:777:add", 111));
await upd(msgU("5", 111));
await upd(msgU("جبران خسارت", 111));
check("balance adjusted +5", get("user:777")?.balance === 15);
check("adjust audited with reason + user notified", [...store.keys()].filter((k) => k.startsWith("audit:")).map((k) => get(k)).some((e) => e.action === "uadj" && String(e.extra).includes("جبران خسارت")) && textsTo(777).includes("جبران خسارت"));
// adjust: sub beyond balance rejected, then valid sub
await upd(cbq("uadj:777:sub", 111));
await upd(msgU("999", 111));
check("over-balance deduction refused", get("user:777")?.balance === 15 && textsTo(111).includes("فقط"));
await upd(msgU("5", 111));
await upd(msgU("اصلاح اشتباه", 111));
check("balance adjusted -5", get("user:777")?.balance === 10);
// block + enforcement
await upd(cbq("ublock:777", 111));
check("user blocked + notified", get("user:777")?.blocked === true && textsTo(777).includes("مسدود شد"));
tgCalls.length = 0;
await upd(msgU("سلام", 777));
check("blocked user stopped in bot", textsTo(777).includes("حساب شما مسدود شده است"));
await upd(cbq("countries:0", 777));
check("blocked user callback stopped", cbAnswers().includes("مسدود"));
function tgAuthPayload(id) {
  const data = { id: String(id), first_name: "Web", auth_date: String(Math.floor(Date.now() / 1000)) };
  const checkStr = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update("T").digest()).update(checkStr).digest("hex");
  return data;
}
const authRes = await worker.fetch(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tgAuthPayload(777)) }), env, ctx);
await drain();
const token = (await authRes.json()).token;
const api = async (path, body) => {
  const r = await worker.fetch(new Request("https://w.test" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await drain();
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const meB = await api("/api/me");
const buyB = await api("/api/buy", { countryId: 1, serviceId: 2 });
check("web: /api/me flags blocked, buy refused", meB.j.blocked === true && buyB.status === 403 && String(buyB.j.error).includes("مسدود"));
await upd(cbq("ublock:777", 111));
check("unblocked", get("user:777")?.blocked === false);
tgCalls.length = 0;
await upd(msgU("/start", 777));
check("unblocked user back in (v2.16: language picker first)", markupsTo(777).includes("lang:fa"));
await upd(cbq("lang:fa", 777));
check("unblocked user reaches home after language pick", markupsTo(777).includes("countries:0"));

// ---------- F12: xlsx export ----------
put("topup:x1", { id: "x1", userId: "777", method: "card", status: "approved", creditUsd: 25, bonusUsd: 1, createdAt: Date.now(), paidTxid: "" });
put("act:x9", { id: "x9", userId: "777", price: 6, providerPriceBrl: 25, phoneNumber: "989121112233", serviceName: "WhatsApp", countryId: 1, status: "codeReceived", latestCode: "123456", createdAt: Date.now(), charged: true });
await upd(cbq("adm_export", 111));
check("document sent with caption", !!docBytes && docCaption.includes("خروجی مالی"));
if (docBytes) {
  const txt = new TextDecoder().decode(docBytes);
  const entries = (txt.match(/PK\x01\x02/g) || []).length;
  check("valid zip, 6 parts, sheets + data present", docBytes[0] === 0x50 && docBytes[1] === 0x4b && entries === 6
    && txt.includes("شارژها") && txt.includes("فروش‌ها") && txt.includes("WhatsApp") && txt.includes("989121112233") && txt.includes("Brazil"));
}

console.log(fails === 0 ? "USERS_AND_EXPORT_OK" : "FAILURES: " + fails);
process.exit(0);
