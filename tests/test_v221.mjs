// v2.21.0 — avatar opens Account, no login flash (splash gate), /pay state views get a home button.
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
  if (u.includes("api.telegram.org")) return json({ ok: true, result: { message_id: 1, username: "testbot" } });
  if (u.includes("api.wallex.ir")) return json({}, 403);
  if (u.includes("api.exir.io")) return json({ "usdt-irt": { bids: [["250000", "1"]], asks: [["251000", "1"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
put("user:555", { id: "555", balance: 30, state: null, createdAt: Date.now(), lang: "en" });
put("user:556", { id: "556", balance: 30, state: null, createdAt: Date.now(), lang: "fa" });
const now = Date.now();
put("topup:t-ok-en", { id: "t-ok-en", userId: "555", creditUsd: 25, bonusUsd: 1, method: "crypto", status: "approved", createdAt: now });
put("topup:t-ok-fa", { id: "t-ok-fa", userId: "556", creditUsd: 25, method: "crypto", status: "approved", createdAt: now });
put("topup:t-rej", { id: "t-rej", userId: "555", creditUsd: 25, method: "card", status: "rejected", createdAt: now });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const worker = (await import("../src/index.js")).default;
const get = async (path) => worker.fetch(new Request("https://w.test" + path), env, ctx);
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

const app = await (await get("/app")).text();
check("splash present + login hidden by default", app.includes('id="splash"') && app.includes('<div id="viewLogin" style="display:none">'));
check("splash hidden by showLogin/showApp", app.includes("function hideSplash()") && app.includes("function showLogin(){ hideSplash();") && app.includes("function showApp(){ hideSplash();"));
check("header avatar opens account (not logout)", app.includes('id="hdrAva" title="حساب کاربری" onclick="showView(\'account\')"') && app.includes("ava.title = W('حساب کاربری', 'Account');"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("app script err:", e.message); } }
check("app scripts parse", ok);

const okEn = await (await get("/pay?t=t-ok-en")).text();
check("EN approved pay has home button", okEn.includes('href="/app"') && okEn.includes("Back to home"));
const okFa = await (await get("/pay?t=t-ok-fa")).text();
check("FA approved pay has home button", okFa.includes('href="/app"') && okFa.includes("بازگشت به صفحه اصلی"));
const rej = await (await get("/pay?t=t-rej")).text();
check("rejected pay has home button too", rej.includes('href="/app"') && rej.includes("Back to home"));

console.log(fails ? `\n${fails} FAILURES` : "\nV221_ALL_OK");
process.exit(fails ? 1 : 0);
