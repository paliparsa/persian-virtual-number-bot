// Produce a real export file to disk, then validate with python zipfile+xml.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o === "json" || (o && o.type === "json")) ? JSON.parse(v) : v; }, async put(k, v, o) { if (o && o.expirationTtl !== undefined && o.expirationTtl < 60) throw new Error("ttl"); store.set(k, String(v)); }, async delete(k) { store.delete(k); }, async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    if (opts.body instanceof FormData) { const d = opts.body.get("document"); writeFileSync("/tmp/export.xlsx", Buffer.from(await d.arrayBuffer())); return json({ ok: true, result: {} }); }
    const b = opts.body ? JSON.parse(opts.body) : {};
    if (u.endsWith("getMe")) return json({ ok: true, result: { username: "testbot" } });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("smsfullbot")) return json([{ id: 1, name: "Brasil", emoji: "🇧🇷" }]);
  if (u.includes("wallex")) return json({}, 403);
  if (u.includes("exir")) return json({ "usdt-irt": { bids: [["250000"]], asks: [["251000"]] } });
  return json({});
};
store.set("config", "{}");
store.set("topup:t1", JSON.stringify({ id: "t1", userId: "5", method: "crypto", crypto: "USDT_TRC20", status: "approved", creditUsd: 50, bonusUsd: 4, createdAt: Date.now(), paidTxid: "abc123" }));
store.set("act:a1", JSON.stringify({ id: "a1", userId: "5", price: 6, providerPriceBrl: 25, phoneNumber: "5511999", serviceName: "WhatsApp", countryId: 1, status: "finished", latestCode: "999", createdAt: Date.now(), charged: true }));
const env = { STORE: kv, TELEGRAM_BOT_TOKEN: "T", ADMIN_CHAT_ID: "111", SMSFULL_API_KEY: "x" };
const pending = []; const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
const worker = (await import("../src/index.js")).default;
await worker.fetch(new Request("https://w.test/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ update_id: 1, callback_query: { id: "q", data: "adm_export", from: { id: 111, first_name: "A" }, message: { message_id: 1, date: 0, chat: { id: 111, type: "private" } } } }) }), env, ctx);
while (pending.length) await Promise.all(pending.splice(0));
console.log(execSync("python3 -c \"import zipfile,xml.dom.minidom as md; z=zipfile.ZipFile('/tmp/export.xlsx'); print('names:',z.namelist()); [md.parseString(z.read(n)) for n in z.namelist() if n.endswith('.xml') or n.endswith('.rels')]; print('ALL_XML_WELL_FORMED'); print(z.read('xl/worksheets/sheet2.xml').decode()[:300])\"").toString());
