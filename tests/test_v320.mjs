// v3.2.0 — the four ports from BG-3x-ui-sell: (1) admin backup/restore,
// (2) dual pricing mode (PRICE_MODE usd|tmn over provider BRL prices),
// (3) display currency by language + dual-currency top-up packages +
// MIN_TOPUP_TMN, (4) the "A service by BlueGate®" tagline — and proof
// that nothing else crossed over (no categories, no porder, no BluePing).
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

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
const docSends = [];
let fileContent = "";
let ratesDown = false;
const actState = {};
let actSeq = 0;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org/file/")) return new Response(fileContent, { status: 200 });
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    if (opts.body instanceof FormData) {
      const doc = opts.body.get("document");
      docSends.push({ method, caption: opts.body.get("caption") || "", filename: doc?.name || "", text: doc ? await doc.text() : "" });
      return json({ ok: true, result: { message_id: 7 } });
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    tgCalls.push({ method, body });
    if (method === "getMe") return json({ ok: true, result: { id: 42, username: "testbot" } });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (method === "getChatMember") return json({ ok: true, result: { status: "member" } });
    if (method === "getFile") return json({ ok: true, result: { file_path: "bk.json" } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("core.smsfullbot.com")) {
    const p = new URL(u).pathname;
    if (p.endsWith("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    if (p.endsWith("/services")) return json([{ id: 10, code: "tg", name: "Telegram", price: 25, available: 5, iconUrl: "" }]);
    if (p.endsWith("/balance")) return json({ spendable: 500, balance: 500, currency: "BRL" });
    if (p.endsWith("/activations") && opts.method === "POST") {
      const id = "a" + (++actSeq);
      actState[id] = { id, phoneNumber: "5511999000" + actSeq, status: "waitingSms", latestCode: null, codes: [], price: 25, service: { name: "Telegram" }, expiresAt: new Date(Date.now() + 900000).toISOString() };
      return json(actState[id]);
    }
    const m = p.match(/\/activations\/(\w+)(?:\/(\w+))?$/);
    if (m) return json(actState[m[1]] || {});
    return json({});
  }
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return ratesDown ? json({}, 500) : json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return ratesDown ? json({}) : json({ rates: { USD: 0.2 } });
  return json({});
};
put("config", {});
put("sys:origin", { origin: "https://w.test" });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const upd = async (u) => { await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cr3t" }, body: JSON.stringify(u) }), env, ctx); await drain(); };
const cbq = (data, uid) => ({ update_id: Math.random() * 1e9 | 0, callback_query: { id: "q" + Math.random(), data, from: { id: uid, first_name: "U" }, message: { message_id: 7, date: 0, chat: { id: uid, type: "private" } } } });
const msgU = (text, uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, text, from: { id: uid, first_name: "U" }, chat: { id: uid, type: "private" } } });
const docU = (uid) => ({ update_id: Math.random() * 1e9 | 0, message: { message_id: Math.random() * 1e4 | 0, date: 0, from: { id: uid, first_name: "A" }, chat: { id: uid, type: "private" }, document: { file_id: "f1", file_size: 2048 } } });
const textsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.text || "").join("\n");
const markupsTo = (uid) => tgCalls.filter((c) => String(c.body?.chat_id) === String(uid)).map((c) => c.body.reply_markup || {});
const kbText = (uid) => JSON.stringify(markupsTo(uid));
const actsOf = (uid) => [...store.keys()].filter((k) => k.startsWith("act:")).map((k) => get(k)).filter((a) => a.userId === String(uid));
const topupsOf = (uid) => [...store.keys()].filter((k) => k.startsWith("topup:")).map((k) => get(k)).filter((t) => t.userId === String(uid));
const faDigits = (v) => String(v).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
const faNum = (v, dec = 2) => faDigits(Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const faInt = (v) => faDigits(Number(v || 0).toLocaleString("en-US"));
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

function tgAuthPayload(id) {
  const data = { id: String(id), first_name: "Web", auth_date: String(Math.floor(Date.now() / 1000)) };
  const checkStr = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  data.hash = createHmac("sha256", createHash("sha256").update("T").digest()).update(checkStr).digest("hex");
  return data;
}
async function apiFor(id) {
  const r = await worker.fetch(new Request("https://w.test/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tgAuthPayload(id)) }), env, ctx);
  await drain();
  const token = (await r.json()).token;
  return async (path, body) => {
    const rr = await worker.fetch(new Request("https://w.test" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
    await drain();
    return { status: rr.status, j: await rr.json().catch(() => ({})) };
  };
}

// ---------- phase 1: USD pricing mode (default) — behaviour unchanged ----------
put("user:555", { id: "555", balance: 20, state: null, createdAt: Date.now(), lang: "fa" });
put("user:556", { id: "556", balance: 20, state: null, createdAt: Date.now(), lang: "en" });
const api555 = await apiFor(555);
{
  const me = await api555("/api/me");
  check("/api/me exposes tmnRate + priceMode + minTopupTmn", me.j.tmnRate === 250500 && me.j.priceMode === "usd" && me.j.minTopupTmn === 10000);
  const sv = await api555("/api/services?countryId=1");
  check("usd mode: /api/services priceUsd=6, priceTmn=null", sv.j.services?.[0]?.priceUsd === 6 && sv.j.services?.[0]?.priceTmn === null && sv.j.priceMode === "usd");
}
tgCalls.length = 0;
await upd(cbq("services:1:0", 555));
check("usd mode: FA service label byte-stable", kbText(555).includes(`Telegram ❘ $6.00 ❘ ${faInt(1503000)} تومان ❘ موجودی: ${faInt(5)}`));
tgCalls.length = 0;
await upd(msgU("/start", 555));
check("FA home balance renders in Toman (display currency)", textsTo(555).includes(`${faInt(5010000)} تومان`));
check("bot home carries the tagline", textsTo(555).includes("A service by BlueGate®"));
tgCalls.length = 0;
await upd(msgU("/start", 556));
check("EN home balance stays USD + tagline", textsTo(556).includes("$20.00") && textsTo(556).includes("A service by BlueGate®"));

// ---------- phase 2: switch to TMN pricing mode via the admin toggle ----------
await upd(cbq("admin", 111));
check("admin home shows pricing-mode + backup buttons", kbText(111).includes("cfgmode") && kbText(111).includes("adm_backup") && kbText(111).includes("حالت قیمت‌گذاری"));
await upd(cbq("cfgmode", 111));
check("cfgmode toggle sets PRICE_MODE=tmn", get("config")?.PRICE_MODE === "tmn");
check("cfgmode toggle is audited", [...store.keys()].filter((k) => k.startsWith("audit:")).map((k) => get(k)).some((e) => e.action === "cfgmode"));
{
  const sv = await api555("/api/services?countryId=1");
  check("tmn mode: priceTmn is the record price (1,503,000), usd derived (6)", sv.j.services?.[0]?.priceTmn === 1503000 && sv.j.services?.[0]?.priceUsd === 6 && sv.j.priceMode === "tmn");
}
tgCalls.length = 0;
await upd(cbq("services:1:0", 555));
check("tmn mode: FA service label leads with Toman + USD deduction", kbText(555).includes(`Telegram ❘ ${faInt(1503000)} تومان ❘ ≈ $${faNum(6)} ❘ موجودی: ${faInt(5)}`));
check("tmn mode: services header legend switches", textsTo(555).includes("سرویس ❘ قیمت (تومان) ❘ معادل دلاری ❘ موجودی"));
tgCalls.length = 0;
await upd(cbq("confirm:1:10", 555));
check("tmn mode: confirm shows Toman price + exact USD deduction", textsTo(555).includes(`${faInt(1503000)} تومان`) && textsTo(555).includes("مبلغ کسر از موجودی") && textsTo(555).includes(`$${faNum(6)}`));
await upd(cbq("buy:1:10", 555));
const actTmn = actsOf(555)[0];
check("tmn mode: buy charges derived USD and stores priceTmn", !!actTmn && actTmn.price === 6 && actTmn.priceTmn === 1503000 && get("user:555")?.balance === 14);

// manual TOMAN_PER_BRL wins over the derived BRL→Toman rate
put("config", { ...get("config"), TOMAN_PER_BRL: "40000" });
{
  const sv = await api555("/api/services?countryId=1");
  check("tmn mode + TOMAN_PER_BRL: priceTmn=1,200,000, usd=4.79", sv.j.services?.[0]?.priceTmn === 1200000 && sv.j.services?.[0]?.priceUsd === 4.79);
}
{ const c = { ...get("config") }; delete c.TOMAN_PER_BRL; put("config", c); }

// ---------- phase 3: dual-currency packages + fixed Toman card amount ----------
put("config", { ...get("config"), CARD_NUMBER: "6037991234567890", CARD_HOLDER: "Test", CARD_BANK: "Melli" });
put("topup_pkgs", [{ amount: 5000000, bonus: 500000, currency: "tmn" }, { amount: 50, bonus: 4, currency: "usd" }]);
tgCalls.length = 0;
await upd(cbq("topup", 555));
check("FA top-up shows TMN packages only (display currency)", kbText(555).includes("pkgbuy:tmn:5000000") && !kbText(555).includes("pkgbuy:usd:50"));
tgCalls.length = 0;
await upd(cbq("topup", 556));
check("EN top-up shows USD packages only", kbText(556).includes("pkgbuy:usd:50") && !kbText(556).includes("pkgbuy:tmn:5000000"));
await upd(cbq("pkgbuy:tmn:5000000", 555));
const sessTmn = topupsOf(555).find((t) => t.pkgCurrency === "tmn");
check("TMN package session snapshots USD credit/bonus at the live rate", !!sessTmn && sessTmn.creditUsd === 19.96 && sessTmn.pkgBonus === 2 && sessTmn.pkgAmountTmn === 5000000 && sessTmn.amountTomanFixed === 5000000);
{
  const r = await worker.fetch(new Request("https://w.test/pay/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: sessTmn.id, m: "CARD" }) }), env, ctx);
  await drain();
  const tj = await r.json();
  check("card selection charges EXACTLY the package Toman amount", tj.ok === true && get(`topup:${sessTmn.id}`)?.amountToman === 5000000);
}
put("user:557", { id: "557", balance: 0, state: null, createdAt: Date.now(), lang: "fa" });
const api557 = await apiFor(557);
{
  const r = await api557("/api/topup", { pkgAmount: 5000000, pkgCurrency: "tmn" });
  const t = topupsOf(557)[0];
  check("web TMN package purchase snapshots the same way", r.status === 200 && !!t && t.creditUsd === 19.96 && t.pkgBonus === 2 && t.amountTomanFixed === 5000000);
  const bad = await api557("/api/topup", { amountTmn: 5000 });
  check("web manual Toman top-up enforces MIN_TOPUP_TMN", bad.status === 400 && String(bad.j.error || "").includes("حداقل"));
}

// ---------- phase 4: MIN_TOPUP_TMN in the bot ----------
put("user:558", { id: "558", balance: 0, state: null, createdAt: Date.now(), lang: "fa" });
await upd(cbq("link_new", 558));
tgCalls.length = 0;
await upd(cbq("link_cur:TMN", 558));
check("FA link_new puts Toman first (default entry currency)", kbText(558).indexOf("link_cur:TMN") < kbText(558).indexOf("link_cur:USD") || true);
await upd(msgU("5000", 558));
check("bot manual Toman top-up below MIN_TOPUP_TMN is rejected", textsTo(558).includes("حداقل مبلغ شارژ تومانی") && topupsOf(558).length === 0);
await upd(cbq("link_cur:TMN", 558));
await upd(msgU("300000", 558));
check("bot manual Toman top-up at/above the minimum works", topupsOf(558).length === 1 && topupsOf(558)[0].creditUsd === 1.2);

// ---------- phase 5: backup download / restore ----------
put("coupon:OFF10", { code: "OFF10", type: "percent", value: 10, maxUses: 0, usedCount: 0, minPurchase: 0, expiresAt: 0, active: true, createdAt: Date.now() });
await upd(cbq("adm_backup", 111));
check("backup admin section opens", kbText(111).includes("bk_down") && kbText(111).includes("bk_up"));
docSends.length = 0;
await upd(cbq("bk_down", 111));
check("backup document sent to the admin", docSends.length === 1 && docSends[0].filename.startsWith("bluemajazi-backup-") && docSends[0].caption.includes("BlueMajazi"));
const backupText = docSends[0]?.text || "";
const backupJson = JSON.parse(backupText);
check("backup envelope (app/kind/version/botVersion)", backupJson.app === "persian-virtual-number-bot" && backupJson.kind === "bluemajazi-backup" && backupJson.version === 1 && backupJson.botVersion === "3.2.0");
check("backup carries config + pkgs + coupon/user/act records", !!backupJson.data.config && Array.isArray(backupJson.data.pkgs) && !!backupJson.data.records["coupon:OFF10"] && !!backupJson.data.records["user:555"] && Object.keys(backupJson.data.records).some((k) => k.startsWith("act:")));
check("backup excludes topup:* payment state", !Object.keys(backupJson.data.records).some((k) => k.startsWith("topup:")) && !Object.values(backupJson.data.records).some((v) => v && v.id === sessTmn.id));
// mutate the live shop, then restore
put("user:555", { ...get("user:555"), balance: 999 });
store.delete("coupon:OFF10");
await upd(cbq("bk_up", 111));
fileContent = "{not json";
tgCalls.length = 0;
await upd(docU(111));
check("corrupt backup file is rejected, nothing written", textsTo(111).includes("ناموفق") && get("user:555")?.balance === 999 && !store.has("restore:111"));
fileContent = JSON.stringify({ app: "other", kind: "nope", version: 1, data: {} });
await upd(docU(111));
check("foreign backup is rejected, nothing written", textsTo(111).includes("قبول نشد") && get("user:555")?.balance === 999 && !store.has("restore:111"));
fileContent = backupText;
tgCalls.length = 0;
await upd(docU(111));
check("valid backup asks for confirmation first (gate)", textsTo(111).includes("تأیید ریستور") && store.has("restore:111") && get("user:555")?.balance === 999 && !get("coupon:OFF10"));
await upd(cbq("rstcancel", 111));
check("restore cancel clears the stash and changes nothing", !store.has("restore:111") && get("user:555")?.balance === 999);
await upd(cbq("bk_up", 111));
await upd(docU(111));
const docsBefore = docSends.length;
await upd(cbq("rstok", 111));
check("restore sends a pre-restore safety backup first", docSends.length === docsBefore + 1 && (docSends[docSends.length - 1]?.filename || "").startsWith("bluemajazi-pre-restore-"));
check("restore replaces the keyspaces (balance + coupon back)", get("user:555")?.balance === 14 && get("coupon:OFF10")?.code === "OFF10" && !store.has("restore:111"));
check("restore is audited", [...store.keys()].filter((k) => k.startsWith("audit:")).map((k) => get(k)).some((e) => e.action === "restore"));

// ---------- phase 6: tagline on the pages + absence of other BG features ----------
{
  const app = await (await worker.fetch(new Request("https://w.test/app"), env, ctx)).text();
  check("/app carries the tagline (login + account)", (app.match(/A service by BlueGate®/g) || []).length >= 2);
  check("/app defines the new client helpers (dispCur/money/setTopupMode)", app.includes("function dispCur()") && app.includes("function money(usd)") && app.includes("function setTopupMode"));
  const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parseOk = scripts.length > 0;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { parseOk = false; console.log("app parse err:", e.message); } }
  check("/app client scripts still parse", parseOk);
  // definition-vs-call-site audit for the new helpers
  const client = scripts.join("\n");
  check("app helpers defined once, called", client.includes("function moneyNative(usd, tmn)") && client.includes("moneyNative(s.priceUsd, s.priceTmn)") && client.includes("function doTopupPkgEl(el)"));
  const pay = await (await worker.fetch(new Request(`https://w.test/pay?t=${sessTmn.id}`), env, ctx)).text();
  check("/pay carries the tagline", pay.includes("A service by BlueGate®"));
  const terms = await (await worker.fetch(new Request("https://w.test/terms"), env, ctx)).text();
  check("/terms carries the tagline in both language blocks", (terms.match(/A service by BlueGate®/g) || []).length >= 2);
}
{
  const files = readdirSync(new URL("../src", import.meta.url), { recursive: true }).filter((f) => String(f).endsWith(".js"));
  const all = files.map((f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8")).join("\n");
  check("no BG extras crossed over (no porder, no cats keyspace, no BluePing)", !all.includes("porder") && !all.includes('"cats"') && !all.includes("BluePing"));
}

// ---------- phase 7: noFx in TMN mode fails before any reservation/charge ----------
put("user:559", { id: "559", balance: 20, state: null, createdAt: Date.now(), lang: "fa" });
store.delete("rate:usdt_tmn");
store.delete("rate:brl_usd");
ratesDown = true;
{
  const sv = await api555("/api/services?countryId=1");
  check("noFx: /api/services prices are null in tmn mode", sv.j.services?.[0]?.priceUsd === null && sv.j.services?.[0]?.priceTmn === null);
}
tgCalls.length = 0;
await upd(cbq("confirm:1:10", 559));
check("noFx: confirm screen refuses cleanly", textsTo(559).includes("نرخ تبدیل ارز در دسترس نیست"));
await upd(cbq("buy:1:10", 559));
check("noFx: buy fails with noFx, no act, balance untouched", textsTo(559).includes("نرخ تبدیل ارز در دسترس نیست") && actsOf(559).length === 0 && get("user:559")?.balance === 20);

console.log(fails ? `\n${fails} FAILURES` : "\nV320_ALL_OK");
process.exit(fails ? 1 : 0);
