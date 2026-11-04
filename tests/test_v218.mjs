// v2.18.0 — /pay page, /terms page and the web referral card follow the chosen language.
const store = new Map();
const put = (k, v) => store.set(k, JSON.stringify(v));
const kv = {
  async get(k, opts) { const v = store.get(k); if (v === undefined) return null; return (opts === "json" || (opts && opts.type === "json")) ? JSON.parse(v) : v; },
  async put(k, v, opts) { if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV ttl"); store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" }; },
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    if (method === "getMe") return json({ ok: true, result: { id: 42, username: "testbot" } });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("core.smsfullbot.com")) return json({ spendable: 500, balance: 500, currency: "BRL" });
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("config", { CARD_NUMBER: "6037991234567890", CARD_HOLDER: "Reza Test", CARD_BANK: "Melli", WALLET_TRX: "TGWebkNU8jH4PqRNBATGPw5pLhBxcu9A8C" });
put("user:555", { id: "555", balance: 30, state: null, createdAt: Date.now(), lang: "en" });
put("user:556", { id: "556", balance: 30, state: null, createdAt: Date.now(), lang: "fa" });
const now = Date.now();
put("topup:t-en", { id: "t-en", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: now });
put("topup:t-fa", { id: "t-fa", userId: "556", creditUsd: 25, method: "session", status: "pending", createdAt: now });
put("topup:t-card", { id: "t-card", userId: "555", creditUsd: 25, method: "card", status: "pending", createdAt: now, amountToman: 6262500 });
put("topup:t-ok", { id: "t-ok", userId: "555", creditUsd: 25, bonusUsd: 1, method: "crypto", status: "approved", createdAt: now });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const worker = (await import("../src/index.js")).default;
const get = async (path) => { const r = await worker.fetch(new Request("https://w.test" + path), env, ctx); await drain(); return r; };
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

// /pay follows the topup owner's bot language
{
  const html = await (await get("/pay?t=t-en")).text();
  check("EN pay: english method view + ltr", html.includes("Choose a payment method") && html.includes('dir="ltr"') && html.includes("Card-to-card"));
  check("EN pay: no FA heading", !html.includes("روش پرداخت را انتخاب کنید"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("pay script err:", e.message); } }
  check("EN pay: scripts parse", ok);
}
{
  const html = await (await get("/pay?t=t-fa")).text();
  check("FA pay stays persian + rtl", html.includes("روش پرداخت را انتخاب کنید") && html.includes('dir="rtl"'));
}
{
  const html = await (await get("/pay?t=t-fa&lang=en")).text();
  check("lang param overrides owner language", html.includes("Choose a payment method"));
}
{
  const html = await (await get("/pay?t=t-card")).text();
  check("EN card view", html.includes("Card-to-card") && html.includes("Copy card number") && html.includes("Submit receipt") && html.includes("Exact amount to send"));
}
{
  const html = await (await get("/pay?t=t-ok")).text();
  check("EN approved view with bonus line", html.includes("Payment approved") && html.includes("package bonus") && html.includes("Current balance"));
}
{
  const html = await (await get("/pay")).text();
  check("pay intro defaults + autosync hook", html.includes("_ps='default'") && html.includes("flipPayLang"));
}
{
  const r = await get("/pay/status?t=t-fa&lang=en");
  const j = await r.json();
  check("pay status toman in english", typeof j.toman === "string" && j.toman.includes("Toman") && /[0-9]/.test(j.toman));
}
// /terms bilingual
{
  const html = await (await get("/terms")).text();
  check("terms has both languages + toggle", html.includes('data-lang="en"') && html.includes("Terms and Conditions") && html.includes("flipTermsLang") && html.includes("Refunds"));
  check("terms keeps FA + BlueGate brand", html.includes("بازگشت وجه") && html.includes("BlueGate") && !html.toLowerCase().includes("smsfull"));
  const hen = await (await get("/terms?lang=en")).text();
  check("terms ?lang=en preselects english", hen.includes("window._tl='en'"));
}
// referral card in the web app
{
  const html = await (await get("/app")).text();
  check("referral card sentence is translatable", html.includes('data-i="refSub1"') && html.includes('data-i="refSub2"'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("app script err:", e.message); } }
  check("app scripts still parse", ok);
}

console.log(fails ? `\n${fails} FAILURES` : "\nV218_ALL_OK");
process.exit(fails ? 1 : 0);
