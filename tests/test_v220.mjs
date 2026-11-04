// v2.20.0 — liquid-glass tab bar: press-and-drag lens navigation.
const store = new Map();
const kv = {
  async get(k, opts) { const v = store.get(k); if (v === undefined) return null; return (opts === "json" || (opts && opts.type === "json")) ? JSON.parse(v) : v; },
  async put(k, v, opts) { if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV ttl"); store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" }; },
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async () => json({});
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x", WEBHOOK_SECRET: "s3cr3t" };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const worker = (await import("../src/index.js")).default;
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) fails++; };
const app = await (await worker.fetch(new Request("https://w.test/app"), env, ctx)).text();
check("lens element inside nav", app.includes('class="navlens" id="navLens"'));
check("lens glass CSS", app.includes(".navlens{") && app.includes("saturate(190%)") && app.includes(".nav.dragging .on{") && app.includes(".nav button.lift svg{"));
check("nav touch-action none", app.includes(".nav{touch-action:none"));
check("drag handlers wired", app.includes("pointerdown") && app.includes("pointermove") && app.includes("pointerup") && app.includes("pointercancel") && app.includes("setPointerCapture"));
check("settle navigates via showView + click suppressed once", app.includes("showView(btn.getAttribute('data-nav'))") && app.includes("suppress"));
check("terms link excluded from drag", app.includes("e.target.closest('a')"));
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let ok = true; for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log("app script err:", e.message); } }
check("app scripts parse", ok);
console.log(fails ? `\n${fails} FAILURES` : "\nV220_ALL_OK");
process.exit(fails ? 1 : 0);
