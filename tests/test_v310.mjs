// v3.1.0 — web motion system + haptics: animation tokens/keyframes, staggered
// lists, press states, splash fade, hap() utility + wiring, Account toggle,
// /pay haptics + press states, reduced-motion support, version bump.
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o === "json" || (o && o.type === "json")) ? JSON.parse(v) : v; }, async put(k, v, o) { if (o && o.expirationTtl !== undefined && o.expirationTtl < 60) throw new Error("ttl"); store.set(k, String(v)); }, async delete(k) { store.delete(k); }, async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    if (opts.body instanceof FormData) return json({ ok: true, result: { message_id: 7, photo: [{ file_id: "f1" }] } });
    const b = opts.body ? JSON.parse(opts.body) : {};
    if (u.endsWith("getMe")) return json({ ok: true, result: { username: "testbot" } });
    if (u.endsWith("getWebhookInfo")) return json({ ok: true, result: { url: "https://w.test/webhook", pending_update_count: 0 } });
    if (u.endsWith("getChatMember")) return json({ ok: true, result: { status: "member" } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("smsfullbot")) {
    if (u.includes("/countries")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
    if (u.includes("/balance")) return json({ spendable: 500, balance: 500, currency: "BRL" });
    return json([]);
  }
  if (u.includes("wallex")) return json({}, 403);
  if (u.includes("exir")) return json({ "usdt-irt": { bids: [["250000"]], asks: [["251000"]] } });
  if (u.includes("open.er-api.com")) return json({ rates: { USD: 0.2 } });
  return json({});
};
store.set("config", "{}");
store.set("topup:t1", JSON.stringify({ id: "t1", userId: "555", creditUsd: 25, status: "pending", method: "session", createdAt: Date.now() }));
const worker = (await import("../src/index.js")).default;
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { promises: [], waitUntil(p) { this.promises.push(p); } };
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("ok  ", name); } else { fail++; console.log("FAIL", name); } };

// /health shows the new version
{
  const r = await worker.fetch(new Request("https://w.test/health"), env, ctx);
  const d = await r.json();
  ok("health version is 3.1.0", d.version === "3.1.0");
}

// /app page: motion + haptics surface
{
  const r = await worker.fetch(new Request("https://w.test/app"), env, ctx);
  const html = await r.text();
  ok("app has vin keyframe (view transition)", html.includes("@keyframes vin"));
  ok("app has liin keyframe (list stagger)", html.includes("@keyframes liin"));
  ok("app stagger targets country rows", html.includes("#cGrid .country"));
  ok("app stagger targets order rows", html.includes("#ordList .hrow"));
  ok("app stagger targets pay rows", html.includes("#payHist .hrow"));
  ok("app has press state for primary buttons", html.includes(".wbtn:active"));
  ok("app respects prefers-reduced-motion", html.includes("prefers-reduced-motion"));
  ok("splash fades (fade class in hideSplash)", html.includes("classList.add('fade')"));
  ok("hap() utility present", html.includes("function hap(kind)"));
  ok("hap uses navigator.vibrate", html.includes("navigator.vibrate"));
  ok("hap uses Telegram HapticFeedback when available", html.includes("HapticFeedback"));
  ok("hap success pattern wired in doBuy", html.includes("hap('ok'); S.couponData = null"));
  ok("hap selection wired in showView", html.includes("S.view !== name) hap('sel')"));
  ok("hap selection wired in openSheet", html.includes("classList.add('open'); hap('sel')"));
  ok("haptics setting key bm_haptics", html.includes("bm_haptics"));
  ok("account haptics card present", html.includes('id="hapCard"') && html.includes('id="hapBtn"'));
  ok("toggleHaptics present", html.includes("function toggleHaptics()"));
  ok("hapT/hapD i18n keys present", html.includes("hapT:[") && html.includes("hapD:["));
  // every inline script parses
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parsed = 0;
  for (const sc of scripts) { new Function(sc); parsed++; }
  ok("all app inline scripts parse (" + parsed + ")", parsed >= 1);
}

// /pay page: haptics + press states
{
  const r = await worker.fetch(new Request("https://w.test/pay?t=t1"), env, ctx);
  const html = await r.text();
  ok("pay has hap() utility", html.includes("function hap(kind)"));
  ok("pay method select fires selection haptic", html.includes("selectMethod(m){hap('sel')"));
  ok("pay copy fires tap haptic", html.includes("done=function(){hap('tap')"));
  ok("pay approved poll fires success haptic", html.includes("d.status==='approved')hap('ok')"));
  ok("pay cancel confirm fires medium haptic", html.includes("doCancelPay(btn){hap('med')"));
  ok("pay receipt submit fires tap haptic", html.includes("submitReceipt(btn){hap('tap')"));
  ok("pay buttons have press state", html.includes(".btn:active{transform:scale(.97)}"));
  ok("pay respects prefers-reduced-motion", html.includes("prefers-reduced-motion"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parsed = 0;
  for (const sc of scripts) { new Function(sc); parsed++; }
  ok("all pay inline scripts parse (" + parsed + ")", parsed >= 1);
}

console.log(fail === 0 ? "V310_ALL_OK" : "V310_FAILURES=" + fail);
process.exit(fail ? 1 : 0);
