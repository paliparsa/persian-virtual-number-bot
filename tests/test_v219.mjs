// v2.19.0 — web orders/payments pagination (10/page) + filter drawer; /pay mobile method amounts.
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
put("config", { WALLET_TRX: "TGWebkNU8jH4PqRNBATGPw5pLhBxcu9A8C" });
put("user:555", { id: "555", balance: 30, state: null, createdAt: Date.now(), lang: "fa" });
put("topup:t-s", { id: "t-s", userId: "555", creditUsd: 25, method: "session", status: "pending", createdAt: Date.now() });
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const worker = (await import("../src/index.js")).default;
const get = async (path) => worker.fetch(new Request("https://w.test" + path), env, ctx);
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };

const app = await (await get("/app")).text();
check("pagination + filter machinery present", app.includes("function pagerHtml") && app.includes("function openFilterSheet") && app.includes("function renderOrders") && app.includes("function renderPays") && app.includes("ORD_FILTERS") && app.includes("PAY_FILTERS"));
check("filter labels (orders + payments)", app.includes("پایان‌یافته") && app.includes("در حال تکمیل") && app.includes("شارژ شده") && app.includes("در انتظار"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("app script err:", e.message); } }
check("app scripts parse", ok);

// evaluate the pure helpers out of the client script
const client = scripts[scripts.length - 1];
function grab(name) {
  const i = client.indexOf("function " + name + "(");
  if (i < 0) return "";
  let depth = 0, j = client.indexOf("{", i);
  const start = j;
  for (; j < client.length; j++) { if (client[j] === "{") depth++; else if (client[j] === "}") { depth--; if (!depth) break; } }
  return client.slice(i, j + 1);
}
const prelude = "var S={lang:'fa'};function W(fa,en){return S.lang==='en'?en:fa}function faN(n){return String(n)}";
const sandbox = new Function(prelude + grab("ordCat") + grab("payCat") + grab("pagerHtml") + "; return { ordCat, payCat, pagerHtml };")();
check("ordCat mapping", sandbox.ordCat("finished") === "done" && sandbox.ordCat("codeReceived") === "done" && sandbox.ordCat("waitingSms") === "progress" && sandbox.ordCat("resendRequested") === "progress" && sandbox.ordCat("cancelled") === "cancelled" && sandbox.ordCat("expired") === "cancelled" && sandbox.ordCat("refunded") === "cancelled");
check("payCat mapping", sandbox.payCat({ status: "approved" }) === "done" && sandbox.payCat({ status: "pending" }) === "progress" && sandbox.payCat({ status: "rejected" }) === "cancelled" && sandbox.payCat({ status: "expired" }) === "cancelled");
check("pager: hidden for 1 page", sandbox.pagerHtml("orders", 1, 1) === "");
check("pager: 2 pages no ellipsis", sandbox.pagerHtml("orders", 1, 2).includes('data-kind="orders"') && sandbox.pagerHtml("orders", 1, 2).includes('data-p="2"') && !sandbox.pagerHtml("orders", 1, 2).includes("pgdots"));
check("pager: windowed with ellipsis", sandbox.pagerHtml("orders", 5, 9).includes("pgdots") && sandbox.pagerHtml("orders", 5, 9).includes("pgbtn on"));

// 18 orders -> 2 pages of 10 + 8 logic is pure slicing; verify the slice constants exist in renderers
check("page size is 10 in both renderers", (client.match(/\/ 10\)/g) || []).length >= 2 && client.includes("(S.ordPage - 1) * 10") && client.includes("(S.payPage - 1) * 10"));

// /pay mobile: method amounts no longer hidden
const pay = await (await get("/pay?t=t-s")).text();
check("pay mobile shows method amounts", !pay.includes(".method .ap{display:none}") && pay.includes("flex:1 1 100%"));

console.log(fails ? `\n${fails} FAILURES` : "\nV219_ALL_OK");
process.exit(fails ? 1 : 0);
