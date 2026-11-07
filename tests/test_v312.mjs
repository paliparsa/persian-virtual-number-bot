// v3.1.2 — iOS haptics, second attempt + haptics on every button: the hidden
// switch now lives inside its label (the recipe that produces the tick),
// the first tick fires synchronously, a capture-phase pointerdown listener
// gives EVERY button/link a tap haptic inside the genuine gesture, and
// hap() dedupes repeated kinds within 250ms so wired calls don't double up.
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o === "json" || (o && o.type === "json")) ? JSON.parse(v) : v; }, async put(k, v, o) { if (o && o.expirationTtl !== undefined && o.expirationTtl < 60) throw new Error("ttl"); store.set(k, String(v)); }, async delete(k) { store.delete(k); }, async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    if (opts.body instanceof FormData) return json({ ok: true, result: { message_id: 7, photo: [{ file_id: "f1" }] } });
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

{
  const r = await worker.fetch(new Request("https://w.test/health"), env, ctx);
  const d = await r.json();
  ok("health reports a 3.x version", !!d.version && d.version.startsWith("3."));
}
{
  const r = await worker.fetch(new Request("https://w.test/app"), env, ctx);
  const html = await r.text();
  ok("app hap falls back to iosHap on iOS", html.includes("iosHap(kind)"));
  ok("app iosHap defined", html.includes("function iosHap(kind)"));
  ok("app creates a switch input", html.includes("setAttribute('switch', '')"));
  ok("app detects iPhone/iPad UA", html.includes("/iPhone|iPad|iPod/"));
  ok("app detects iPad desktop UA", html.includes("navigator.maxTouchPoints > 1"));
  ok("app switch is click-driven via label", html.includes("_iosLab.click()"));
  ok("app hapD text updated for iOS 17.4", html.includes("iOS 17.4 or later"));

  ok("app switch input lives inside its label", html.includes("lab.appendChild(inp)"));
  ok("app iOS tick fires directly", html.includes("_iosLab.click();"));
  ok("app has global pointerdown tap haptics", html.includes("addEventListener('pointerdown'") && html.includes("closest('button, a')"));
  ok("app hap dedupes within 250ms", html.includes("hap._t[kind]"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parsed = 0;
  for (const sc of scripts) { new Function(sc); parsed++; }
  ok("app scripts still parse (" + parsed + ")", parsed >= 1);
}
{
  const r = await worker.fetch(new Request("https://w.test/pay?t=t1"), env, ctx);
  const html = await r.text();
  ok("pay hap falls back to iosHap on iOS", html.includes("iosHap(kind)"));
  ok("pay iosHap defined", html.includes("function iosHap(kind)"));
  ok("pay creates a switch input", html.includes("setAttribute('switch','')"));
  ok("pay switch input lives inside its label", html.includes("lab.appendChild(inp)"));
  ok("pay has global pointerdown tap haptics", html.includes("addEventListener('pointerdown'") && html.includes("closest('button, a')"));
  ok("pay hap dedupes within 250ms", html.includes("hap._t[kind]"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parsed = 0;
  for (const sc of scripts) { new Function(sc); parsed++; }
  ok("pay scripts still parse (" + parsed + ")", parsed >= 1);
}
console.log(fail === 0 ? "V312_ALL_OK" : "V312_FAILURES=" + fail);
process.exit(fail ? 1 : 0);
