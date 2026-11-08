// v3.1.4 — two fixes found by driving the real app in an iPhone emulator:
// (1) hapState() was CALLED by renderMe/toggleHaptics but never DEFINED
// (missing since v3.1.0) — every render threw a ReferenceError. It is
// defined now. (2) The v3.1.4 scroll jail itself fought the user: it
// pinned scrollY for 450ms after every tap. The jail is gone; instead
// the hidden switch is position:absolute and re-synced to the current
// scroll offset before every tick (_iosSync), so iOS focusing it cannot
// move the page, and it is blurred after the burst.
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

ok("app hapState has no undefined helper deps", !html.includes("hapticsOn"));
ok("app showApp navigates only on first show", html.includes("firstShow"));
ok("app boot is single-flight", html.includes("_booting"));
ok("app defines hapState", html.includes("function hapState(){"));
ok("app switch syncs to scroll position", html.includes("function _iosSync()") && html.includes("_iosSync(); _iosLab.click();"));
ok("app switch is absolutely positioned", html.includes("position:absolute;left:0;top:0;"));
ok("app has no scroll jail left", !html.includes("_jailArm") && !html.includes("_jailY"));
ok("app iosHap is gesture-gated", html.includes("Date.now() - _lastGest > 800"));
  ok("app blurs the switch after ticks", html.includes("document.activeElement === _iosInp"));
  ok("app stamps gestures on pointerdown", html.includes("_lastGest = Date.now(); var t = e.target"));
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
ok("pay switch syncs to scroll position", html.includes("function _iosSync()") && html.includes("_iosSync();_iosLab.click();"));
ok("pay has no scroll jail left", !html.includes("_jailArm") && !html.includes("_jailY"));
ok("pay iosHap is gesture-gated", html.includes("_lastGest>800"));
  ok("pay blurs the switch after ticks", html.includes("document.activeElement===_iosInp"));
  ok("pay switch input lives inside its label", html.includes("lab.appendChild(inp)"));
  ok("pay has global pointerdown tap haptics", html.includes("addEventListener('pointerdown'") && html.includes("closest('button, a')"));
  ok("pay hap dedupes within 250ms", html.includes("hap._t[kind]"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((x) => x.trim().length > 30);
  let parsed = 0;
  for (const sc of scripts) { new Function(sc); parsed++; }
  ok("pay scripts still parse (" + parsed + ")", parsed >= 1);
}
console.log(fail === 0 ? "V314_ALL_OK" : "V314_FAILURES=" + fail);
process.exit(fail ? 1 : 0);
