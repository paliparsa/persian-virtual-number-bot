// Persian Telegram bot selling virtual numbers via the SmsFull API.
// Runs as a single Cloudflare Worker. Storage: one KV namespace bound as STORE.
// All user-facing bot text is in Persian (fa). Admin texts are Persian too.
//
// Required secrets (Cloudflare dashboard > Worker > Settings > Variables):
//   TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, SMSFULL_API_KEY
// Optional: WEBHOOK_SECRET, PRICE_MARKUP_PERCENT (default 20),
//   CARD_NUMBER, CARD_HOLDER, CARD_BANK (Toman rate is automatic via Wallex),
//   WALLET_USDT_TRC20, WALLET_TRX, WALLET_BTC, WALLET_TON, WALLET_LTC,
//   WALLET_ETH, WALLET_USDT_ERC20, ETHERSCAN_API_KEY, SUPPORT_CHAT_ID/USERNAME

const SMSFULL_BASE = "https://core.smsfullbot.com/api/v1";
const BOT_VERSION = "2.5.0"; // shown in the admin panel and /health — check you're on the latest deploy
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// USDT on BNB Smart Chain (BEP20). NOTE: 18 decimals on BSC, unlike TRC20/ERC20 (6).
const USDT_BSC_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";

// ---------- small helpers ----------
const faDigits = (v) => String(v).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
const enDigits = (v) => String(v).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
const faNum = (v, dec = 2) => {
  const n = Number(v || 0);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return faDigits(s);
};
const faInt = (v) => faDigits(Number(v || 0).toLocaleString("en-US"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const markup = (cfg) => 1 + (parseFloat(cfg?.PRICE_MARKUP_PERCENT || "20") / 100);
// Admin-set minimum top-up (USD). Falls back to $1 when unset/invalid.
const minTopupUsd = (cfg) => {
  const v = parseFloat(cfg?.MIN_TOPUP_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 1;
};
const sellPrice = (cfg, providerPrice) => Math.ceil(providerPrice * markup(cfg) * 100) / 100;
const isAdmin = (env, chatId) => String(chatId) === String(env.ADMIN_CHAT_ID || "");

// ---------- KV storage ----------
async function kvGet(env, key, fallback = null) {
  if (!env.STORE) return fallback;
  const v = await env.STORE.get(key, "json");
  return v ?? fallback;
}
async function kvPut(env, key, value, ttlSeconds) {
  if (!env.STORE) throw new Error("KV binding STORE is not configured");
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await env.STORE.put(key, JSON.stringify(value), opts);
}
async function kvList(env, prefix) {
  if (!env.STORE) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.STORE.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.STORE.get(k.name, "json");
      if (v) out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
// ---------- runtime config: editable by the admin inside Telegram ----------
// Values saved from the admin panel live in KV under "config" and override the
// Cloudflare variables of the same name (which now act only as initial defaults).
const CONFIG_KEYS = [
  "CARD_NUMBER", "CARD_HOLDER", "CARD_BANK", "TOMAN_PER_BRL",
  "WALLET_USDT_TRC20", "WALLET_TRX", "WALLET_BTC", "WALLET_TON",
  "WALLET_LTC", "WALLET_ETH", "WALLET_USDT_ERC20", "WALLET_USDT_BEP20",
  "SUPPORT_USERNAME", "WORKER_BASE_URL", "PRICE_MARKUP_PERCENT", "TMN_RATE_MANUAL", "GROUP_CHAT_ID", "MIN_TOPUP_USD",
  "FORCE_JOIN_ENABLED", "FORCE_JOIN_CHANNEL", "PHONE_VERIFY_ENABLED",
];
async function getConfig(env) {
  const stored = (await kvGet(env, "config")) || {};
  const cfg = {};
  for (const k of CONFIG_KEYS) cfg[k] = stored[k] ?? env[k] ?? "";
  if (!cfg.PRICE_MARKUP_PERCENT) cfg.PRICE_MARKUP_PERCENT = "20";
  cfg._stored = stored;
  return cfg;
}
async function setConfigValue(env, key, value) {
  const stored = (await kvGet(env, "config")) || {};
  if (value === "" || value === null) delete stored[key]; else stored[key] = value;
  await kvPut(env, "config", stored);
  return getConfig(env);
}

const getUser = async (env, id) =>
  (await kvGet(env, `user:${id}`)) || { id: String(id), balance: 0, state: null, createdAt: now() };
const saveUser = (env, u) => kvPut(env, `user:${u.id}`, u);

// ---------- Telegram API ----------
function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({}));
}
const send = (env, chatId, text, kb, parseMode = "HTML") =>
  tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: parseMode, reply_markup: kb });
const edit = (env, chatId, msgId, text, kb) =>
  tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: kb });
const answerCb = (env, id, text = "", alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });
const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, callback_data) => ({ text, callback_data });
const urlBtn = (text, url) => ({ text, url });

// ---------- automatic Telegram webhook setup ----------
// Sets the webhook to https://<this-worker's-domain>/webhook by itself.
// Runs when any non-webhook page is opened (/, /pay, /health, /setup) and
// again from the cron job using the last seen / configured public origin,
// so a changed domain or a deleted webhook heals without manual curl calls.
async function ensureWebhook(env, origin, force = false) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set" };
  if (!origin) return { ok: false, reason: "public origin unknown yet" };
  const target = `${String(origin).replace(/\/+$/, "")}/webhook`;
  try {
    const cached = await kvGet(env, "sys:webhook");
    if (!force && cached?.url === target && now() - cached.at < 6 * 3600 * 1000) {
      return { ok: true, url: target, cached: true };
    }
    const info = await tg(env, "getWebhookInfo", {});
    if (info?.result?.url !== target) {
      const body = { url: target, allowed_updates: ["message", "callback_query"] };
      if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
      const res = await tg(env, "setWebhook", body);
      if (!res?.ok) return { ok: false, url: target, telegram: res };
    }
    try { await kvPut(env, "sys:webhook", { url: target, at: now() }); } catch (_) {}
    return { ok: true, url: target };
  } catch (e) {
    return { ok: false, url: target, error: String(e?.message || e) };
  }
}
async function rememberOriginAndWebhook(env, origin) {
  try { await kvPut(env, "sys:origin", { origin, at: now() }); } catch (_) {}
  await ensureWebhook(env, origin);
}

// ---------- SmsFull API ----------
async function smsfull(env, path, opts = {}) {
  const r = await fetch(`${env.SMSFULL_BASE_URL || SMSFULL_BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${env.SMSFULL_API_KEY}`,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `SmsFull HTTP ${r.status}`);
    err.code = data?.error?.code || "unknown";
    err.status = r.status;
    err.details = data?.error?.details;
    throw err;
  }
  return data;
}

// ---------- exchange rates ----------
// Shop currency is USD. Provider (SmsFull) prices arrive in BRL and are
// converted with a free daily FX rate. Toman equivalents come from Wallex:
// the USDT/TMN market (1 USDT ~= 1 USD), fetched live and cached 5 minutes.
const saveTmnDiag = async (env, diag) => { try { await kvPut(env, "diag:tmn", diag, 3600); } catch (_) {} };
// USDT/TMN rate. Primary: Wallex /v1/markets (lastPrice). Fallback: Wallex
// /v1/depth for USDTTMN (tiny payload — survives cases where the ~450KB
// markets response fails). Every outcome is recorded in diag:tmn and exposed
// via /health so a missing Toman price can be diagnosed from outside.
async function usdtTomanRate(env) {
  const cached = await kvGet(env, "rate:usdt_tmn");
  if (cached && now() - cached.at < 5 * 60 * 1000) return cached.v;
  const diag = { at: now() };
  try {
    const r = await fetch("https://api.wallex.ir/v1/markets");
    diag.marketsHttp = r.status;
    const d = await r.json().catch(() => ({}));
    const st = d?.result?.symbols?.USDTTMN?.stats || {};
    const v = Number(st.lastPrice || st.askPrice || st.bidPrice);
    if (v > 0) {
      diag.src = "wallex-markets"; diag.rate = v;
      await saveTmnDiag(env, diag);
      await kvPut(env, "rate:usdt_tmn", { v, at: now(), src: diag.src }, 900);
      return v;
    }
    diag.marketsError = "USDTTMN price missing in response";
  } catch (e) { diag.marketsError = String(e?.message || e); }
  try {
    const r = await fetch("https://api.wallex.ir/v1/depth?symbol=USDTTMN");
    diag.depthHttp = r.status;
    const d = await r.json().catch(() => ({}));
    const ask = Number(d?.result?.ask?.[0]?.price);
    const bid = Number(d?.result?.bid?.[0]?.price);
    const v = ask > 0 && bid > 0 ? Math.round((ask + bid) / 2) : (ask || bid);
    if (v > 0) {
      diag.src = "wallex-depth"; diag.rate = v;
      await saveTmnDiag(env, diag);
      await kvPut(env, "rate:usdt_tmn", { v, at: now(), src: diag.src }, 900);
      return v;
    }
    diag.depthError = "USDTTMN depth missing in response";
  } catch (e) { diag.depthError = String(e?.message || e); }
  try {
    // Exir order book (USDT/IRT, priced in Toman) — a different Iranian
    // exchange on different infrastructure; Wallex 403s Cloudflare Workers
    // egress IPs, Exir may still answer.
    const r = await fetch("https://api.exir.io/v2/orderbook?symbol=usdt-irt");
    diag.exirHttp = r.status;
    const d = await r.json().catch(() => ({}));
    const book = d?.["usdt-irt"] || {};
    const bid = Number(book.bids?.[0]?.[0]);
    const ask = Number(book.asks?.[0]?.[0]);
    const v = bid > 0 && ask > 0 ? Math.round((bid + ask) / 2) : (bid || ask);
    if (v > 10000) {
      diag.src = "exir"; diag.rate = v;
      await saveTmnDiag(env, diag);
      await kvPut(env, "rate:usdt_tmn", { v, at: now(), src: diag.src }, 900);
      return v;
    }
    diag.exirError = "usdt-irt book missing in response";
  } catch (e) { diag.exirError = String(e?.message || e); }
  // Operator-set manual rate (admin panel) beats a stale cache.
  const cfg = await getConfig(env).catch(() => null);
  const manual = Number(cfg?.TMN_RATE_MANUAL);
  if (manual > 0) {
    diag.src = "manual"; diag.rate = manual;
    await saveTmnDiag(env, diag);
    return manual;
  }
  diag.src = cached?.v ? "stale-cache" : "none";
  if (cached?.v) diag.rate = cached.v;
  await saveTmnDiag(env, diag);
  return cached?.v || null;
}

// Live Wallex reachability probe for /health (bypasses the rate cache).
async function probeWallex() {
  const probe = async (url, pick) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url);
      const d = await r.json().catch(() => null);
      const v = d ? pick(d) : null;
      return { ok: r.ok && !!v, http: r.status, rate: v || null, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, error: String(e?.message || e), ms: Date.now() - t0 }; }
  };
  const [markets, depth, exir] = await Promise.all([
    probe("https://api.wallex.ir/v1/markets", (d) => {
      const v = Number(d?.result?.symbols?.USDTTMN?.stats?.lastPrice);
      return v > 0 ? v : null;
    }),
    probe("https://api.wallex.ir/v1/depth?symbol=USDTTMN", (d) => {
      const v = Number(d?.result?.ask?.[0]?.price);
      return v > 0 ? v : null;
    }),
    probe("https://api.exir.io/v2/orderbook?symbol=usdt-irt", (d) => {
      const book = d?.["usdt-irt"] || {};
      const bid = Number(book.bids?.[0]?.[0]);
      const ask = Number(book.asks?.[0]?.[0]);
      const v = bid > 0 && ask > 0 ? Math.round((bid + ask) / 2) : (bid || ask);
      return v > 10000 ? v : null;
    }),
  ]);
  return { markets, depth, exir };
}
async function brlToUsdRate(env) {
  const cached = await kvGet(env, "rate:brl_usd");
  if (cached && now() - cached.at < 6 * 3600 * 1000) return cached.v;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/BRL");
    const d = await r.json();
    const v = Number(d?.rates?.USD);
    if (v > 0) { await kvPut(env, "rate:brl_usd", { v, at: now() }, 12 * 3600); return v; }
  } catch (_) {}
  return cached?.v || null;
}
const tomanOfUsd = (tmnRate, usd) => (tmnRate ? Math.round(Number(usd) * tmnRate) : null);
const faCompactToman = (t) => {
  if (t === null || t === undefined) return "";
  if (t >= 1e6) return `${faNum(t / 1e6)} میلیون تومان`;
  if (t >= 1e3) return `${faInt(Math.round(t / 1e3))} هزار تومان`;
  return `${faInt(t)} تومان`;
};
// "$3.20" plus, when the Wallex rate is known, " ≈ ۸۶۸ هزار تومان"
const usdText = (tmnRate, usd) => {
  const t = tomanOfUsd(tmnRate, usd);
  return `$${faNum(usd)}${t ? ` ≈ ${faCompactToman(t)}` : ""}`;
};
const topupCredit = (t) => Number(t.creditUsd ?? t.creditBrl ?? 0);

// ---------- crypto prices & on-chain checks ----------
// USD price of a coin, from several independent free sources.
// Why so many: this used to rely on CoinGecko alone, whose free API
// rate-limits (HTTP 429) the shared egress IPs of Cloudflare Workers very
// often — every failure aborted crypto top-ups with "price unavailable".
// Order: fresh cache -> USDT is a dollar stablecoin (no fetch needed) ->
// CoinGecko -> Coinbase -> Wallex (TMN price / USDT-TMN rate) -> stale cache.
const COINBASE_PAIR = { bitcoin: "BTC-USD", ethereum: "ETH-USD", tron: "TRX-USD", litecoin: "LTC-USD", "the-open-network": "TON-USD", tether: "USDT-USD" };
const WALLEX_TMN_SYMBOL = { bitcoin: "BTCTMN", ethereum: "ETHTMN", tron: "TRXTMN", litecoin: "LTCTMN", "the-open-network": "GRAMTMN" };
async function cryptoPriceUsd(env, coingeckoId) {
  const cacheKey = `priceUsd:${coingeckoId}`;
  const cached = await kvGet(env, cacheKey);
  if (cached && now() - cached.at < 5 * 60 * 1000) return cached.usd;
  const save = async (usd) => { try { await kvPut(env, cacheKey, { usd, at: now() }, 3600); } catch (_) {} return usd; };
  if (coingeckoId === "tether") return save(1); // 1 USDT = $1 by design
  try { // CoinGecko
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`);
    const d = await r.json().catch(() => ({}));
    const usd = Number(d?.[coingeckoId]?.usd);
    if (usd > 0) return save(usd);
  } catch (_) {}
  try { // Coinbase spot (no key)
    const pair = COINBASE_PAIR[coingeckoId];
    if (pair) {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
      const d = await r.json().catch(() => ({}));
      const usd = Number(d?.data?.amount);
      if (usd > 0) return save(usd);
    }
  } catch (_) {}
  try { // Wallex: coin/TMN divided by USDT/TMN
    const sym = WALLEX_TMN_SYMBOL[coingeckoId];
    const tmnRate = await usdtTomanRate(env);
    if (sym && tmnRate) {
      const r = await fetch("https://api.wallex.ir/v1/markets");
      const d = await r.json().catch(() => ({}));
      const last = Number(d?.result?.symbols?.[sym]?.stats?.lastPrice);
      if (last > 0) return save(last / tmnRate);
    }
  } catch (_) {}
  if (cached?.usd > 0) return cached.usd; // stale price beats no price
  throw new Error("priceUnavailable");
}

const CRYPTOS = {
  USDT_TRC20: { label: "تتر (TRC20)", envKey: "WALLET_USDT_TRC20", cg: "tether", decimals: 4 },
  USDT_BEP20: { label: "تتر (BEP20)", envKey: "WALLET_USDT_BEP20", cg: "tether", decimals: 4 },
  TRX: { label: "ترون (TRX)", envKey: "WALLET_TRX", cg: "tron", decimals: 3 },
  BTC: { label: "بیت‌کوین (BTC)", envKey: "WALLET_BTC", cg: "bitcoin", decimals: 8 },
  TON: { label: "تون (TON)", envKey: "WALLET_TON", cg: "the-open-network", decimals: 4 },
  LTC: { label: "لایت‌کوین (LTC)", envKey: "WALLET_LTC", cg: "litecoin", decimals: 5 },
  USDT_ERC20: { label: "تتر (ERC20)", envKey: "WALLET_USDT_ERC20", cg: "tether", decimals: 4 },
  ETH: { label: "اتریوم (ETH)", envKey: "WALLET_ETH", cg: "ethereum", decimals: 6 },
};
const configuredCryptos = (cfg) =>
  Object.entries(CRYPTOS).filter(([, c]) => cfg?.[c.envKey]);

// ---------- on-chain payment state ----------
// Returns "paid" (safe to credit), "seen" (a matching transaction exists on
// chain but is not confirmed yet — BTC/LTC only), or "none".
// Hardening (v1.3.1): BTC needs tx.status.confirmed (mempool.space) and LTC
// needs >= 1 BlockCypher confirmation before crediting, so an unconfirmed /
// replaceable transaction never tops a user up. TRX recipient is verified
// strictly: TronGrid reports to_address as hex (0x41-prefixed), so the
// wallet's Base58 address is decoded to hex and compared exactly — the same
// strictness the USDT-TRC20 branch has always had (t.to === addr).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function tronBase58ToHex(addr) {
  try {
    let n = 0n;
    for (const ch of String(addr || "").trim()) {
      const i = B58_ALPHABET.indexOf(ch);
      if (i < 0) return null;
      n = n * 58n + BigInt(i);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const body = [];
    if (n !== 0n) for (let i = 0; i < hex.length; i += 2) body.push(parseInt(hex.slice(i, i + 2), 16));
    let zeros = 0;
    const str = String(addr || "").trim();
    while (zeros < str.length && str[zeros] === "1") zeros++;
    const bytes = [...Array(zeros).fill(0), ...body];
    if (bytes.length !== 25) return null; // 21-byte payload + 4-byte checksum
    return bytes.slice(0, 21).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_) { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort KV lock: KV has no compare-and-swap, so acquiring means writing
// an owner token, waiting briefly for rival writes to land, then re-reading —
// only the writer whose token survived proceeds. This collapses the realistic
// races (cron vs check button vs admin approve vs double-tap) to one runner.
async function withKvLock(env, key, fn, ttlSec = 30) {
  if (!env.STORE) return fn();
  const lockKey = `lock:${key}`;
  const token = uid();
  try {
    const existing = await kvGet(env, lockKey);
    if (existing && existing.at && now() - existing.at < ttlSec * 1000) return undefined;
    await kvPut(env, lockKey, { token, at: now() }, ttlSec);
    await sleep(1200);
    const check = await kvGet(env, lockKey);
    if (!check || check.token !== token) return undefined;
    return await fn();
  } finally {
    try { const cur = await kvGet(env, lockKey); if (cur && cur.token === token) await kvDel(env, lockKey); } catch (_) {}
  }
}

// Best-effort fixed-window rate limit in KV (eventually consistent, so it
// damps abuse rather than guaranteeing an exact count).
async function throttle(env, key, limit, windowSec) {
  if (!env.STORE) return true;
  const bucket = Math.floor(now() / (windowSec * 1000));
  const k = `rl:${key}:${bucket}`;
  const cur = (await kvGet(env, k)) || { n: 0 };
  if (cur.n >= limit) return false;
  cur.n += 1;
  await kvPut(env, k, cur, windowSec * 2);
  return true;
}
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";
// Full diagnostics on /health and /setup are only shown to whoever knows the
// diag key (DIAG_KEY, or the webhook secret as a fallback).
const diagKeyOk = (env, url) => {
  const k = url.searchParams.get("k");
  return !!k && ((env.DIAG_KEY && k === env.DIAG_KEY) || (env.WEBHOOK_SECRET && k === env.WEBHOOK_SECRET));
};

// Candidate on-chain transfers TO this topup's wallet since the payment
// method (and with it the exact amount) was selected:
// [{ txid, amount (coin units), ts (unix sec), confirmed }].
async function findCryptoCandidates(env, topup) {
  const addr = topup.walletAddress;
  const sinceSec = Math.floor((topup.selectedAt || topup.createdAt) / 1000) - 30;
  const out = [];
  try {
    if (topup.crypto === "USDT_TRC20") {
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=50&contract_address=${USDT_TRC20_CONTRACT}`);
      const d = await r.json().catch(() => ({}));
      for (const t of d.data || []) {
        const ts = Math.floor(t.block_timestamp / 1000);
        if (t.to === addr && ts >= sinceSec) out.push({ txid: t.transaction_id, amount: Number(t.value) / 1e6, ts, confirmed: true });
      }
    } else if (topup.crypto === "TRX") {
      const wantHex = tronBase58ToHex(addr);
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50`);
      const d = await r.json().catch(() => ({}));
      for (const t of d.data || []) {
        const v = t.raw_data?.contract?.[0]?.parameter?.value;
        const ts = Math.floor(t.block_timestamp / 1000);
        if (wantHex && String(v?.to_address || "").toLowerCase() === wantHex && t.ret?.[0]?.contractRet === "SUCCESS" && ts >= sinceSec)
          out.push({ txid: t.transaction_id, amount: Number(v.amount || 0) / 1e6, ts, confirmed: true });
      }
    } else if (topup.crypto === "BTC") {
      const r = await fetch(`https://mempool.space/api/address/${addr}/txs`);
      const txs = await r.json().catch(() => []);
      for (const tx of Array.isArray(txs) ? txs : []) {
        const sat = (tx.vout || []).filter((o) => o.scriptpubkey_address === addr).reduce((a, o) => a + Number(o.value || 0), 0);
        if (sat <= 0) continue;
        // A confirmed block from before this payment existed can never be
        // this payment (the wallet may receive unrelated transfers too).
        const bt = tx.status?.block_time;
        if (bt && bt < sinceSec - 3600) continue;
        out.push({ txid: tx.txid, amount: sat / 1e8, ts: bt || Math.floor(now() / 1000), confirmed: !!tx.status?.confirmed });
      }
    } else if (topup.crypto === "TON") {
      const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(addr)}&limit=30&archival=false`);
      const d = await r.json().catch(() => ({}));
      for (const tx of d.result || []) {
        const msg = tx.in_msg;
        if (msg && Number(tx.utime) >= sinceSec)
          out.push({ txid: tx.transaction_id?.hash || `${tx.utime}:${tx.lt || ""}`, amount: Number(msg.value || 0) / 1e9, ts: Number(tx.utime), confirmed: true });
      }
    } else if (topup.crypto === "USDT_BEP20") {
      const rpcCall = async (rpc, method, params) => {
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message || "rpc error");
        return d.result;
      };
      const toTopic = "0x" + "0".repeat(24) + addr.replace(/^0x/i, "").toLowerCase();
      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const elapsedBlocks = Math.ceil((now() - topup.createdAt) / 3000) + 300;
      const span = Math.min(Math.max(elapsedBlocks, 600), 5000);
      for (const rpc of ["https://bsc-dataseed.bnbchain.org", "https://bsc.publicnode.com", "https://bsc-dataseed1.defibit.io"]) {
        try {
          const latest = parseInt(await rpcCall(rpc, "eth_blockNumber", []), 16);
          const logs = await rpcCall(rpc, "eth_getLogs", [{ fromBlock: "0x" + Math.max(0, latest - span).toString(16), toBlock: "latest", address: USDT_BSC_CONTRACT, topics: [transferTopic, null, toTopic] }]);
          if (Array.isArray(logs)) {
            for (const l of logs) out.push({ txid: l.transactionHash, amount: Number(BigInt(l.data)) / 1e18, ts: Math.floor(now() / 1000), confirmed: true });
            break;
          }
        } catch (_) { /* try the next RPC node */ }
      }
    } else if (topup.crypto === "LTC") {
      const r = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${addr}/full?limit=50`);
      const d = await r.json().catch(() => ({}));
      for (const tx of d.txs || []) {
        const sat = (tx.outputs || []).filter((o) => (o.addresses || []).includes(addr)).reduce((a, o) => a + Number(o.value || 0), 0);
        const ts = tx.received ? Math.floor(new Date(tx.received).getTime() / 1000) : Math.floor(now() / 1000);
        if (sat > 0 && ts >= sinceSec - 3600) out.push({ txid: tx.hash, amount: sat / 1e8, ts, confirmed: Number(tx.confirmations || 0) >= 1 });
      }
    } else if ((topup.crypto === "ETH" || topup.crypto === "USDT_ERC20") && env.ETHERSCAN_API_KEY) {
      const isToken = topup.crypto === "USDT_ERC20";
      const action = isToken ? "tokentx" : "txlist";
      const contract = isToken ? `&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7` : "";
      const r = await fetch(`https://api.etherscan.io/api?module=account&action=${action}${contract}&address=${addr}&sort=desc&apikey=<redacted>`);
      const d = await r.json().catch(() => ({}));
      for (const tx of Array.isArray(d.result) ? d.result : []) {
        if (String(tx.to).toLowerCase() === addr.toLowerCase() && Number(tx.timeStamp) >= sinceSec)
          out.push({ txid: tx.hash, amount: Number(tx.value) / (isToken ? 1e6 : 1e18), ts: Number(tx.timeStamp), confirmed: true });
      }
    }
  } catch (_) { /* network hiccup: no candidates this round, cron retries */ }
  return out;
}

// A transfer only counts for a topup when its amount sits in a tight band
// around that topup's unique expected amount: at most 3% under (exchange
// withdrawal fees) and at most 1% over. A bigger payment no longer sweeps up
// every smaller open topup on the same wallet.
const inAmountBand = (amount, want) =>
  amount >= want - Math.max(want * 0.03, 0.0005) && amount <= want + Math.max(want * 0.01, 0.0005);

// Decide whether any on-chain transfer pays THIS topup. When several open
// topups compete for the same wallet + currency, each transfer belongs to the
// topup whose expected amount is closest, and its txid is claimed exactly
// once (txclaim:*), so one deposit can never settle two top-ups.
async function matchCryptoPayment(env, topup) {
  const want = Number(topup.expectedCrypto);
  if (!want || !topup.walletAddress) return null;
  const cands = await findCryptoCandidates(env, topup);
  if (!cands.length) return null;
  const rivals = (await kvList(env, "topup:")).filter((t) =>
    t.status === "pending" && t.method === "crypto" && t.crypto === topup.crypto &&
    t.walletAddress === topup.walletAddress && Number(t.expectedCrypto) > 0);
  for (const cand of cands.sort((a, b) => b.ts - a.ts)) {
    if (!cand.txid || !inAmountBand(cand.amount, want)) continue;
    let best = null, bestDiff = Infinity;
    for (const r of rivals) {
      if (!inAmountBand(cand.amount, Number(r.expectedCrypto))) continue;
      const diff = Math.abs(cand.amount - Number(r.expectedCrypto));
      if (diff < bestDiff - 1e-12 || (best && Math.abs(diff - bestDiff) <= 1e-12 && r.createdAt < best.createdAt)) { best = r; bestDiff = diff; }
    }
    if (!best || best.id !== topup.id) continue; // belongs to a rival topup
    const claimKey = `txclaim:${topup.crypto}:${cand.txid}`;
    const claim = await kvGet(env, claimKey);
    if (claim && claim.topupId !== topup.id) continue; // already consumed
    await kvPut(env, claimKey, { topupId: topup.id, at: now() }, 30 * 24 * 3600);
    return { kind: cand.confirmed ? "paid" : "seen", txid: cand.txid };
  }
  return null;
}

async function creditTopup(env, topup, note) {
  // Serialized per topup: the status flip and the balance credit must not be
  // interleaved by a second runner (cron + check button + admin approve).
  const res = await withKvLock(env, `topup:${topup.id}`, async () => {
    const fresh = await kvGet(env, `topup:${topup.id}`);
    if (!fresh || fresh.status !== "pending") return false;
    fresh.status = "approved";
    fresh.resolvedAt = now();
    if (note) fresh.note = note;
    await kvPut(env, `topup:${topup.id}`, fresh);
    const user = await getUser(env, fresh.userId);
    const credit = topupCredit(fresh);
    user.balance = Math.round((Number(user.balance) + credit) * 100) / 100;
    await saveUser(env, user);
    const cfg = await getConfig(env);
    const tmn = await usdtTomanRate(env);
    await send(env, fresh.userId,
      `✅ <b>موجودی شما افزایش یافت</b>\n\nمبلغ ${usdText(tmn, credit)} به حساب شما اضافه شد.\nموجودی فعلی: ${usdText(tmn, user.balance)}`,
      mainMenuKb(env, cfg, fresh.userId));
    return true;
  });
  return !!res;
}

// ---------- bot UI (Persian) ----------
function mainMenuKb(env, cfg, userId, origin) {
  const rows = [
    [btn("🛒 خرید شماره مجازی", "countries:0")],
    [btn("💰 موجودی من", "balance"), btn("💳 افزایش موجودی", "topup")],
    [btn("📱 سفارش‌های من", "orders")],
  ];
  rows.push(origin
    ? [urlBtn("📜 قوانین و مقررات", `${String(origin).replace(/\/+$/, "")}/terms`)]
    : [btn("📜 قوانین و مقررات", "terms")]);
  if (cfg?.SUPPORT_USERNAME) rows.push([urlBtn("🎧 پشتیبانی", `https://t.me/${cfg.SUPPORT_USERNAME}`)]);
  if (isAdmin(env, userId)) {
    rows.push([btn("🛠 پنل مدیریت", "admin")]);
    rows.push([btn("⚙️ تنظیمات فروشگاه", "cfg")]);
  }
  return kb(rows);
}
const backKb = kb([[btn("⬅️ منوی اصلی", "home")]]);

async function showHome(env, chatId, editMsgId) {
  const user = await getUser(env, chatId);
  const cfg = await getConfig(env);
  const tmn = await usdtTomanRate(env);
  const text = `سلام 👋\nبه فروشگاه <b>شماره مجازی</b> خوش آمدید.\n\n💰 موجودی شما: <b>${usdText(tmn, user.balance)}</b>\n\nبرای خرید، ابتدا کشور و سپس سرویس موردنظر را انتخاب کنید. کد پیامک به‌صورت خودکار همین‌جا نمایش داده می‌شود.`;
  const origin = cfg.WORKER_BASE_URL || (await kvGet(env, "sys:origin"))?.origin;
  if (editMsgId) return edit(env, chatId, editMsgId, text, mainMenuKb(env, cfg, chatId, origin));
  return send(env, chatId, text, mainMenuKb(env, cfg, chatId, origin));
}

function pageKb(items, page, perPage, makeCb, backTo, cols = 1, topRows = []) {
  const start = page * perPage;
  const slice = items.slice(start, start + perPage);
  const rows = [...topRows];
  for (let i = 0; i < slice.length; i += cols) {
    rows.push(slice.slice(i, i + cols).map((it) => btn(it.label, makeCb(it))));
  }
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", makeCb(null, page - 1)));
  if (start + perPage < items.length) nav.push(btn("بعدی ▶️", makeCb(null, page + 1)));
  if (nav.length) rows.push(nav);
  rows.push([btn("⬅️ بازگشت", backTo)]);
  return kb(rows);
}

// ---------- country names in English + search ----------
// SmsFull returns country names in Portuguese, but every country also carries
// its flag emoji — which encodes the ISO 3166-1 alpha-2 code (regional
// indicator letters). We derive the code from the flag and map it to the
// English name; when the flag is missing, a Portuguese->English dictionary
// is the fallback, then the provider's own name.
const COUNTRY_EN = { AF:"Afghanistan",AL:"Albania",DZ:"Algeria",AD:"Andorra",AO:"Angola",AG:"Antigua and Barbuda",AR:"Argentina",AM:"Armenia",AU:"Australia",AT:"Austria",AZ:"Azerbaijan",BS:"Bahamas",BH:"Bahrain",BD:"Bangladesh",BB:"Barbados",BY:"Belarus",BE:"Belgium",BZ:"Belize",BJ:"Benin",BT:"Bhutan",BO:"Bolivia",BA:"Bosnia and Herzegovina",BW:"Botswana",BR:"Brazil",BN:"Brunei",BG:"Bulgaria",BF:"Burkina Faso",BI:"Burundi",KH:"Cambodia",CM:"Cameroon",CA:"Canada",CV:"Cape Verde",CF:"Central African Republic",TD:"Chad",CL:"Chile",CN:"China",CO:"Colombia",KM:"Comoros",CG:"Congo",CD:"Congo (DRC)",CR:"Costa Rica",CI:"Côte d’Ivoire",HR:"Croatia",CU:"Cuba",CY:"Cyprus",CZ:"Czechia",DK:"Denmark",DJ:"Djibouti",DM:"Dominica",DO:"Dominican Republic",EC:"Ecuador",EG:"Egypt",SV:"El Salvador",GQ:"Equatorial Guinea",ER:"Eritrea",EE:"Estonia",ET:"Ethiopia",FJ:"Fiji",FI:"Finland",FR:"France",GA:"Gabon",GM:"Gambia",GE:"Georgia",DE:"Germany",GH:"Ghana",GR:"Greece",GD:"Grenada",GT:"Guatemala",GN:"Guinea",GW:"Guinea-Bissau",GY:"Guyana",HT:"Haiti",HN:"Honduras",HK:"Hong Kong",HU:"Hungary",IS:"Iceland",IN:"India",ID:"Indonesia",IR:"Iran",IQ:"Iraq",IE:"Ireland",IL:"Israel",IT:"Italy",JM:"Jamaica",JP:"Japan",JO:"Jordan",KZ:"Kazakhstan",KE:"Kenya",KI:"Kiribati",KW:"Kuwait",KG:"Kyrgyzstan",LA:"Laos",LV:"Latvia",LB:"Lebanon",LS:"Lesotho",LR:"Liberia",LY:"Libya",LI:"Liechtenstein",LT:"Lithuania",LU:"Luxembourg",MO:"Macao",MG:"Madagascar",MW:"Malawi",MY:"Malaysia",MV:"Maldives",ML:"Mali",MT:"Malta",MR:"Mauritania",MU:"Mauritius",MX:"Mexico",MD:"Moldova",MC:"Monaco",MN:"Mongolia",ME:"Montenegro",MA:"Morocco",MZ:"Mozambique",MM:"Myanmar",NA:"Namibia",NP:"Nepal",NL:"Netherlands",NZ:"New Zealand",NI:"Nicaragua",NE:"Niger",NG:"Nigeria",KP:"North Korea",MK:"North Macedonia",NO:"Norway",OM:"Oman",PK:"Pakistan",PS:"Palestine",PA:"Panama",PG:"Papua New Guinea",PY:"Paraguay",PE:"Peru",PH:"Philippines",PL:"Poland",PT:"Portugal",QA:"Qatar",RO:"Romania",RU:"Russia",RW:"Rwanda",WS:"Samoa",SM:"San Marino",ST:"São Tomé and Príncipe",SA:"Saudi Arabia",SN:"Senegal",RS:"Serbia",SC:"Seychelles",SL:"Sierra Leone",SG:"Singapore",SK:"Slovakia",SI:"Slovenia",SB:"Solomon Islands",SO:"Somalia",ZA:"South Africa",KR:"South Korea",SS:"South Sudan",ES:"Spain",LK:"Sri Lanka",SD:"Sudan",SR:"Suriname",SE:"Sweden",CH:"Switzerland",SY:"Syria",TW:"Taiwan",TJ:"Tajikistan",TZ:"Tanzania",TH:"Thailand",TL:"Timor-Leste",TG:"Togo",TO:"Tonga",TT:"Trinidad and Tobago",TN:"Tunisia",TR:"Turkey",TM:"Turkmenistan",UG:"Uganda",UA:"Ukraine",AE:"United Arab Emirates",GB:"United Kingdom",US:"United States",UY:"Uruguay",UZ:"Uzbekistan",VU:"Vanuatu",VE:"Venezuela",VN:"Vietnam",YE:"Yemen",ZM:"Zambia",ZW:"Zimbabwe",AQ:"Antarctica",AX:"Åland",BV:"Bouvet Island",IO:"British Indian Ocean Territory",KY:"Cayman Islands",CX:"Christmas Island",CC:"Cocos Islands",CK:"Cook Islands",FK:"Falkland Islands",FO:"Faroe Islands",GF:"French Guiana",PF:"French Polynesia",GL:"Greenland",GP:"Guadeloupe",GU:"Guam",GG:"Guernsey",IM:"Isle of Man",JE:"Jersey",MS:"Montserrat",NC:"New Caledonia",NU:"Niue",NF:"Norfolk Island",MP:"Northern Mariana Islands",PN:"Pitcairn",PR:"Puerto Rico",RE:"Réunion",SH:"Saint Helena",LC:"Saint Lucia",MF:"Saint Martin",PM:"Saint Pierre and Miquelon",VC:"Saint Vincent and the Grenadines",GS:"South Georgia",SJ:"Svalbard and Jan Mayen",TK:"Tokelau",TC:"Turks and Caicos",UM:"U.S. Minor Outlying Islands",VG:"British Virgin Islands",VI:"U.S. Virgin Islands",WF:"Wallis and Futuna",EH:"Western Sahara",AS:"American Samoa",AW:"Aruba",BM:"Bermuda",BQ:"Bonaire",CW:"Curaçao",GI:"Gibraltar",MH:"Marshall Islands",FM:"Micronesia",NR:"Nauru",PW:"Palau",KN:"Saint Kitts and Nevis",SX:"Sint Maarten",VA:"Vatican City",XK:"Kosovo" };
const PT_COUNTRY_EN = { "brasil":"Brazil","estados unidos":"United States","alemanha":"Germany","franca":"France","espanha":"Spain","italia":"Italy","reino unido":"United Kingdom","inglaterra":"United Kingdom","russia":"Russia","china":"China","japao":"Japan","india":"India","canada":"Canada","mexico":"Mexico","argentina":"Argentina","chile":"Chile","colombia":"Colombia","peru":"Peru","venezuela":"Venezuela","ucrania":"Ukraine","polonia":"Poland","turquia":"Turkey","ira":"Iran","iraque":"Iraq","afeganistao":"Afghanistan","paquistao":"Pakistan","bangladesh":"Bangladesh","indonesia":"Indonesia","vietna":"Vietnam","tailandia":"Thailand","filipinas":"Philippines","malasia":"Malaysia","coreia do sul":"South Korea","coreia do norte":"North Korea","australia":"Australia","nova zelandia":"New Zealand","africa do sul":"South Africa","nigeria":"Nigeria","egito":"Egypt","marrocos":"Morocco","argelia":"Algeria","quenia":"Kenya","etiopia":"Ethiopia","angola":"Angola","mocambique":"Mozambique","portugal":"Portugal","grecia":"Greece","holanda":"Netherlands","belgica":"Belgium","suecia":"Sweden","noruega":"Norway","dinamarca":"Denmark","finlandia":"Finland","suica":"Switzerland","austria":"Austria","irlanda":"Ireland","islandia":"Iceland","romenia":"Romania","bulgaria":"Bulgaria","hungria":"Hungary","bielorrussia":"Belarus","cazaquistao":"Kazakhstan","uzbequistao":"Uzbekistan","georgia":"Georgia","armenia":"Armenia","azerbaijao":"Azerbaijan","emirados arabes unidos":"United Arab Emirates","arabia saudita":"Saudi Arabia","catar":"Qatar","kuwait":"Kuwait","oma":"Oman","jordania":"Jordan","libano":"Lebanon","israel":"Israel","siria":"Syria","iemen":"Yemen","sri lanka":"Sri Lanka","nepal":"Nepal","mianmar":"Myanmar","camboja":"Cambodia","laos":"Laos","mongolia":"Mongolia","taiwan":"Taiwan","hong kong":"Hong Kong","singapura":"Singapore","cuba":"Cuba","republica dominicana":"Dominican Republic","guatemala":"Guatemala","honduras":"Honduras","nicaragua":"Nicaragua","panama":"Panama","costa rica":"Costa Rica","equador":"Ecuador","bolivia":"Bolivia","paraguai":"Paraguay","uruguai":"Uruguay","irao":"Iran" };
const normText = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
function isoFromFlag(emoji) {
  const pts = [...String(emoji || "")].map((ch) => ch.codePointAt(0)).filter((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff);
  if (pts.length !== 2) return null;
  return pts.map((cp) => String.fromCharCode(cp - 0x1f1e6 + 65)).join("");
}
function countryEnName(c) {
  const iso = isoFromFlag(c.emoji);
  if (iso && COUNTRY_EN[iso]) return COUNTRY_EN[iso];
  return PT_COUNTRY_EN[normText(c.name)] || c.name;
}
const countryLabel = (c) => `${c.emoji || "🌍"} ${countryEnName(c)}`;
function countryMatches(c, q) {
  const query = normText(q);
  if (!query) return false;
  const iso = isoFromFlag(c.emoji);
  return normText(c.name).includes(query) || normText(countryEnName(c)).includes(query) ||
    (iso && iso.toLowerCase() === query);
}
const serviceMatches = (s, q) => {
  const query = normText(q);
  return !!query && (normText(s.name).includes(query) || normText(s.code).includes(query));
};
async function showCountries(env, chatId, msgId, page) {
  const countries = await smsfull(env, "/countries");
  const items = countries.map((c) => ({ label: countryLabel(c), id: c.id }));
  const text = `🌍 <b>کشور را انتخاب کنید:</b>\n\nتعداد کشورها: ${faInt(items.length)} — برای پیدا کردن سریع، از دکمه جستجو استفاده کنید.`;
  return edit(env, chatId, msgId, text,
    pageKb(items, page, 20, (it, p) => it ? `services:${it.id}:0` : `countries:${p}`, "home", 2,
      [[btn("🔍 جستجوی کشور", "csearch")]]));
}

async function showCountrySearchResults(env, chatId, query) {
  const countries = await smsfull(env, "/countries");
  const hits = countries.filter((c) => countryMatches(c, query)).slice(0, 24);
  if (!hits.length) {
    return send(env, chatId, `🔍 کشوری با «${esc(query)}» پیدا نشد. املای انگلیسی را امتحان کنید (مثلاً Germany) یا از فهرست انتخاب کنید:`,
      kb([[btn("🌍 فهرست کشورها", "countries:0")], [btn("⬅️ منوی اصلی", "home")]]));
  }
  const rows = [];
  for (let i = 0; i < hits.length; i += 2) {
    rows.push(hits.slice(i, i + 2).map((c) => btn(countryLabel(c), `services:${c.id}:0`)));
  }
  rows.push([btn("🌍 فهرست کشورها", "countries:0")], [btn("⬅️ منوی اصلی", "home")]);
  return send(env, chatId, `🔍 <b>نتایج جستجو برای «${esc(query)}»:</b>`, kb(rows));
}

const serviceLabel = (cfg, fx, tmn, s) =>
  `${s.name} — ${usdText(tmn, fx ? sellPrice(cfg, s.price * fx) : s.price)} | موجود: ${faInt(s.available)}`;

async function showServices(env, chatId, msgId, countryId, page) {
  const cfg = await getConfig(env);
  const [fx, tmn] = await Promise.all([brlToUsdRate(env), usdtTomanRate(env)]);
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const avail = services.filter((s) => s.available > 0);
  const items = avail.map((s) => ({ label: serviceLabel(cfg, fx, tmn, s), id: s.id }));
  const text = items.length
    ? `📲 <b>سرویس را انتخاب کنید:</b>\nقیمت‌ها <b>دلاری</b> و با احتساب سود فروشگاه است${tmn ? ` — نرخ تتر (والکس): ${faInt(tmn)} تومان` : ""}.`
    : `در حال حاضر برای این کشور شماره‌ای موجود نیست. لطفاً بعداً دوباره تلاش کنید.`;
  return edit(env, chatId, msgId, text,
    pageKb(items, page, 10, (it, p) => it ? `confirm:${countryId}:${it.id}` : `services:${countryId}:${p}`, "countries:0", 1,
      items.length ? [[btn("🔍 جستجوی سرویس", `ssearch:${countryId}`)]] : []));
}

async function showServiceSearchResults(env, chatId, countryId, query) {
  const cfg = await getConfig(env);
  const [fx, tmn] = await Promise.all([brlToUsdRate(env), usdtTomanRate(env)]);
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const hits = services.filter((s) => s.available > 0 && serviceMatches(s, query)).slice(0, 20);
  if (!hits.length) {
    return send(env, chatId, `🔍 سرویسی با «${esc(query)}» پیدا نشد. بخشی از نام سرویس را به انگلیسی بنویسید (مثلاً Whats):`,
      kb([[btn("📲 فهرست سرویس‌ها", `services:${countryId}:0`)], [btn("⬅️ منوی اصلی", "home")]]));
  }
  const rows = hits.map((s) => [btn(serviceLabel(cfg, fx, tmn, s), `confirm:${countryId}:${s.id}`)]);
  rows.push([btn("📲 فهرست سرویس‌ها", `services:${countryId}:0`)], [btn("⬅️ منوی اصلی", "home")]);
  return send(env, chatId, `🔍 <b>نتایج جستجو برای «${esc(query)}»:</b>`, kb(rows));
}

async function showConfirm(env, chatId, msgId, countryId, serviceId) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const s = services.find((x) => x.id === Number(serviceId));
  if (!s) return edit(env, chatId, msgId, "این سرویس دیگر موجود نیست.", backKb);
  const cfg = await getConfig(env);
  const [fx, tmn] = await Promise.all([brlToUsdRate(env), usdtTomanRate(env)]);
  const price = fx ? sellPrice(cfg, s.price * fx) : s.price;
  const user = await getUser(env, chatId);
  const tomanLine = tmn
    ? `\n💵 معادل تومانی: <b>${faInt(Math.round(price * tmn))} تومان</b> (با نرخ لحظه‌ای تتر والکس: ${faInt(tmn)} تومان)`
    : "";
  const text = `🧾 <b>تأیید خرید</b>\n\nسرویس: <b>${esc(s.name)}</b>\nقیمت: <b>${usdText(tmn, price)}</b>${tomanLine}\nموجودی شما: ${usdText(tmn, user.balance)}\nموجودی لحظه‌ای: ${faInt(s.available)} شماره\n\nپس از خرید، شماره نمایش داده می‌شود و تا ${faDigits(20)} دقیقه منتظر کد پیامک می‌ماند. اگر کدی نیاید، مبلغی از موجودی کسر نخواهد شد.`;
  return edit(env, chatId, msgId, text, kb([
    [btn("✅ تأیید و خرید", `buy:${countryId}:${serviceId}`)],
    [btn("⬅️ بازگشت", `services:${countryId}:0`)],
  ]));
}

// Shared purchase core (bot AND web app): validate, reserve the number with
// the provider, charge the sell price and record the order. Throws errors
// with .kind: noService | noFx | insufficient | provider (provider errors
// keep their .code from the provider).
async function buyActivation(env, userId, countryId, serviceId, onProgress) {
  const res = await withKvLock(env, `buy:${userId}`, async () => {
    // Debounce: an identical purchase completed seconds ago is a double-tap
    // or a client retry — return that activation instead of buying twice and
    // charging twice.
    const last = await kvGet(env, `lastbuy:${userId}`);
    if (last && last.countryId === Number(countryId) && last.serviceId === Number(serviceId) && now() - last.at < 30000) {
      const rec = await kvGet(env, `act:${last.actId}`);
      const act = rec ? await smsfull(env, `/activations/${last.actId}`).catch(() => null) : null;
      if (rec && act) return { act, price: rec.price, deduped: true };
    }
    const r = await buyActivationInner(env, userId, countryId, serviceId, onProgress);
    await kvPut(env, `lastbuy:${userId}`, { countryId: Number(countryId), serviceId: Number(serviceId), actId: r.act.id, at: now() }, 120);
    return r;
  }, 60);
  if (res === undefined) throw Object.assign(new Error("درخواست قبلی شما در حال پردازش است؛ چند ثانیه دیگر دوباره تلاش کنید"), { kind: "busy" });
  return res;
}
async function buyActivationInner(env, userId, countryId, serviceId, onProgress) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const s = services.find((x) => x.id === Number(serviceId));
  if (!s) throw Object.assign(new Error("سرویس موجود نیست"), { kind: "noService" });
  const cfg = await getConfig(env);
  const fx = await brlToUsdRate(env);
  if (!fx) throw Object.assign(new Error("نرخ تبدیل ارز در دسترس نیست؛ چند دقیقه دیگر تلاش کنید"), { kind: "noFx" });
  const price = sellPrice(cfg, s.price * fx);
  const user = await getUser(env, userId);
  if (Number(user.balance) < price) {
    throw Object.assign(new Error("موجودی کافی نیست"), { kind: "insufficient", price, balance: Number(user.balance) });
  }
  if (onProgress) await onProgress();
  let act;
  try {
    act = await smsfull(env, "/activations", {
      method: "POST",
      body: { serviceId: Number(serviceId), countryId: Number(countryId) },
      headers: { "Idempotency-Key": uid() },
    });
  } catch (e) { e.kind = "provider"; throw e; }
  // Charge the user only for the sell price; provider reserves its own price.
  user.balance = Math.round((Number(user.balance) - price) * 100) / 100;
  await saveUser(env, user);
  await kvPut(env, `act:${act.id}`, {
    id: act.id, userId: String(userId), price, providerPriceBrl: act.price,
    phoneNumber: act.phoneNumber, serviceName: act.service?.name || s.name,
    status: act.status, createdAt: now(), charged: true,
  });
  return { act, price };
}

async function doBuy(env, chatId, msgId, countryId, serviceId, cbId) {
  let r;
  try {
    r = await buyActivation(env, chatId, countryId, serviceId, () => answerCb(env, cbId, "در حال خرید شماره…"));
  } catch (e) {
    if (e.kind === "busy") {
      await answerCb(env, cbId, e.message, true);
      return;
    }
    if (e.kind === "insufficient") {
      const tmn = await usdtTomanRate(env);
      const user = await getUser(env, chatId);
      await answerCb(env, cbId, "موجودی کافی نیست", true);
      return edit(env, chatId, msgId,
        `❌ <b>موجودی کافی نیست.</b>\n\nقیمت: ${usdText(tmn, e.price)}\nموجودی شما: ${usdText(tmn, user.balance)}\n\nابتدا موجودی خود را افزایش دهید.`,
        kb([[btn("💳 افزایش موجودی", "topup")], [btn("⬅️ منوی اصلی", "home")]]));
    }
    if (e.kind === "provider") {
      const msgs = {
        noNumbersAvailable: "متأسفانه در این لحظه شماره‌ای موجود نیست.",
        insufficientBalance: "موجودی فروشگاه نزد تأمین‌کننده کافی نیست. لطفاً با پشتیبانی تماس بگیرید.",
        priceChanged: "قیمت در لحظه خرید تغییر کرد. لطفاً دوباره تلاش کنید.",
      };
      return edit(env, chatId, msgId, `❌ خرید انجام نشد.\n${msgs[e.code] || esc(e.message)}`, backKb);
    }
    await answerCb(env, cbId, e.message, true);
    return;
  }
  return showActivation(env, chatId, msgId, r.act);
}

function activationText(act) {
  const statusFa = {
    waitingSms: "⏳ در انتظار پیامک…",
    codeReceived: "✅ کد دریافت شد",
    resendRequested: "🔄 درخواست پیامک مجدد ثبت شد",
    finished: "🏁 پایان‌یافته",
    cancelled: "🚫 لغو شده",
    expired: "⌛️ منقضی شده",
    refunded: "↩️ بازپرداخت شده",
  }[act.status] || act.status;
  const codes = (act.codes || []).map((c) => `<code>${esc(c)}</code>`).join("  ");
  return `📱 <b>شماره شما:</b> <code>+${esc(act.phoneNumber)}</code>\n\nوضعیت: ${statusFa}\n${act.latestCode ? `\n🔑 <b>کد:</b> <code>${esc(act.latestCode)}</code>\nهمه کدها: ${codes}` : "\nهنوز کدی دریافت نشده است. چند لحظه صبر کنید و «بررسی کد» را بزنید."}\n\n⏰ انقضا: ${faDigits(new Date(act.expiresAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }))}`;
}
function activationKb(act) {
  const open = ["waitingSms", "codeReceived", "resendRequested"].includes(act.status);
  const hasCode = !!act.latestCode || act.status === "codeReceived";
  const rows = [[btn("🔄 بررسی کد", `act:${act.id}`)]];
  if (open && hasCode) {
    // Code delivered: Finish is the only action left — cancelling is over.
    rows.push([btn("🏁 اتمام کار", `finish:${act.id}`)]);
  } else if (open) {
    rows.push([
      btn("📩 پیامک مجدد", `resend:${act.id}`),
      btn("🚫 لغو", `cancel:${act.id}`),
    ]);
  }
  rows.push([btn("📱 سفارش‌های من", "orders"), btn("⬅️ منوی اصلی", "home")]);
  return kb(rows);
}
async function showActivation(env, chatId, msgId, act, note = "") {
  const text = activationText(act) + note;
  if (msgId) return edit(env, chatId, msgId, text, activationKb(act));
  return send(env, chatId, text, activationKb(act));
}
function maskPhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (!d) return "***";
  if (d.length <= 6) return `+${d.slice(0, 2)}***${d.slice(-1)}`;
  const head = d.slice(0, 4);
  const tail = d.slice(-3);
  const stars = "*".repeat(Math.min(8, Math.max(3, d.length - head.length - tail.length)));
  return `+${head}${stars}${tail}`;
}

// Social-proof announcement: the first time a purchase's SMS code is
// delivered, post a summary in the configured purchases group — masked
// number, service and the buyer's numeric id. Only marked as posted after
// Telegram confirms delivery, and it never breaks the purchase flow.
async function postPurchaseToGroup(env, rec) {
  try {
    if (!rec || rec.groupPosted) return;
    const cfg = await getConfig(env);
    const gid = (cfg.GROUP_CHAT_ID || "").trim();
    if (!gid) return;
    if (now() - rec.createdAt > 2 * 3600 * 1000) {
      rec.groupPosted = true; // too old to announce; don't flood the group later
      await kvPut(env, `act:${rec.id}`, rec);
      return;
    }
    const text = `✅ <b>خرید موفق</b>\n\n📱 شماره: <code>${esc(maskPhone(rec.phoneNumber))}</code>\n🧩 سرویس: <b>${esc(rec.serviceName || "")}</b>\n👤 آیدی خریدار: <code>${esc(rec.userId)}</code>`;
    const res = await tg(env, "sendMessage", { chat_id: gid, text, parse_mode: "HTML" });
    if (res?.ok) {
      rec.groupPosted = true;
      await kvPut(env, `act:${rec.id}`, rec);
    }
  } catch (_) { /* an announcement must never break a purchase */ }
}

// Shared activation state sync (bot screens AND the web app): fetch the
// provider state, persist it, refund a code-less cancelled/expired order and
// fire the one-time group announcement. Returns { act, rec }.
async function syncActivation(env, id) {
  const act = await smsfull(env, `/activations/${id}`);
  const rec = await kvGet(env, `act:${id}`);
  if (rec && rec.status !== act.status) { rec.status = act.status; await kvPut(env, `act:${id}`, rec); }
  // Refund the user if the activation ended with no SMS and we had charged
  // them. Flag-first under a per-activation lock: syncActivation runs from
  // the bot button, the web app's 4s polling and the group hook at once, and
  // a naive read-check-write refunded twice.
  if (rec && rec.charged && ["cancelled", "expired"].includes(act.status)) {
    await withKvLock(env, `act:${id}`, async () => {
      const fresh = await kvGet(env, `act:${id}`);
      if (!fresh || !fresh.charged) return;
      fresh.charged = false;
      fresh.status = act.status;
      await kvPut(env, `act:${id}`, fresh);
      const user = await getUser(env, fresh.userId);
      user.balance = Math.round((Number(user.balance) + Number(fresh.price)) * 100) / 100;
      await saveUser(env, user);
      await send(env, fresh.userId, `↩️ مبلغ ${usdText(await usdtTomanRate(env), fresh.price)} بابت سفارش بدون پیامک به موجودی شما برگشت.`);
    });
  }
  // Announce in the purchases group the first time a code is delivered.
  if (rec && act.latestCode) await postPurchaseToGroup(env, rec);
  return { act, rec };
}

// Shared activation action (bot buttons AND the web app) with the shop's
// rules: no cancel inside the provider's 2-minute window, no cancel after a
// code, finish only after a code. Returns { ok, act } or { ok:false, error }.
async function actAction(env, userId, id, action) {
  const rec = await kvGet(env, `act:${id}`);
  if (!rec || rec.userId !== String(userId)) return { ok: false, error: "سفارش یافت نشد" };
  if (action === "cancel" || action === "finish") {
    const fresh = await smsfull(env, `/activations/${id}`).catch(() => null);
    const hasCode = !!(fresh?.latestCode || fresh?.status === "codeReceived" || fresh?.status === "finished");
    if (action === "finish" && !hasCode) return { ok: false, error: "اتمام کار فقط بعد از دریافت کد ممکن است.", refresh: true };
    if (action === "cancel" && hasCode) return { ok: false, error: "کد این سفارش دریافت شده و دیگر امکان لغو وجود ندارد.", refresh: true };
    if (action === "cancel" && rec.createdAt && now() - rec.createdAt < 120000) {
      const remain = Math.ceil((120000 - (now() - rec.createdAt)) / 1000);
      return { ok: false, error: `⏳ طبق محدودیت سایت تأمین‌کننده، تا ۲ دقیقه از خرید امکان لغو نیست. ${faDigits(remain)} ثانیه دیگر دوباره تلاش کنید.` };
    }
  }
  try { await smsfull(env, `/activations/${id}/${action}`, { method: "POST" }); }
  catch (e) { return { ok: false, error: e.message || "خطایی رخ داد" }; }
  const { act } = await syncActivation(env, id);
  return { ok: true, act };
}

async function refreshActivation(env, chatId, msgId, id, cbId = null) {
  // The view shows the phone number and the SMS code — the product itself —
  // so it enforces the same ownership rule as the actions (actAction).
  const recOwn = await kvGet(env, `act:${id}`);
  if (!recOwn || recOwn.userId !== String(chatId)) {
    if (cbId) await answerCb(env, cbId, "سفارش یافت نشد", true);
    return;
  }
  // Checking must never look frozen: instant toast, and the result message
  // always changes because it carries a fresh "last check" line.
  if (cbId) await answerCb(env, cbId, "🔄 در حال بررسی کد…");
  const { act } = await syncActivation(env, id);
  const t = new Date(now()).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Tehran" });
  const note = act.latestCode
    ? `\n\n🕐 آخرین بررسی: ${t}`
    : `\n\n🕐 آخرین بررسی: ${t} — هنوز کدی دریافت نشده است؛ چند لحظه دیگر دوباره «بررسی کد» را بزنید.`;
  return showActivation(env, chatId, msgId, act, note);
}

// ---------- top-ups: one dollar payment session, method chosen on the web page ----------
// Flow (v1.3.0): the user only enters the USD amount in the bot. That creates
// a payment session with a 30-minute deadline and a /pay link. On the web
// page the user picks the method (a crypto, or card-to-card); only then are
// the wallet, the exact amount and (for card) the Toman total fixed.
const PAY_TTL_MS = 30 * 60 * 1000;
// A payment whose transaction was seen on-chain but is not confirmed yet
// (BTC/LTC) is NOT cut off by the 30-minute deadline: it stays pending until
// confirmation, up to 24h after it was first seen.
const topupExpiresAt = (t) =>
  t.seenAt ? Number(t.seenAt) + 24 * 3600 * 1000
            : Number(t.expiresAt || (t.createdAt + PAY_TTL_MS));
const topupIsExpired = (t) => t.status === "pending" && now() > topupExpiresAt(t);

async function expireTopup(env, t) {
  await withKvLock(env, `topup:${t.id}`, () => expireTopupInner(env, t));
}
async function expireTopupInner(env, t) {
  const fresh = await kvGet(env, `topup:${t.id}`);
  if (!fresh || fresh.status !== "pending") return;
  fresh.status = "expired"; fresh.resolvedAt = now();
  await kvPut(env, `topup:${fresh.id}`, fresh, 7 * 24 * 3600);
  const u = await getUser(env, fresh.userId);
  if (u.state === "await_card_receipt" && u.stateData === fresh.id) {
    u.state = null; u.stateData = null; await saveUser(env, u);
  }
  const cfg = await getConfig(env);
  await send(env, fresh.userId,
    `⏰ <b>مهلت پرداخت تمام شد</b>\n\nدرخواست شارژ $${faNum(topupCredit(fresh))} منقضی شد (هر پرداخت ۳۰ دقیقه مهلت دارد). اگر هنوز می‌خواهید شارژ کنید، از منوی «افزایش موجودی» یک پرداخت جدید بسازید.`,
    mainMenuKb(env, cfg, fresh.userId));
}

async function findActiveSession(env, userId) {
  const mine = (await kvList(env, "topup:"))
    .filter((t) => t.userId === String(userId) && t.status === "pending" && !topupIsExpired(t))
    .sort((x, y) => y.createdAt - x.createdAt);
  return mine[0] || null;
}

function topupMenuText() {
  return `💳 <b>افزایش موجودی</b>\n\nمبلغ شارژ را به <b>دلار</b> یا <b>تومان</b> مشخص می‌کنید (مبلغ تومانی با نرخ لحظه‌ای تتر به دلار تبدیل می‌شود) و یک <b>لینک پرداخت</b> می‌گیرید. داخل صفحه پرداخت، روش را انتخاب می‌کنید (ارز دیجیتال یا کارت‌به‌کارت) و فقط همان روش به شما نشان داده می‌شود.\n\n⏰ هر پرداخت <b>۳۰ دقیقه</b> مهلت دارد.`;
}
async function showTopup(env, chatId, msgId, baseUrl) {
  const cfg = await getConfig(env);
  if (!cfg.CARD_NUMBER && !configuredCryptos(cfg).length) {
    return edit(env, chatId, msgId, "روش پرداختی هنوز توسط مدیر تنظیم نشده است. لطفاً با پشتیبانی تماس بگیرید.", backKb);
  }
  const active = await findActiveSession(env, chatId);
  if (active) {
    const m = await paySessionMessage(env, active, baseUrl);
    return edit(env, chatId, msgId, m.text + "\n\n(برای ساخت پرداخت تازه، اول این یکی را لغو کنید یا صبر کنید مهلتش تمام شود.)", m.markup);
  }
  return edit(env, chatId, msgId, topupMenuText(),
    kb([[btn("💵 ساخت لینک پرداخت", "link_new")], [btn("⬅️ منوی اصلی", "home")]]));
}

async function createPaySession(env, chatId, creditUsd, extra = {}) {
  const topup = {
    id: uid(), userId: String(chatId), method: "session",
    creditUsd, status: "pending", createdAt: now(), expiresAt: now() + PAY_TTL_MS,
    ...extra,
  };
  await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
  return topup;
}

function expectedCryptoAmount(code, creditUsd, price) {
  const c = CRYPTOS[code];
  const base = creditUsd / price;
  // Unique tail so the exact amount identifies this top-up on a shared wallet.
  const tail = code === "BTC"
    ? (Math.floor(Math.random() * 900) + 100) / 1e8
    : (Math.floor(Math.random() * 900) + 100) / 1e6;
  return Number((base + tail).toFixed(c.decimals));
}

// Caption sent to the admin with every card receipt (bot or web upload):
// the receipt photo itself + user id + the order (payment) details, with the
// apr:/rej: approve-reject buttons attached by the caller.
// Receipts are indexed the first time they are seen (bot path: Telegram
// file_id, stable per file; web path: SHA-256 of the uploaded bytes). A
// receipt that shows up for a SECOND payment is still forwarded — the admin
// decides — but its caption carries a loud duplicate warning.
async function noteReceiptSeen(env, key, topupId) {
  const prev = await kvGet(env, key);
  if (prev && prev.topupId !== topupId) return prev.topupId;
  await kvPut(env, key, { topupId, at: now() }, 90 * 24 * 3600);
  return null;
}

function receiptCaption(topup, via, dupOf) {
  return `🧾 <b>رسید جدید</b> (${via})\nکاربر: ${faDigits(topup.userId)}\nشناسه پرداخت: <code>${esc(topup.id)}</code>\nمبلغ کارت: ${faInt(topup.amountToman)} تومان\nشارژ درخواستی: $${faNum(topupCredit(topup))}${topup.rateUsed ? ` (با نرخ تتر ${faInt(topup.rateUsed)} تومان)` : ""}${topup.receiptCount > 1 ? `\n♻️ رسید جایگزین (شماره ${faDigits(topup.receiptCount)})` : ""}${dupOf ? `\n\n🔴 <b>هشدار:</b> این رسید قبلاً برای پرداخت دیگری ارسال شده است (<code>${esc(dupOf)}</code>). قبل از تأیید، هر دو پرداخت را مقایسه کنید.` : ""}`;
}

// Upload a user-supplied image file to a Telegram chat (multipart sendPhoto).
async function tgUploadPhoto(env, chatId, blob, filename, caption, replyMarkup) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("photo", blob, filename || "receipt.jpg");
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.description || "sendPhoto failed");
  const photos = d.result?.photo || [];
  return photos.length ? photos[photos.length - 1].file_id : null;
}

// Receipt upload from the /pay page (card-to-card): the file goes straight to
// the admin on Telegram with approve/reject buttons, and the user gets a bot
// message that the receipt is awaiting admin approval.
async function handlePayReceipt(env, request) {
  const json = (body, status = 200) => Response.json(body, { status });
  if (!(await throttle(env, `rcpt:${clientIp(request)}`, 10, 3600))) return json({ ok: false, error: "تلاش بیش از حد؛ بعداً دوباره تلاش کنید" }, 429);
  const t = new URL(request.url).searchParams.get("t");
  let topup = t ? await kvGet(env, `topup:${t}`) : null;
  if (!topup) return json({ ok: false, error: "پرداخت پیدا نشد" }, 404);
  topup = await settleTopupLazy(env, topup);
  if (topup.status !== "pending") return json({ ok: false, error: "این پرداخت بسته شده است" });
  if (topup.method !== "card") return json({ ok: false, error: "اول روش کارت‌به‌کارت را انتخاب کنید" });
  const cfgR = await getConfig(env);
  const userR = await getUser(env, topup.userId);
  if (cfgR.PHONE_VERIFY_ENABLED === "1" && !userR.phone) return json({ ok: false, error: "برای پرداخت کارتی، ابتدا باید شماره موبایلتان را داخل ربات احراز کنید" });
  if ((topup.receiptCount || 0) >= 3) return json({ ok: false, error: "حداکثر ۳ رسید برای هر پرداخت قابل ارسال است؛ برای ادامه با پشتیبانی در تماس باشید" });
  let form;
  try { form = await request.formData(); } catch (_) { return json({ ok: false, error: "فرم نامعتبر است" }, 400); }
  const file = form.get("receipt");
  if (!file || typeof file === "string") return json({ ok: false, error: "عکس رسید را انتخاب کنید" });
  if (!String(file.type || "").startsWith("image/")) return json({ ok: false, error: "فقط عکس رسید (JPG یا PNG) قابل قبول است" });
  if (file.size > 8 * 1024 * 1024) return json({ ok: false, error: "حجم عکس باید کمتر از ۸ مگابایت باشد" });
  topup.receiptCount = (topup.receiptCount || 0) + 1;
  const adminKb = kb([[btn("✅ تأیید و شارژ", `apr:${topup.id}`), btn("❌ رد رسید", `rej:${topup.id}`)]]);
  let dupOf = null;
  try {
    const hex = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
    dupOf = await noteReceiptSeen(env, `rcpt:sha:${hex}`, topup.id);
  } catch (_) {}
  let fileId;
  try {
    fileId = await tgUploadPhoto(env, env.ADMIN_CHAT_ID, file, file.name || "receipt.jpg", receiptCaption(topup, "از صفحه پرداخت", dupOf), adminKb);
  } catch (_) {
    return json({ ok: false, error: "ارسال رسید ناموفق بود؛ رسید را داخل ربات بفرستید" });
  }
  topup.receiptFileId = fileId;
  topup.receiptVia = "web";
  await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
  const user = await getUser(env, topup.userId);
  if (user.state === "await_card_receipt" && user.stateData === topup.id) {
    user.state = null; user.stateData = null; await saveUser(env, user);
  }
  const cfg = await getConfig(env);
  await send(env, topup.userId,
    `🧾 <b>رسید شما دریافت شد</b>\n\nرسید پرداخت کارت‌به‌کارت ثبت شد و <b>منتظر تأیید ادمین</b> است. پس از تأیید، موجودی‌تان شارژ می‌شود و همین‌جا اطلاع می‌دهیم.`,
    mainMenuKb(env, cfg, topup.userId));
  return json({ ok: true });
}

// Called from the web payment page when the user picks (or resets) a method.
async function applyPayMethod(env, topup, method) {
  const cfg = await getConfig(env);
  const user = await getUser(env, topup.userId);
  // Once money is visibly in flight, the method is final: switching after a
  // transfer was seen on-chain would strand that payment (it would never be
  // checked again), and switching away after a receipt was uploaded would
  // orphan the admin's review.
  if (topup.seenAt) throw new Error("تراکنش این پرداخت در شبکه دیده شده و روش پرداخت دیگر قابل تغییر نیست؛ برای پیگیری با پشتیبانی در تماس باشید");
  if (topup.receiptFileId && method !== "CARD") throw new Error("برای این پرداخت رسید ارسال شده و روش پرداخت قابل تغییر نیست");
  const clearReceiptState = async () => {
    if (user.state === "await_card_receipt" && user.stateData === topup.id) {
      user.state = null; user.stateData = null; await saveUser(env, user);
    }
  };
  if (method === "") { // back to method selection
    topup.method = "session";
    delete topup.crypto; delete topup.expectedCrypto; delete topup.walletAddress;
    delete topup.amountToman; delete topup.rateUsed; delete topup.selectedAt; delete topup.receiptFileId;
    await clearReceiptState();
  } else if (method === "CARD") {
    if (!cfg.CARD_NUMBER) throw new Error("این روش فعال نیست");
    if (cfg.PHONE_VERIFY_ENABLED === "1" && !user.phone) {
      // Park the session in a verify-first state; the /pay page explains and
      // deep-links into the bot, and the contact handler completes this
      // selection (calls applyPayMethod again) once the phone is verified.
      topup.method = "card_verify";
      delete topup.crypto; delete topup.expectedCrypto; delete topup.walletAddress; delete topup.receiptFileId;
      delete topup.amountToman; delete topup.rateUsed; delete topup.selectedAt;
      await clearReceiptState();
      await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
      return topup;
    }
    const rate = await usdtTomanRate(env);
    if (!rate) throw new Error("نرخ تتر در دسترس نیست؛ چند دقیقه دیگر تلاش کنید");
    topup.method = "card";
    delete topup.crypto; delete topup.expectedCrypto; delete topup.walletAddress; delete topup.receiptFileId;
    topup.amountToman = Math.round(topupCredit(topup) * rate);
    topup.rateUsed = rate; topup.selectedAt = now();
    user.state = "await_card_receipt"; user.stateData = topup.id; await saveUser(env, user);
  } else {
    const c = CRYPTOS[method];
    if (!c || !cfg[c.envKey]) throw new Error("این روش فعال نیست");
    const price = await cryptoPriceUsd(env, c.cg);
    topup.method = "crypto"; topup.crypto = method; topup.walletAddress = cfg[c.envKey];
    topup.expectedCrypto = expectedCryptoAmount(method, topupCredit(topup), price);
    delete topup.amountToman; delete topup.rateUsed; delete topup.receiptFileId;
    topup.selectedAt = now();
    await clearReceiptState();
  }
  await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
  return topup;
}

async function paySessionMessage(env, topup, baseUrl) {
  const tmn = await usdtTomanRate(env);
  const mins = Math.max(0, Math.ceil((topupExpiresAt(topup) - now()) / 60000));
  const timeLine = topup.seenAt
    ? "👀 تراکنش دیده شده و در انتظار تأیید شبکه است؛ به‌محض تأیید، خودکار شارژ می‌شود."
    : `⏰ مهلت پرداخت: ${faDigits(mins)} دقیقه`;
  let methodLine = "روش پرداخت: هنوز انتخاب نشده — داخل صفحه پرداخت انتخابش کنید.";
  if (topup.method === "crypto") methodLine = `روش پرداخت: ${esc(CRYPTOS[topup.crypto]?.label || "")} — مبلغ دقیق: <code>${esc(topup.expectedCrypto)}</code>`;
  if (topup.method === "card") methodLine = `روش پرداخت: کارت‌به‌کارت — مبلغ: ${faInt(topup.amountToman)} تومان. رسید را همین‌جا در ربات بفرستید.`;
  const inputLine = topup.inputToman ? `\nمبلغ واردشده: ${faInt(topup.inputToman)} تومان ≈ $${faNum(topupCredit(topup))} (با نرخ تتر ${faInt(topup.inputRate)} تومان)` : "";
  const text = `💵 <b>پرداخت شما ساخته شد</b>\n\nمبلغ شارژ: ${usdText(tmn, topupCredit(topup))}${inputLine}\n${methodLine}\n${timeLine}\n\nاز دکمه زیر صفحه پرداخت را باز کنید:`;
  const rows = [[urlBtn("🌐 باز کردن صفحه پرداخت", `${baseUrl}/pay?t=${topup.id}`)]];
  if (topup.method === "crypto") rows.push([btn("🔄 بررسی پرداخت", `chk:${topup.id}`)]);
  rows.push([btn("❌ لغو این پرداخت", `ses_cancel:${topup.id}`)]);
  rows.push([btn("⬅️ منوی اصلی", "home")]);
  return { text, markup: kb(rows) };
}

// ---------- admin ----------
async function showAdmin(env, chatId, msgId) {
  let balText = "";
  try {
    const b = await smsfull(env, "/balance");
    const fxA = await brlToUsdRate(env);
    balText = `\n\n💼 موجودی نزد تأمین‌کننده: <b>${faNum(b.spendable)}</b> ${esc(b.currency)} (کل: ${faNum(b.balance)})${fxA ? `\n≈ قابل‌خرید به دلار: $${faNum(b.spendable * fxA)}` : ""}`;
  } catch (e) { balText = `\n\n⚠️ خطا در دریافت موجودی تأمین‌کننده: ${esc(e.message)}`; }
  const text = `🛠 <b>پنل مدیریت</b>${balText}\n\n📌 نسخه ربات: ${faDigits(BOT_VERSION)} — اگر دکمه «تنظیمات فروشگاه» را نمی‌بینید، ورکر هنوز روی نسخه قبلی است و باید در کلودفلر دوباره دیپلوی شود.`;
  const rows = [
    [btn("🧾 رسیدهای در انتظار تأیید", "adm_pending")],
    [btn("🪙 پرداخت‌های کریپتوی در انتظار", "adm_crypto_pending")],
    [btn("⚙️ تنظیمات فروشگاه", "cfg")],
    [btn("⬅️ منوی اصلی", "home")],
  ];
  if (msgId) return edit(env, chatId, msgId, text, kb(rows));
  return send(env, chatId, text, kb(rows));
}
async function showPending(env, chatId, msgId, method) {
  const all = (await kvList(env, "topup:")).filter(
    (t) => t.status === "pending" && t.method === method && (method !== "card" || t.receiptFileId));
  if (!all.length) return edit(env, chatId, msgId, "موردی در انتظار نیست. ✅", kb([[btn("⬅️ پنل مدیریت", "admin")]]));
  let text = method === "card" ? "🧾 <b>رسیدهای در انتظار:</b>\n" : "🪙 <b>پرداخت‌های کریپتوی در انتظار:</b>\n";
  const rows = [];
  for (const t of all.slice(0, 10)) {
    text += `\n— کاربر ${faDigits(t.userId)} | شارژ: $${faNum(topupCredit(t))}${t.method === "card" ? ` | مبلغ کارت: ${faInt(t.amountToman)} تومان` : ` | ${esc(t.crypto)}: ${faDigits(t.expectedCrypto)}`}`;
    rows.push([
      btn(`✅ تأیید $${faNum(topupCredit(t))}`, `apr:${t.id}`),
      btn("❌ رد", `rej:${t.id}`),
    ]);
    if (t.method === "crypto") rows.push([btn("🔄 بررسی زنجیره", `chk:${t.id}`)]);
  }
  rows.push([btn("⬅️ پنل مدیریت", "admin")]);
  return edit(env, chatId, msgId, text, kb(rows));
}

// ---------- shop settings (admin panel, stored in KV config) ----------
const SETTING_FIELDS = {
  CARD_NUMBER: { label: "شماره کارت", hint: "فقط عددهای شماره کارت را بفرستید (با فاصله هم می‌شود)." },
  CARD_HOLDER: { label: "نام صاحب کارت", hint: "نام و نام خانوادگی صاحب کارت را بفرستید." },
  CARD_BANK: { label: "نام بانک", hint: "نام بانک را بفرستید، مثلاً: بانک ملی" },
  TOMAN_PER_BRL: { label: "نرخ تومان (هر ۱ BRL)", hint: "فقط عدد بفرستید، مثال: 40000", numeric: true },
  PRICE_MARKUP_PERCENT: { label: "درصد سود فروشگاه", hint: "فقط عدد بفرستید، مثال: 20 یعنی ۲۰٪ روی قیمت تأمین‌کننده", numeric: true },
  MIN_TOPUP_USD: { label: "حداقل مبلغ شارژ (دلار)", hint: "فقط عدد بفرستید، مثال: 5 — شارژ کمتر از این مبلغ (دلاری یا معادل تومانی) ساخته نمی‌شود. برای برگشت به پیش‌فرض ۱ دلار، مقدار را حذف کنید.", numeric: true },
  SUPPORT_USERNAME: { label: "یوزرنیم پشتیبانی", hint: "بدون @ بفرستید، مثال: BlueMajaziSupport" },
  TMN_RATE_MANUAL: { label: "نرخ دستی تتر (تومان) — پشتیبان", hint: "فقط عدد بفرستید، مثال: 271000 — فقط وقتی استفاده می‌شود که نرخ زنده از والکس و اکسیر نرسد.", numeric: true },
  GROUP_CHAT_ID: { label: "آیدی گروه اعلام خرید موفق", hint: "آیدی عددی گروه را با علامت منفی بفرستید، مثال: -1001234567890 — یا ساده‌تر: ربات را در گروه اضافه کنید و همان‌جا دستور /setgroup را بفرستید تا خودکار ثبت شود." },
  FORCE_JOIN_ENABLED: { label: "عضویت اجباری کانال", hint: "" },
  FORCE_JOIN_CHANNEL: { label: "کانال عضویت اجباری", hint: "یوزرنیم کانال را با @ بفرستید، مثال: @blluegate — ربات باید در آن کانال ادمین باشد تا بتواند عضویت کاربران را بررسی کند." },
  PHONE_VERIFY_ENABLED: { label: "احراز با شماره (فقط کارت‌به‌کارت)", hint: "" },
  WORKER_BASE_URL: { label: "آدرس عمومی ورکر", hint: "آدرس کامل با https:// — برای اطمینان از تنظیم خودکار وبهوک" },
};
const walletField = (code) => ({
  label: `کیف‌پول ${CRYPTOS[code].label}`,
  hint: "آدرس کیف‌پول را دقیق و بدون فاصله بفرستید.",
});
function settingLabel(key) {
  if (SETTING_FIELDS[key]) return SETTING_FIELDS[key].label;
  const code = Object.keys(CRYPTOS).find((c) => CRYPTOS[c].envKey === key);
  return code ? walletField(code).label : key;
}
function settingHint(key) {
  if (SETTING_FIELDS[key]) return SETTING_FIELDS[key].hint;
  return walletField(Object.keys(CRYPTOS).find((c) => CRYPTOS[c].envKey === key)).hint;
}
const CONFIG_GROUPS = {
  card: { title: "💳 تنظیمات پرداخت کارتی", keys: ["CARD_NUMBER", "CARD_HOLDER", "CARD_BANK"] },
  wallet: { title: "🪙 کیف‌پول‌های کریپتو", keys: Object.values(CRYPTOS).map((c) => c.envKey) },
  general: { title: "🧰 تنظیمات عمومی", keys: ["PRICE_MARKUP_PERCENT", "MIN_TOPUP_USD", "TMN_RATE_MANUAL", "GROUP_CHAT_ID", "SUPPORT_USERNAME", "WORKER_BASE_URL"] },
  access: { title: "🔒 عضویت و احراز هویت", keys: ["FORCE_JOIN_ENABLED", "FORCE_JOIN_CHANNEL", "PHONE_VERIFY_ENABLED"] },
};
const groupOfKey = (key) =>
  Object.entries(CONFIG_GROUPS).find(([, g]) => g.keys.includes(key))?.[0] || "general";
const shortVal = (v) => !v ? "— تنظیم نشده" : v.length > 26 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;

function configGroupText(cfg, group) {
  const g = CONFIG_GROUPS[group];
  let text = `⚙️ <b>${g.title}</b>\n\nبرای ویرایش، روی هر مورد بزنید. دکمه 🗑 مقدار را حذف می‌کند.\n`;
  for (const k of g.keys) {
    const v = TOGGLE_KEYS.includes(k) ? (cfg[k] === "1" ? "روشن ✅" : "خاموش ⚪️") : shortVal(cfg[k]);
    text += `\n<b>${esc(settingLabel(k))}:</b> <code>${esc(v)}</code>`;
  }
  return text;
}
function configGroupKb(cfg, group) {
  const g = CONFIG_GROUPS[group];
  const rows = g.keys.map((k) => TOGGLE_KEYS.includes(k)
    ? [btn(`${settingLabel(k)}: ${cfg[k] === "1" ? "روشن ✅" : "خاموش ⚪️"}`, `cfgtgl:${k}`)]
    : [
      btn(`${settingLabel(k)}: ${shortVal(cfg[k])}`, `cfg_set:${k}`),
      btn("🗑", `cfg_del:${k}`),
    ]);
  rows.push([btn("⬅️ همه تنظیمات", "cfg"), btn("🛠 پنل مدیریت", "admin")]);
  return kb(rows);
}
async function showConfigOverview(env, chatId, msgId) {
  const cfg = await getConfig(env);
  const status = (keys) => keys.some((k) => cfg[k]) ? "✅" : "⚪️";
  const text = `⚙️ <b>تنظیمات فروشگاه</b>\n\nهمه این موارد از همین‌جا قابل تغییر است و بلافاصله (بدون دیپلوی دوباره) اعمال می‌شود. مقادیر در دیتابیس فروشگاه ذخیره می‌شوند و اگر قبلاً در Cloudflare هم ست شده باشند، مقدار این پنل اولویت دارد.\n\n💳 کارت: ${status(CONFIG_GROUPS.card.keys)}\n🪙 کیف‌پول‌ها: ${faInt(CONFIG_GROUPS.wallet.keys.filter((k) => cfg[k]).length)} مورد ست شده\n🧰 عمومی: سود ${faDigits(cfg.PRICE_MARKUP_PERCENT)}٪`;
  const rows = [
    [btn(CONFIG_GROUPS.card.title, "cfg_g:card")],
    [btn(CONFIG_GROUPS.wallet.title, "cfg_g:wallet")],
    [btn(CONFIG_GROUPS.general.title, "cfg_g:general")],
    [btn(CONFIG_GROUPS.access.title, "cfg_g:access")],
    [btn("🛠 پنل مدیریت", "admin"), btn("⬅️ منوی اصلی", "home")],
  ];
  if (msgId) return edit(env, chatId, msgId, text, kb(rows));
  return send(env, chatId, text, kb(rows));
}
async function showConfigGroup(env, chatId, msgId, group) {
  const cfg = await getConfig(env);
  const text = configGroupText(cfg, group);
  if (msgId) return edit(env, chatId, msgId, text, configGroupKb(cfg, group));
  return send(env, chatId, text, configGroupKb(cfg, group));
}
function validateSetting(key, raw) {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return { error: "مقدار خالی است." };
  if (key === "CARD_NUMBER") {
    const v = clean.replace(/[\s-]/g, "");
    return /^\d{12,19}$/.test(v) ? { value: v } : { error: "شماره کارت باید ۱۲ تا ۱۹ رقم باشد." };
  }
  if (key === "FORCE_JOIN_CHANNEL") {
    let v = clean.replace(/\s/g, "");
    const m = /^https?:\/\/t\.me\/([A-Za-z0-9_]{3,})$/.exec(v);
    if (m) v = "@" + m[1];
    if (/^@[A-Za-z0-9_]{3,}$/.test(v) || /^-100\d{6,}$/.test(v)) return { value: v };
    return { error: "یوزرنیم کانال را با @ بفرستید (مثال: @blluegate) یا آیدی عددی کانال (-100…). لینک دعوت خصوصی قابل استفاده نیست." };
  }
  if (key === "GROUP_CHAT_ID") {
    const v = clean.replace(/\s/g, "");
    return /^-?\d{5,20}$/.test(v) ? { value: v } : { error: "آیدی عددی گروه معتبر نیست (مثال: -1001234567890). یا ربات را در گروه اضافه کنید و آنجا /setgroup بفرستید." };
  }
  if (key === "MIN_TOPUP_USD") {
    return /^\d+(\.\d+)?$/.test(clean) && Number(clean) > 0 && Number(clean) <= 5000
      ? { value: clean } : { error: "حداقل مبلغ شارژ باید عددی بزرگ‌تر از صفر و حداکثر ۵۰۰۰ دلار باشد." };
  }
  if (SETTING_FIELDS[key]?.numeric) {
    return /^\d+(\.\d+)?$/.test(clean) && Number(clean) > 0
      ? { value: clean } : { error: "فقط عدد بزرگ‌تر از صفر بفرستید." };
  }
  if (key === "SUPPORT_USERNAME") {
    const v = clean.replace(/^@/, "").replace(/\s/g, "");
    return /^[A-Za-z0-9_]{3,}$/.test(v) ? { value: v } : { error: "یوزرنیم معتبر نیست (حروف انگلیسی، عدد و _)." };
  }
  if (key === "WORKER_BASE_URL") {
    const v = clean.replace(/\/+$/, "");
    return v.startsWith("https://") ? { value: v } : { error: "آدرس باید با https:// شروع شود." };
  }
  if (key.startsWith("WALLET_")) {
    const v = clean.replace(/\s/g, "");
    return v.length >= 15 && /^[A-Za-z0-9:_\-\.]+$/.test(v)
      ? { value: v } : { error: "آدرس کیف‌پول معتبر نیست؛ بدون فاصله و کامل بفرستید." };
  }
  return { value: clean };
}

// ---------- forced channel join + phone verification ----------
const TOGGLE_KEYS = ["FORCE_JOIN_ENABLED", "PHONE_VERIFY_ENABLED"];
const JOIN_TEXT = `🔒 <b>عضویت اجباری</b>\n\nبرای استفاده از فروشگاه، ابتدا در کانال ما عضو شوید و سپس دکمه «بررسی عضویت» را بزنید.`;
function joinChannelLink(cfg) {
  const ch = cfg?.FORCE_JOIN_CHANNEL || "";
  return ch.startsWith("@") ? `https://t.me/${ch.slice(1)}` : null;
}
function joinPromptKb(cfg) {
  const rows = [];
  const link = joinChannelLink(cfg);
  if (link) rows.push([urlBtn("📢 عضویت در کانال", link)]);
  rows.push([btn("✅ عضو شدم — بررسی عضویت", "joinchk")]);
  return kb(rows);
}
async function isChannelMember(env, cfg, userId) {
  const ch = cfg?.FORCE_JOIN_CHANNEL;
  if (!ch) return true;
  try {
    const r = await tg(env, "getChatMember", { chat_id: ch, user_id: Number(userId) });
    // tg() never throws: an API-level failure (bot not in the channel, not an
    // admin, channel deleted) arrives as { ok:false } with no result — treat
    // it as a broken check, not as "not a member".
    if (!r || r.ok === false || !r.result) throw new Error(r?.description || "getChatMember failed");
    return ["creator", "administrator", "member", "restricted"].includes(r.result.status);
  } catch (e) {
    // Fail open (a misconfigured channel must not lock everyone out) — but
    // never silently: the admin is told the gate is currently not enforcing,
    // throttled to one alert per 6 hours.
    try {
      const last = await kvGet(env, "sys:joinAlert");
      if (!last || now() - last.at > 6 * 3600 * 1000) {
        await kvPut(env, "sys:joinAlert", { at: now() }, 7 * 24 * 3600);
        await send(env, env.ADMIN_CHAT_ID,
          `⚠️ <b>بررسی عضویت اجباری کانال ممکن نیست</b>\n\nخطا: ${esc(e.message || String(e))}\n\nاحتمالاً ربات در کانال ${esc(ch)} ادمین نیست یا از آن حذف شده است. تا وقتی مشکل رفع شود، دروازه عضویت موقتاً باز است و همه می‌توانند وارد شوند.`);
      }
    } catch (_) {}
    return true;
  }
}
// True when this user is currently BLOCKED by the forced-join rule.
async function forceJoinGate(env, cfg, userId) {
  if (cfg?.FORCE_JOIN_ENABLED !== "1" || !cfg?.FORCE_JOIN_CHANNEL) return false;
  if (isAdmin(env, userId)) return false;
  return !(await isChannelMember(env, cfg, userId));
}
const CONTACT_KB = { keyboard: [[{ text: "📱 ارسال شماره موبایل", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const REMOVE_KB = { remove_keyboard: true };
async function payReturnLink(env, user, preferId) {
  const cfg = await getConfig(env);
  const base = cfg.WORKER_BASE_URL || (await kvGet(env, "sys:origin"))?.origin;
  if (!base) return null;
  let id = preferId || user.pendingPay || null;
  if (!id) {
    const mine = (await kvList(env, "topup:")).filter((t) => t.userId === String(user.id) && t.status === "pending" && !topupIsExpired(t));
    id = mine.sort((x, y) => y.createdAt - x.createdAt)[0]?.id || null;
  }
  return id ? `${String(base).replace(/\/+$/, "")}/pay?t=${id}` : null;
}
async function promptPhoneVerify(env, chatId, user, payId) {
  if (payId) { user.pendingPay = payId; await saveUser(env, user); }
  if (user.phone) {
    const link = await payReturnLink(env, user, payId);
    return send(env, chatId, "✅ شماره شما قبلاً احراز شده و پرداخت کارت‌به‌کارت برایتان فعال است.", link ? kb([[urlBtn("💳 بازگشت به صفحه پرداخت", link)]]) : backKb);
  }
  return send(env, chatId, "📱 <b>احراز هویت با شماره موبایل</b>\n\nبرای پرداخت کارت‌به‌کارت، یک‌بار باید شماره موبایلتان را با دکمه زیر ارسال کنید.\nشماره حتماً باید متعلق به خودتان باشد؛ تلگرام این را تضمین می‌کند و شماره دیگران پذیرفته نمی‌شود.", CONTACT_KB);
}

// ---------- message / callback router ----------
async function handleMessage(env, msg, baseUrl) {
  const chatId = msg.chat.id;
  const user = await getUser(env, chatId);
  const text = enDigits((msg.text || "").trim());

  // Groups are not served: the only group commands are the admin's
  // /setgroup and /unsetgroup (handled below). Every shop flow — balances,
  // purchases, receipts, phone verification — is private-chat only.
  if (msg.chat?.type !== "private" && !/^\/(setgroup|unsetgroup)(\s|$)/.test(text)) return;

  // Forced channel membership: private chats only; contact shares pass
  // through (they are part of phone verification, an independent flow).
  if (msg.chat?.type === "private" && !msg.contact) {
    const cfgJ = await getConfig(env);
    if (await forceJoinGate(env, cfgJ, chatId)) return send(env, chatId, JOIN_TEXT, joinPromptKb(cfgJ));
  }

  // Phone verification via Telegram's own contact share. The shared contact
  // must belong to the sender (Telegram signs it; contact.user_id proves it).
  if (msg.contact) {
    const c = msg.contact;
    if (String(c.user_id) !== String(chatId)) {
      return send(env, chatId, "⚠️ این شماره متعلق به حساب شما نیست. لطفاً با دکمه «📱 ارسال شماره موبایل» شماره خودتان را ارسال کنید.", REMOVE_KB);
    }
    user.phone = c.phone_number;
    user.phoneVerifiedAt = now();
    await saveUser(env, user);
    // Complete any card selection that was waiting for this verification.
    const waiting = (await kvList(env, "topup:")).filter((t) => t.userId === String(chatId) && t.status === "pending" && t.method === "card_verify" && !topupIsExpired(t));
    for (const t of waiting) { try { await applyPayMethod(env, t, "CARD"); } catch (_) {} }
    const link = await payReturnLink(env, user);
    user.pendingPay = null;
    await saveUser(env, user);
    await send(env, chatId, `✅ <b>احراز هویت موفق بود!</b>\n\nشماره <b>${esc(faDigits(c.phone_number))}</b> ثبت شد و پرداخت کارت‌به‌کارت برای شما فعال شد.`, REMOVE_KB);
    if (link) await send(env, chatId, "از دکمه زیر به صفحه پرداختتان برگردید و پرداخت کارت را ادامه دهید:", kb([[urlBtn("💳 بازگشت به صفحه پرداخت", link)]]));
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    user.state = null; await saveUser(env, user);
    const param = text.split(" ")[1] || "";
    if (param.startsWith("vfy_")) return promptPhoneVerify(env, chatId, user, param.slice(4));
    if (param === "verify") return promptPhoneVerify(env, chatId, user, null);
    return showHome(env, chatId);
  }

  // Link/unlink this group for successful-purchase announcements (admin only,
  // sent inside the group). Group ids are the chat id of group/supergroup chats.
  const cmd = text.split("@")[0];
  if ((cmd === "/setgroup" || cmd === "/unsetgroup") && (msg.chat?.type === "group" || msg.chat?.type === "supergroup")) {
    if (String(msg.from?.id) !== String(env.ADMIN_CHAT_ID)) {
      return send(env, chatId, "⛔️ فقط ادمین فروشگاه می‌تواند این دستور را اجرا کند.");
    }
    if (cmd === "/setgroup") {
      await setConfigValue(env, "GROUP_CHAT_ID", String(chatId));
      await send(env, env.ADMIN_CHAT_ID, `✅ گروه «${esc(msg.chat.title || "")}» برای اعلام خریدهای موفق ثبت شد.\nآیدی گروه: <code>${esc(chatId)}</code>`);
      return send(env, chatId, "✅ <b>این گروه برای اعلام خریدهای موفق ثبت شد.</b>\nاز این به بعد، هر خرید موفقی که کدش به خریدار تحویل شود، با شماره ماسک‌شده اینجا اعلام می‌شود.");
    }
    await setConfigValue(env, "GROUP_CHAT_ID", "");
    return send(env, chatId, "❌ اعلام خریدهای موفق غیرفعال شد (گروه از تنظیمات فروشگاه حذف شد).");
  }
  if (text === "/admin" && isAdmin(env, chatId)) return showAdmin(env, chatId);
  if ((text === "/settings" || text === "تنظیمات") && isAdmin(env, chatId)) return showConfigOverview(env, chatId);

  // Admin is editing a shop setting: this message is the new value.
  if (isAdmin(env, chatId) && user.state?.startsWith("setcfg:")) {
    const key = user.state.slice("setcfg:".length);
    if (text === "/cancel") {
      user.state = null; await saveUser(env, user);
      return send(env, chatId, "لغو شد.", kb([[btn("⚙️ تنظیمات فروشگاه", "cfg")]]));
    }
    const { value, error } = validateSetting(key, text);
    if (error) return send(env, chatId, `❌ ${error}\nدوباره بفرستید یا /cancel بزنید.`);
    await setConfigValue(env, key, value);
    user.state = null; await saveUser(env, user);
    const group = groupOfKey(key);
    const cfg = await getConfig(env);
    return send(env, chatId,
      `✅ <b>ذخیره شد</b>\n${esc(settingLabel(key))}: <code>${esc(value)}</code>\n\n${configGroupText(cfg, group)}`,
      configGroupKb(cfg, group));
  }

  // Receipts are photos only (the web upload is images-only too): a document
  // can be any file at all, including one the admin should never be sent.
  if (user.state === "await_card_receipt" && msg.document && !msg.photo) {
    return send(env, chatId, "📎 رسید را به‌صورت «عکس» بفرستید، نه فایل یا داکیومنت. این مرحله تا وقتی عکس نفرستید باز می‌ماند.", backKb);
  }
  // Receipt photo for a pending card top-up
  if (user.state === "await_card_receipt" && msg.photo) {
    const topup = await kvGet(env, `topup:${user.stateData}`);
    if (!topup) { user.state = null; await saveUser(env, user); return send(env, chatId, "درخواست شارژ پیدا نشد. دوباره تلاش کنید.", backKb); }
    const cfgV = await getConfig(env);
    if (cfgV.PHONE_VERIFY_ENABLED === "1" && !user.phone) return promptPhoneVerify(env, chatId, user, topup.id);
    if ((topup.receiptCount || 0) >= 3) {
      user.state = null; user.stateData = null; await saveUser(env, user);
      return send(env, chatId, "🧾 برای این پرداخت قبلاً ۳ رسید ارسال شده و سقف ارسال رسید پر است. برای ادامه، با پشتیبانی در تماس باشید.", mainMenuKb(env, cfgV, chatId));
    }
    topup.receiptFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    topup.receiptVia = "bot";
    topup.receiptCount = (topup.receiptCount || 0) + 1;
    topup.status = "pending";
    await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
    user.state = null; user.stateData = null;
    await saveUser(env, user);
    await send(env, chatId, "🧾 رسید شما دریافت شد و برای تأیید نزد مدیر ارسال شد. پس از تأیید، موجودی‌تان شارژ می‌شود.", mainMenuKb(env, await getConfig(env), chatId));
    // Forward receipt to admin with approve/reject buttons
    const dupOf = await noteReceiptSeen(env, `rcpt:fid:${topup.receiptFileId}`, topup.id);
    const cap = receiptCaption(topup, "از ربات", dupOf);
    const adminKb = kb([[btn("✅ تأیید و شارژ", `apr:${topup.id}`), btn("❌ رد رسید", `rej:${topup.id}`)]]);
    if (msg.photo) await tg(env, "sendPhoto", { chat_id: env.ADMIN_CHAT_ID, photo: topup.receiptFileId, caption: cap, parse_mode: "HTML", reply_markup: adminKb });
    else await tg(env, "sendDocument", { chat_id: env.ADMIN_CHAT_ID, document: topup.receiptFileId, caption: cap, parse_mode: "HTML", reply_markup: adminKb });
    return;
  }

  if (user.state === "await_country_search" && text && !text.startsWith("/")) {
    user.state = null;
    await saveUser(env, user);
    return showCountrySearchResults(env, chatId, text);
  }

  if (user.state?.startsWith("await_service_search:") && text && !text.startsWith("/")) {
    const countryId = user.state.split(":")[1];
    user.state = null;
    await saveUser(env, user);
    return showServiceSearchResults(env, chatId, countryId, text);
  }

  if (user.state === "await_link_amount" && /^[0-9]+(\.[0-9]+)?$/.test(text)) {
    const creditUsd = Math.round(Number(text) * 100) / 100;
    user.state = null;
    await saveUser(env, user);
    const minTopup = minTopupUsd(await getConfig(env));
    if (!(creditUsd >= minTopup && creditUsd <= 5000)) {
      return send(env, chatId, `مبلغ شارژ باید بین ${faNum(minTopup)} تا ۵۰۰۰ دلار باشد. از منوی «افزایش موجودی» دوباره تلاش کنید.`, backKb);
    }
    const topup = await createPaySession(env, chatId, creditUsd);
    const m = await paySessionMessage(env, topup, baseUrl);
    return send(env, chatId, m.text, m.markup);
  }

  if (user.state === "await_link_amount_tmn" && /^[0-9][0-9,]*$/.test(text)) {
    const tmnAmount = Number(text.replace(/,/g, ""));
    user.state = null;
    await saveUser(env, user);
    const rate = await usdtTomanRate(env);
    if (!rate) {
      return send(env, chatId, "⚠️ نرخ تتر در حال حاضر در دسترس نیست؛ مبلغ را به دلار وارد کنید یا چند دقیقه دیگر تلاش کنید.", backKb);
    }
    const creditUsd = Math.round((tmnAmount / rate) * 100) / 100;
    const minTopup = minTopupUsd(await getConfig(env));
    if (!(creditUsd >= minTopup && creditUsd <= 5000)) {
      return send(env, chatId, `مبلغ تومانی باید معادل ${faNum(minTopup)} تا ۵۰۰۰ دلار باشد (با نرخ فعلی تتر، حدود ${faInt(Math.round(rate * minTopup))} تا ${faInt(rate * 5000)} تومان). از منوی «افزایش موجودی» دوباره تلاش کنید.`, backKb);
    }
    const topup = await createPaySession(env, chatId, creditUsd, { inputToman: tmnAmount, inputRate: rate });
    const m = await paySessionMessage(env, topup, baseUrl);
    return send(env, chatId, m.text, m.markup);
  }

  user.state = null;
  await saveUser(env, user);
  return showHome(env, chatId);
}

async function handleCallback(env, cq, baseUrl) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const data = cq.data || "";
  const [head, a, b] = data.split(":");
  try {
    if (cq.message?.chat?.type !== "private") { await answerCb(env, cq.id); return; }
    if (data === "joinchk") {
      const cfgJ = await getConfig(env);
      if (!(await forceJoinGate(env, cfgJ, chatId))) {
        await answerCb(env, cq.id, "عضویت شما تأیید شد ✅");
        return showHome(env, chatId, msgId);
      }
      return answerCb(env, cq.id, "هنوز عضو کانال نیستید؛ اول عضو شوید و بعد دوباره بزنید", true);
    }
    {
      const cfgJ = await getConfig(env);
      if (await forceJoinGate(env, cfgJ, chatId)) {
        await answerCb(env, cq.id, "🔒 ابتدا در کانال عضو شوید", true);
        return edit(env, chatId, msgId, JOIN_TEXT, joinPromptKb(cfgJ));
      }
    }
    if (data === "home") return showHome(env, chatId, msgId);
    if (data === "terms") {
      const cfgT = await getConfig(env);
      const base = cfgT.WORKER_BASE_URL || (await kvGet(env, "sys:origin"))?.origin;
      if (base) {
        await answerCb(env, cq.id, "");
        return send(env, chatId, "📜 قوانین و مقررات استفاده از BlueGate:", kb([[urlBtn("📜 مشاهده قوانین", `${String(base).replace(/\/+$/, "")}/terms`)]]));
      }
      return answerCb(env, cq.id, "لینک قوانین هنوز آماده نیست؛ چند دقیقه دیگر تلاش کنید.", true);
    }
    if (data === "csearch") {
      const user = await getUser(env, chatId);
      user.state = "await_country_search";
      await saveUser(env, user);
      return edit(env, chatId, msgId,
        `🔍 <b>جستجوی کشور</b>\n\nنام کشور را به <b>انگلیسی</b> بنویسید (مثلاً Germany یا United)؛ به نام پرتغالی و کد ISO هم جواب می‌دهد:`,
        kb([[btn("⬅️ بازگشت به فهرست کشورها", "countries:0")]]));
    }
    if (head === "ssearch") {
      const user = await getUser(env, chatId);
      user.state = `await_service_search:${a}`;
      await saveUser(env, user);
      return edit(env, chatId, msgId,
        `🔍 <b>جستجوی سرویس</b>\n\nبخشی از نام سرویس را بنویسید (مثلاً Whats یا Tele):`,
        kb([[btn("⬅️ بازگشت به فهرست سرویس‌ها", `services:${a}:0`)]]));
    }
    if (head === "countries") {
      const user = await getUser(env, chatId);
      if (user.state?.startsWith("await_country_search") || user.state?.startsWith("await_service_search")) {
        user.state = null; await saveUser(env, user);
      }
      return showCountries(env, chatId, msgId, Number(a || 0));
    }
    if (head === "services") return showServices(env, chatId, msgId, a, Number(b || 0));
    if (head === "confirm") return showConfirm(env, chatId, msgId, a, b);
    if (head === "buy") return doBuy(env, chatId, msgId, a, b, cq.id);
    if (head === "act") return refreshActivation(env, chatId, msgId, a, cq.id);
    if (head === "resend" || head === "cancel" || head === "finish") {
      const r = await actAction(env, chatId, a, head);
      if (!r.ok) {
        await answerCb(env, cq.id, r.error, true);
        if (r.refresh) return refreshActivation(env, chatId, msgId, a);
        return;
      }
      await answerCb(env, cq.id, head === "cancel" ? "لغو شد" : head === "finish" ? "پایان یافت" : "درخواست پیامک مجدد ثبت شد");
      return refreshActivation(env, chatId, msgId, a);
    }
    if (data === "balance") {
      const user = await getUser(env, chatId);
      const tmn = await usdtTomanRate(env);
      return edit(env, chatId, msgId, `💰 <b>موجودی شما:</b> ${usdText(tmn, user.balance)}\n\nموجودی به دلار است؛ معادل تومانی با نرخ لحظه‌ای تتر در صرافی والکس محاسبه می‌شود${tmn ? ` (هر تتر: ${faInt(tmn)} تومان)` : ""}.`, kb([[btn("💳 افزایش موجودی", "topup")], [btn("⬅️ منوی اصلی", "home")]]));
    }
    if (data === "orders") {
      const mine = (await kvList(env, "act:")).filter((x) => x.userId === String(chatId))
        .sort((x, y) => y.createdAt - x.createdAt).slice(0, 10);
      if (!mine.length) return edit(env, chatId, msgId, "هنوز سفارشی ندارید.", backKb);
      const rows = mine.map((o) => [btn(`📱 +${o.phoneNumber} — ${o.serviceName}`, `act:${o.id}`)]);
      rows.push([btn("⬅️ منوی اصلی", "home")]);
      return edit(env, chatId, msgId, "📱 <b>سفارش‌های اخیر شما:</b>", kb(rows));
    }
    if (data === "topup") return showTopup(env, chatId, msgId, baseUrl);
    if (data === "link_new") {
      const active = await findActiveSession(env, chatId);
      if (active) {
        const m = await paySessionMessage(env, active, baseUrl);
        return edit(env, chatId, msgId, m.text, m.markup);
      }
      return edit(env, chatId, msgId,
        `💵 <b>ساخت لینک پرداخت</b>\n\nمبلغ شارژ را با کدام واحد وارد می‌کنید؟\n\n💵 <b>دلار:</b> مبلغ شارژ را مستقیم به دلار می‌نویسید.\n🇮🇷 <b>تومان:</b> مبلغ را به تومان می‌نویسید و با نرخ لحظه‌ای تتر به دلار تبدیل می‌شود.`,
        kb([[btn("💵 مبلغ به دلار", "link_cur:USD")], [btn("🇮🇷 مبلغ به تومان", "link_cur:TMN")], [btn("⬅️ بازگشت", "topup")]]));
    }
    if (head === "link_cur") {
      const user = await getUser(env, chatId);
      if (a === "TMN") {
        const rate = await usdtTomanRate(env);
        if (!rate) {
          return edit(env, chatId, msgId,
            "⚠️ در حال حاضر نرخ تتر در دسترس نیست؛ مبلغ را به دلار وارد کنید یا چند دقیقه دیگر تلاش کنید.",
            kb([[btn("💵 مبلغ به دلار", "link_cur:USD")], [btn("⬅️ بازگشت", "topup")]]));
        }
        user.state = "await_link_amount_tmn";
        await saveUser(env, user);
        return edit(env, chatId, msgId,
          `🇮🇷 <b>ساخت لینک پرداخت — تومان</b>\n\n✍️ مبلغ شارژ را به <b>تومان</b> بنویسید (فقط عدد، مثال: 5000000):\n\nنرخ لحظه‌ای تتر: هر تتر <b>${faInt(rate)} تومان</b> — مبلغ شما با همین نرخ به دلار تبدیل می‌شود (معادل ${faNum(minTopupUsd(await getConfig(env)))} تا ۵۰۰۰ دلار).\n\nروش پرداخت را بعداً داخل صفحه پرداخت انتخاب می‌کنید و هر پرداخت ۳۰ دقیقه مهلت دارد.`,
          kb([[btn("⬅️ بازگشت", "link_new")]]));
      }
      user.state = "await_link_amount";
      await saveUser(env, user);
      return edit(env, chatId, msgId,
        `💵 <b>ساخت لینک پرداخت — دلار</b>\n\n✍️ مبلغ شارژی را که می‌خواهید به <b>دلار</b> بنویسید (فقط عدد، مثال: 50 — حداقل ${faNum(minTopupUsd(await getConfig(env)))} و حداکثر ۵۰۰۰ دلار):\n\nروش پرداخت را بعداً داخل صفحه پرداخت انتخاب می‌کنید و هر پرداخت ۳۰ دقیقه مهلت دارد.`,
        kb([[btn("⬅️ بازگشت", "link_new")]]));
    }
    if (head === "ses_cancel") {
      const done = await withKvLock(env, `topup:${a}`, async () => {
        const topup = await kvGet(env, `topup:${a}`);
        if (!topup || topup.userId !== String(chatId) || topup.status !== "pending") return false;
        topup.status = "cancelled"; topup.resolvedAt = now();
        await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
        const user = await getUser(env, chatId);
        if (user.state === "await_card_receipt" && user.stateData === topup.id) {
          user.state = null; user.stateData = null; await saveUser(env, user);
        }
        return true;
      });
      if (done) {
        await answerCb(env, cq.id, "پرداخت لغو شد");
        return showTopup(env, chatId, msgId, baseUrl);
      }
      await answerCb(env, cq.id, "این پرداخت قابل لغو نیست", true);
      return;
    }
    if (head === "chk") {
      const topup = await kvGet(env, `topup:${a}`);
      if (!topup || topup.status !== "pending") { await answerCb(env, cq.id, "این پرداخت قبلاً تعیین‌تکلیف شده است"); return; }
      if (topup.method !== "crypto") { await answerCb(env, cq.id, "اول از صفحه پرداخت، روش پرداخت را انتخاب کنید", true); return; }
      if (!(await throttle(env, `chk:${chatId}`, 6, 60))) { await answerCb(env, cq.id, "⏳ کمی صبر کنید و دوباره بزنید", true); return; }
      const fresh = await settleTopupLazy(env, topup, true);
      if (fresh.status === "approved") { await answerCb(env, cq.id, "پرداخت تأیید و حساب شارژ شد ✅"); return showHome(env, chatId, msgId); }
      if (fresh.status === "expired") { await answerCb(env, cq.id, "⏰ مهلت این پرداخت تمام شده است", true); return; }
      if (fresh.seenAt) { await answerCb(env, cq.id, "👀 تراکنش دیده شد و در انتظار تأیید شبکه است؛ به محض تأیید، خودکار شارژ می‌شود.", true); return; }
      await answerCb(env, cq.id, "هنوز واریزی با مبلغ دقیق پیدا نشد. اگر تازه واریز کرده‌اید چند دقیقه صبر کنید.", true);
      return;
    }
    if (data === "cfg" && isAdmin(env, chatId)) return showConfigOverview(env, chatId, msgId);
    if (head === "cfg_g" && isAdmin(env, chatId)) return showConfigGroup(env, chatId, msgId, a);
    if (head === "cfg_set" && isAdmin(env, chatId)) {
      const user = await getUser(env, chatId);
      user.state = `setcfg:${a}`;
      await saveUser(env, user);
      const cfg = await getConfig(env);
      return edit(env, chatId, msgId,
        `✏️ <b>${esc(settingLabel(a))}</b>\n\nمقدار فعلی: <code>${esc(cfg[a] || "— تنظیم نشده")}</code>\n\n${esc(settingHint(a))}\nمقدار جدید را همین‌جا بفرستید، یا برای لغو دکمه زیر را بزنید:`,
        kb([[btn("❌ انصراف", "cfg_cancel")]]));
    }
    if (data === "cfg_cancel" && isAdmin(env, chatId)) {
      const user = await getUser(env, chatId);
      user.state = null; await saveUser(env, user);
      return showConfigOverview(env, chatId, msgId);
    }
    if (head === "cfg_del" && isAdmin(env, chatId)) {
      await setConfigValue(env, a, "");
      await answerCb(env, cq.id, "حذف شد 🗑");
      return showConfigGroup(env, chatId, msgId, groupOfKey(a));
    }
    if (head === "cfgtgl" && isAdmin(env, chatId)) {
      const cfg = await getConfig(env);
      const on = cfg[a] === "1";
      await setConfigValue(env, a, on ? "" : "1");
      await answerCb(env, cq.id, on ? "خاموش شد ⚪️" : "روشن شد ✅");
      return showConfigGroup(env, chatId, msgId, groupOfKey(a));
    }
    if (data === "admin" && isAdmin(env, chatId)) return showAdmin(env, chatId, msgId);
    if (data === "adm_pending" && isAdmin(env, chatId)) return showPending(env, chatId, msgId, "card");
    if (data === "adm_crypto_pending" && isAdmin(env, chatId)) return showPending(env, chatId, msgId, "crypto");
    if ((head === "apr" || head === "rej") && isAdmin(env, chatId)) {
      const topup = await kvGet(env, `topup:${a}`);
      if (!topup || !["pending", "awaiting_receipt"].includes(topup.status)) { await answerCb(env, cq.id, "قبلاً تعیین‌تکلیف شده"); return; }
      if (head === "apr") {
        if (topup.method === "card" && !(topupCredit(topup) > 0)) {
          await answerCb(env, cq.id, "مبلغ شارژ این رسید صفر ثبت شده (احتمالاً نرخ والکس هنگام ثبت در دسترس نبوده). این رسید را رد کنید و از کاربر بخواهید دوباره ثبت کند.", true);
          return;
        }
        topup.status = "pending"; // creditTopup expects pending
        await kvPut(env, `topup:${topup.id}`, topup);
        await creditTopup(env, topup, "admin-approved");
        await answerCb(env, cq.id, "تأیید و شارژ شد ✅");
      } else {
        topup.status = "rejected"; topup.resolvedAt = now();
        await kvPut(env, `topup:${topup.id}`, topup);
        await send(env, topup.userId, "❌ درخواست افزایش موجودی شما رد شد. برای پیگیری با پشتیبانی در تماس باشید.", mainMenuKb(env, await getConfig(env), topup.userId));
        await answerCb(env, cq.id, "رد شد");
      }
      return showAdmin(env, chatId, msgId);
    }
  } catch (e) {
    await answerCb(env, cq.id, "خطایی رخ داد. دوباره تلاش کنید.", true);
  }
}

// ---------- wallet / payment web page (Persian) ----------
// v1.3.0: the bot only creates a dollar payment session (30-minute deadline);
// the method is chosen here on the page, and only the chosen method's wallet
// and exact amount are shown. Design v2 (v1.8.0): professional minimal — pure black,
// white text, hairline dividers, Yekan Bakh, countdown ring + auto polling.
const COIN_TICKER = { USDT_TRC20: "USDT", USDT_BEP20: "USDT", USDT_ERC20: "USDT", TRX: "TRX", BTC: "BTC", TON: "TON", LTC: "LTC", ETH: "ETH" };

async function settleTopupLazy(env, topup, force = false) {
  if (!topup || topup.status !== "pending") return topup;
  if (topup.method === "crypto") {
    // Public chain APIs are rate-limited: re-check at most every 20s per
    // topup unless a human explicitly pressed the check button (force).
    const freshEnough = topup.lastChainCheck && now() - topup.lastChainCheck < 20000;
    if (force || !freshEnough) {
      const m = await matchCryptoPayment(env, topup);
      const cur = (await kvGet(env, `topup:${topup.id}`)) || topup;
      if (cur.status === "pending") {
        cur.lastChainCheck = now();
        if (m && m.kind === "paid") {
          cur.paidTxid = m.txid;
          await kvPut(env, `topup:${cur.id}`, cur, 7 * 24 * 3600);
          await creditTopup(env, cur, "auto-chain");
          return (await kvGet(env, `topup:${topup.id}`)) || cur;
        }
        if (m && m.kind === "seen" && !cur.seenAt) {
          // Transaction is on-chain but unconfirmed: keep the payment alive
          // past the 30-minute deadline (topupExpiresAt counts from seenAt).
          cur.seenAt = now();
          cur.seenTxid = m.txid;
          await kvPut(env, `topup:${cur.id}`, cur, 7 * 24 * 3600);
          const cfg = await getConfig(env);
          await send(env, cur.userId,
            `👀 <b>تراکنش شما دیده شد</b>\n\nپرداخت $${faNum(topupCredit(cur))} در شبکه پیدا شد و در انتظار تأیید (کانفرم) است. به محض تأیید، موجودی‌تان به‌صورت خودکار شارژ می‌شود و مهلت پرداخت‌تان تا آن زمان تمدید شد.`,
            mainMenuKb(env, cfg, cur.userId));
          return cur;
        }
        await kvPut(env, `topup:${cur.id}`, cur, 7 * 24 * 3600); // persist lastChainCheck
        topup = cur;
      } else {
        topup = cur;
      }
    }
  }
  if (topupIsExpired(topup)) {
    await expireTopup(env, topup);
    return (await kvGet(env, `topup:${topup.id}`)) || topup;
  }
  return topup;
}
async function handlePayCancel(env, request) {
  const body = await request.json().catch(() => ({}));
  const topup = body.t ? await kvGet(env, `topup:${body.t}`) : null;
  if (!topup || topup.status !== "pending") return Response.json({ ok: false, error: "این پرداخت فعال نیست" }, { status: 400 });
  if (topup.seenAt) return Response.json({ ok: false, error: "تراکنش این پرداخت در شبکه دیده شده و دیگر قابل لغو نیست؛ برای پیگیری با پشتیبانی در تماس باشید" }, { status: 400 });
  if (!(await throttle(env, `cxl:${clientIp(request)}`, 20, 3600))) return Response.json({ ok: false, error: "تلاش بیش از حد" }, { status: 429 });
  const done = await withKvLock(env, `topup:${topup.id}`, async () => {
    const fresh = await kvGet(env, `topup:${topup.id}`);
    if (!fresh || fresh.status !== "pending") return false;
    fresh.status = "cancelled"; fresh.resolvedAt = now();
    await kvPut(env, `topup:${fresh.id}`, fresh, 7 * 24 * 3600);
    const u = await getUser(env, fresh.userId);
    if (u.state === "await_card_receipt" && u.stateData === fresh.id) { u.state = null; u.stateData = null; await saveUser(env, u); }
    const cfg = await getConfig(env);
    await send(env, fresh.userId, `🚫 <b>پرداخت لغو شد</b>\n\nدرخواست شارژ $${faNum(topupCredit(fresh))} از صفحه پرداخت لغو شد.`, mainMenuKb(env, cfg, fresh.userId));
    return true;
  });
  return Response.json({ ok: !!done });
}

async function handlePaySelect(env, request) {
  const body = await request.json().catch(() => ({}));
  if (!(await throttle(env, `sel:${clientIp(request)}`, 60, 3600)) || (body.t && !(await throttle(env, `sel:t:${body.t}`, 30, 3600))))
    return Response.json({ ok: false, error: "تلاش بیش از حد؛ بعداً دوباره تلاش کنید" }, { status: 429 });
  const topup = body.t ? await kvGet(env, `topup:${body.t}`) : null;
  if (!topup || topup.status !== "pending") {
    return Response.json({ ok: false, error: "این پرداخت فعال نیست" }, { status: 400 });
  }
  if (topupIsExpired(topup)) {
    await expireTopup(env, topup);
    return Response.json({ ok: false, error: "مهلت پرداخت تمام شده است" }, { status: 400 });
  }
  try {
    await applyPayMethod(env, topup, String(body.m ?? ""));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}

function payShell(body, script = "") {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#000000">
<title>پرداخت — فروشگاه شماره مجازی</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net">
<link href="https://fonts.cdnfonts.com/css/yekan-bakh" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{background:#000}
body{background:#000;color:#fff;font-family:'Yekan Bakh',Tahoma,Arial,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.9}
body:before{content:"";position:fixed;inset:0;background:radial-gradient(640px 300px at 50% -80px,rgba(255,255,255,.07),transparent 65%);pointer-events:none}
main{max-width:560px;margin:0 auto;padding:44px 22px 60px;animation:up .45s ease both}
@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px}
.mark{width:36px;height:36px;border:1px solid #fff;border-radius:11px;display:grid;place-items:center;font-size:15px;font-weight:800}
.brand b{font-size:14.5px}
.brand span{display:block;font-size:11.5px;color:#8a8a8a;line-height:1.5}
.secure{margin-inline-start:auto;font-size:11px;color:#a3a3a3;border:1px solid #262626;border-radius:999px;padding:3px 12px}
.steps{display:flex;align-items:center;gap:8px;margin:6px 0 26px}
.step{display:flex;align-items:center;gap:8px;font-size:12px;color:#6d6d6d;white-space:nowrap}
.step .dot{width:24px;height:24px;border-radius:50%;border:1px solid #333;display:grid;place-items:center;font-size:11.5px;font-weight:700}
.step.on{color:#fff}
.step.on .dot{background:#fff;color:#000;border-color:#fff}
.step.done{color:#a3a3a3}
.step.done .dot{background:#fff;border-color:#fff;color:#000}
.steps .line{flex:1;height:1px;background:#1e1e1e;min-width:14px}
h1{font-size:24px;font-weight:800;letter-spacing:-.01em}
.sub{color:#a3a3a3;font-size:13.5px;margin:6px 0 22px}
.summary{display:flex;align-items:center;gap:14px;background:#0a0a0a;border:1px solid #232323;border-radius:20px;padding:16px 20px;margin-bottom:8px}
.summary .k{font-size:11.5px;color:#8a8a8a}
.summary .v{font-size:32px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums;line-height:1.25}
.summary .vt{font-size:12px;color:#a3a3a3}
.timer{margin-inline-start:auto;text-align:center}
.timer .cd{font-size:19px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums;line-height:1.3}
.timer .k{font-size:10.5px;color:#8a8a8a}
.timebar{height:3px;background:#1a1a1a;border-radius:99px;overflow:hidden;margin:10px 0 20px}
.timebar i{display:block;height:100%;background:#fff;border-radius:99px;transition:width .3s linear}
.timer.low .cd,.timer.low .k{color:#ff9f43}
.timebar.low i{background:#ff9f43}
.method{display:flex;align-items:center;gap:14px;width:100%;text-align:start;background:transparent;border:0;border-top:1px solid #1c1c1c;padding:17px 4px;cursor:pointer;color:#fff;font-family:inherit;transition:background .15s,transform .1s;border-radius:6px}
.method:active{transform:scale(.99)}
.method:hover{background:#0d0d0d}
.method .tick{width:46px;height:46px;flex:none;border:1px solid #2c2c2c;border-radius:13px;display:grid;place-items:center;font-size:10.5px;font-weight:800;letter-spacing:.04em;background:#0a0a0a}
.method .nm{font-size:15px;font-weight:700;line-height:1.6}
.method .ap{font-size:12px;color:#8a8a8a;direction:ltr;text-align:left;font-variant-numeric:tabular-nums}
.method .ch{margin-inline-start:auto;color:#5c5c5c;font-size:19px;flex:none}
.method .inf{flex:1}
.paywrap{display:flex;gap:18px;align-items:center;background:#0a0a0a;border:1px solid #232323;border-radius:20px;padding:18px;margin:4px 0 14px}
.ring{position:relative;width:66px;height:66px;flex:none}
.ring svg{transform:rotate(-90deg)}
.ring .rc{position:absolute;inset:0;display:grid;place-items:center;font-size:13.5px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums}
.paywrap .st{font-size:12px;color:#a3a3a3}
.paywrap .st b{color:#fff;font-size:14px}
.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-inline-end:6px;animation:pl 1.6s infinite}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid #3a2a12;background:rgba(255,159,67,.08);color:#ff9f43;border-radius:999px;padding:5px 14px;font-size:12.5px;font-weight:700}
.pill .dot{width:7px;height:7px;border-radius:50%;background:#ff9f43;animation:pl 1.6s infinite}
@keyframes pl{0%,100%{opacity:1}50%{opacity:.25}}
.amtbox{border:1px solid #fff;border-radius:20px;padding:20px;margin-bottom:14px}
.amtbox .k{font-size:12px;color:#a3a3a3;margin-bottom:4px}
.amtbox .amt{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.amtbox .amt span{font-size:30px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.addr-box{display:flex;align-items:center;gap:10px;background:#0a0a0a;border:1px solid #262626;border-radius:13px;padding:11px 13px;margin-bottom:6px}
.addr{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all;direction:ltr;text-align:left;color:#e5e5e5}
.copy{flex:none;background:transparent;color:#fff;border:1px solid #3f3f3f;border-radius:999px;padding:5px 14px;font-family:inherit;font-size:12.5px;cursor:pointer;transition:all .15s}
.copy:hover{background:#fff;color:#000;border-color:#fff}
.copy.done{background:#fff;color:#000;border-color:#fff}
.qrwrap{display:flex;justify-content:center;padding:10px 0 2px}
.qr{background:#fff;border-radius:14px;padding:7px}
.notes{margin:14px 0 20px}
.notes li{list-style:none;color:#a3a3a3;font-size:13px;padding:7px 0;border-top:1px solid #161616;display:flex;gap:10px}
.notes li b{color:#fff;font-weight:700}
.btnrow{display:flex;gap:10px;flex-wrap:wrap}
.btn{flex:1;min-width:150px;background:#fff;color:#000;border:1px solid #fff;border-radius:13px;padding:12px 18px;font-family:inherit;font-size:14.5px;font-weight:800;cursor:pointer;transition:all .15s}
.btn:hover{background:#e5e5e5}
.btn:active{transform:scale(.985)}
.btn:disabled{opacity:.55;cursor:wait}
.btn.ghost{background:transparent;color:#fff;border-color:#3a3a3a;font-weight:600}
.btn.ghost:hover{border-color:#fff;background:transparent}
.state{text-align:center;padding:28px 0 6px}
.state .circ{width:76px;height:76px;margin:0 auto 18px;border:1.5px solid #fff;border-radius:50%;display:grid;place-items:center;font-size:32px;animation:pop .4s cubic-bezier(.2,.9,.3,1.4) both}
@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
.state .circ.fill{background:#fff;color:#000;border-color:#fff}
.state .circ.red{border-color:#ff453a;color:#ff453a}
.state .circ.orange{border-color:#ff9f43;color:#ff9f43}
.state h1.red{color:#ff453a}
.state h1.orange{color:#ff9f43}
.state h1{margin-bottom:6px}
.state p{color:#a3a3a3;font-size:14px;max-width:40ch;margin:0 auto}
.state .big{font-size:21px;font-weight:800;color:#fff;direction:ltr;margin-top:12px}
.bankcard{position:relative;overflow:hidden;aspect-ratio:1.586;max-width:430px;margin:0 auto 16px;border-radius:20px;padding:20px 22px;color:#fff;background:linear-gradient(145deg,#1b1b1b 0%,#050505 52%,#121212 100%);border:1px solid #2b2b2b;box-shadow:0 22px 44px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:space-between;text-align:start}
.bankcard:before{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.055) 45%,transparent 60%);pointer-events:none}
.bankcard>*{position:relative}
.bc-top{display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:15px}
.bc-type{font-size:11px;font-weight:600;color:#a3a3a3}
.bc-mid{display:flex;justify-content:space-between;align-items:center}
.bc-chip{width:46px;height:34px;flex:none;border-radius:7px;background:linear-gradient(145deg,#e8e8e8,#9a9a9a 55%,#cfcfcf);box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);position:relative}
.bc-chip:before,.bc-chip:after{content:"";position:absolute;left:0;right:0;height:1px;background:rgba(0,0,0,.35)}
.bc-chip:before{top:11px}
.bc-chip:after{top:22px}
.bc-num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:clamp(16px,5.2vw,22px);letter-spacing:.13em;text-align:left;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.35);white-space:nowrap}
.bc-bot{display:flex;justify-content:space-between;align-items:flex-end;gap:10px}
.bc-k{font-size:10px;opacity:.7;margin-bottom:2px}
.bc-holder{font-size:14.5px;font-weight:700}
.bc-copy{border-color:rgba(255,255,255,.55);color:#fff}
.bc-copy:hover{background:#fff;color:#000;border-color:#fff}
.upload{border:1.5px dashed #3a3a3a;border-radius:18px;padding:20px;text-align:center;margin:16px 0 6px;transition:border-color .15s}
.upload:hover{border-color:#8a8a8a}
.upload .uic{font-size:26px}
.upload p{color:#a3a3a3;font-size:13px;margin:6px 0 4px;line-height:1.9}
.upload p b{color:#fff}
.upload img{max-width:180px;max-height:180px;border-radius:12px;margin:10px auto 4px;display:none}
.upload .fname{font-size:12px;color:#8a8a8a;direction:ltr}
footer{margin-top:38px;padding-top:18px;border-top:1px solid #1c1c1c;color:#737373;font-size:12.5px}
footer a{color:#a3a3a3}
#toast{position:fixed;bottom:26px;left:50%;transform:translate(-50%,16px);background:#fff;color:#000;font-size:13px;font-weight:700;padding:8px 20px;border-radius:999px;opacity:0;pointer-events:none;transition:all .25s;z-index:9;max-width:88vw;text-align:center}
#toast.show{opacity:1;transform:translate(-50%,0)}
@media (max-width:480px){.amtbox .amt span{font-size:23px}h1{font-size:21px}.method .ap{display:none}}
.payfoot{display:flex;gap:10px;margin-top:26px;padding-top:18px;border-top:1px solid #1c1c1e}
.footbtn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;background:transparent;color:#d6d6da;border:1px solid #2c2c31;border-radius:12px;padding:11px 10px;font-family:inherit;font-size:13.5px;cursor:pointer;text-decoration:none}
.footbtn.danger{color:#ff6b61;border-color:#3d1d1a}
</style></head>
<body><main>
<header class="brand"><div class="mark">S</div><div><b>فروشگاه شماره مجازی</b><span>درگاه پرداخت</span></div><div class="secure">پرداخت امن</div></header>
${body}
<footer>مبلغ و آدرس را پیش از واریز یک‌بار دیگر بررسی کنید. هر پرداخت ۳۰ دقیقه مهلت دارد؛ پس از آن، درخواست به‌صورت خودکار بسته می‌شود.</footer>
</main>
<div id="toast"></div>
<script>
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200)}
function copyText(text,btn){var done=function(){toast('کپی شد');if(btn&&!btn._cp){btn._cp=1;var o=btn.textContent;btn.textContent='✓ کپی شد';btn.classList.add('done');setTimeout(function(){btn.textContent=o;btn.classList.remove('done');btn._cp=0},1500)}};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(done)}else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();done()}}
${script}
</script>
</body></html>`;
}

function paySteps(active) {
  const names = ["انتخاب روش", "پرداخت", "تأیید شارژ"];
  const parts = names.map((n, i) => {
    const cls = i + 1 < active ? "step done" : i + 1 === active ? "step on" : "step";
    const inner = i + 1 < active ? "✓" : String(i + 1);
    return `<div class="${cls}"><span class="dot">${inner}</span>${n}</div>`;
  });
  return `<div class="steps">${parts.join('<div class="line"></div>')}</div>`;
}

function payScript(topup, poll) {
  const expiresAt = topupExpiresAt(topup);
  return `
var TID='${esc(topup.id)}', EXP=${expiresAt}, SPAN=${PAY_TTL_MS}, HAS_RECEIPT=${topup.receiptFileId ? "true" : "false"};
function pad(n){return (n<10?'0':'')+n}
function tick(){var ms=EXP-Date.now();var s=Math.max(0,Math.floor(ms/1000));var txt=pad(Math.floor(s/60))+':'+pad(s%60);document.querySelectorAll('.cd').forEach(function(e){e.textContent=txt});var low=ms<5*60*1000;document.querySelectorAll('.timer').forEach(function(e){e.classList.toggle('low',low)});var tb=document.querySelector('.timebar');if(tb)tb.classList.toggle('low',low);var bar=document.getElementById('timebar');if(bar)bar.style.width=Math.max(0,ms/SPAN*100)+'%';var ring=document.getElementById('ringfg');if(ring){var C=163.36;ring.style.strokeDashoffset=C*(1-Math.max(0,ms)/SPAN);ring.style.stroke=low?'#ff9f43':'#fff'}var rc=document.querySelector('.rc');if(rc)rc.style.color=low?'#ff9f43':'';if(ms<=0&&!window._exp){window._exp=1;setTimeout(function(){location.reload()},1500)}}
setInterval(tick,250);tick();
async function selectMethod(m){toast('در حال ثبت روش پرداخت…');try{var r=await fetch('/pay/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:TID,m:m})});var d=await r.json().catch(function(){return{}});if(d.ok){location.reload()}else{toast(d.error||'خطا رخ داد')}}catch(e){toast('خطا در ارتباط')}};
async function checkNow(btn){btn.disabled=true;btn.textContent='در حال بررسی…';try{var r=await fetch('/pay/status?t='+TID+'&_='+Date.now(),{cache:'no-store'});var d=await r.json();if(d.status!=='pending'){location.reload();return}toast('هنوز پرداختی پیدا نشد؛ اگر تازه واریز کرده‌اید چند دقیقه صبر کنید')}catch(e){toast('خطا در بررسی')}btn.disabled=false;btn.textContent='🔄 بررسی پرداخت'}
function onReceiptFile(inp){var f=inp.files&&inp.files[0];var prev=document.getElementById('rcPrev');var btn=document.getElementById('rcBtn');var nm=document.getElementById('rcName');if(!f){if(btn)btn.disabled=true;return}if(nm)nm.textContent=f.name;if(prev){prev.src=URL.createObjectURL(f);prev.style.display='block'}if(btn)btn.disabled=false}
async function submitReceipt(btn){var inp=document.getElementById('rcFile');if(!inp||!inp.files||!inp.files[0]){toast('اول عکس رسید را انتخاب کنید');return}btn.disabled=true;btn.textContent='در حال ارسال…';try{var fd=new FormData();fd.append('receipt',inp.files[0]);var r=await fetch('/pay/receipt?t='+TID,{method:'POST',body:fd});var d=await r.json().catch(function(){return{}});if(d.ok){toast('رسید ثبت شد');setTimeout(function(){location.reload()},700)}else{toast(d.error||'خطا در ثبت رسید');btn.disabled=false;btn.textContent='📤 ثبت رسید'}}catch(e){toast('خطا در ارتباط');btn.disabled=false;btn.textContent='📤 ثبت رسید'}}
async function pollStatus(){try{var r=await fetch('/pay/status?t='+TID+'&_='+Date.now(),{cache:'no-store'});var d=await r.json();if(d.status!=='pending'||(!!d.receipt)!==HAS_RECEIPT)location.reload()}catch(e){}}
async function checkStatusBtn(btn){btn.disabled=true;btn.textContent='در حال بررسی…';await pollStatus();setTimeout(function(){toast('هنوز تأیید نشده؛ به محض تأیید ادمین، صفحه خودکار به‌روز می‌شود');btn.disabled=false;btn.textContent='🔄 بررسی وضعیت'},700)}
${poll ? "setInterval(pollStatus,5000);document.addEventListener('visibilitychange',function(){if(!document.hidden)pollStatus()});window.addEventListener('focus',pollStatus);pollStatus();" : ""}`;
}

// ---------- Terms page (/terms) ----------
// Distilled, Persian-only version of the service rules under the BlueGate
// brand (per Reza's request): only the rules that actually matter, no
// mention of the upstream provider anywhere on the page.
function termsPage(cfg) {
  const support = cfg?.SUPPORT_USERNAME;
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>قوانین و مقررات — BlueGate</title>
<link href="https://fonts.cdnfonts.com/css/yekan-bakh" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:'Yekan Bakh',Tahoma,sans-serif;padding:28px 16px 48px;line-height:1.9}
.wrap{max-width:620px;margin:0 auto}
.brand{color:#8e8e93;font-size:13px;letter-spacing:.5px}
h1{font-size:24px;font-weight:800;margin:4px 0 6px}
.intro{color:#c9c9ce;font-size:14.5px}
hr{border:none;border-top:1px solid #1f1f22;margin:20px 0}
section{padding:16px 0;border-bottom:1px solid #1f1f22}
section:last-of-type{border-bottom:none}
h2{font-size:16.5px;font-weight:700;margin-bottom:6px}
p,li{color:#c9c9ce;font-size:14.5px}
ul{padding-right:18px}
a{color:#fff}
.foot{color:#8e8e93;font-size:13px;margin-top:22px}
.backbtn{display:inline-flex;align-items:center;gap:6px;background:transparent;color:#d6d6da;border:1px solid #2c2c31;border-radius:11px;padding:8px 14px;font-family:inherit;font-size:13.5px;cursor:pointer;margin-bottom:16px}
</style></head><body><div class="wrap">
<div class="brand">BlueGate</div>
<button class="backbtn" onclick="if(history.length>1){history.back()}else{location.href='/app'}">‹ بازگشت</button>
<h1><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg> قوانین و مقررات</h1>
<p class="intro">استفاده از ربات و خدمات BlueGate به‌معنای خواندن و پذیرفتن این قوانین است. اگر با هر بخش مخالفید، از خدمات استفاده نکنید.</p>
<hr>
<section><h2>۱) ماهیت سرویس</h2><p>BlueGate شماره‌های مجازی <b>موقت</b> برای دریافت پیامک ارائه می‌کند. ارسال و تحویل پیامک به اپراتورها، زیرساخت مخابراتی و سیاست‌های سرویس مقصد بستگی دارد؛ بنابراین تحویل پیامک در همه موارد قابل تضمین نیست.</p></section>
<section><h2>۲) حساب و امنیت</h2><p>مسئولیت امنیت حساب تلگرام و دستگاه‌های شما با خودتان است. هر عملیاتی که از حساب شما انجام شود، انجام‌شده توسط شما محسوب می‌شود. حساب خود را در اختیار دیگران قرار ندهید.</p></section>
<section><h2>۳) استفاده مجاز</h2><p>استفاده از شماره‌ها فقط برای اهداف قانونی مجاز است. موارد زیر <b>ممنوع</b> است:</p><ul>
<li>کلاهبرداری، فیشینگ و پول‌شویی</li>
<li>سوءاستفاده از هویت دیگران</li>
<li>اسپم، مزاحمت و آزار</li>
<li>نفوذ یا دسترسی غیرمجاز به حساب دیگران</li>
<li>ساخت یا اداره حساب با هدف نقض قوانین سرویس‌های دیگر</li>
<li>هرگونه فعالیت غیرقانونی</li></ul>
<p>مسئولیت کامل نحوه استفاده از شماره خریداری‌شده با کاربر است.</p></section>
<section><h2>۴) مهلت شماره و فعال‌سازی</h2><p>هر شماره مهلت محدودی دارد که هنگام خرید نمایش داده می‌شود. پس از پایان مهلت، شماره از دسترس خارج می‌شود، پیام‌های قبلی حذف می‌شوند و شماره ممکن است دوباره عرضه شود. از شماره موقت به‌عنوان تنها روش بازیابی حساب‌های مهم استفاده نکنید.</p></section>
<section><h2>۵) عدم تضمین پذیرش توسط سرویس مقصد</h2><p>BlueGate ساخت حساب، تأیید ثبت‌نام، ماندگاری حساب یا پذیرش شماره توسط سرویس مقصد (مانند تلگرام، واتس‌اپ و…) را تضمین نمی‌کند. رد شدن یک شماره توسط سرویس مقصد، به‌تنهایی به‌معنای خطای فنی BlueGate نیست. BlueGate با این سرویس‌ها وابستگی یا شراکت ندارد و نام آن‌ها صرفاً برای شناسایی سرویس درخواستی استفاده می‌شود.</p></section>
<section><h2>۶) موجودی و قیمت‌ها</h2><p>موجودی حساب فقط برای خرید در همین ربات است و قابل فروش یا انتقال به دیگران نیست. قیمت‌ها بر اساس کشور، سرویس و موجودی تعیین می‌شوند و ممکن است در هر زمان تغییر کنند؛ تغییر قیمت بر خریدهای قبلی اثری ندارد.</p></section>
<section><h2>۷) بازگشت وجه</h2><p>اگر پیامکی دریافت نشود و فعال‌سازی لغو یا منقضی شود، مبلغ به موجودی حساب شما برمی‌گردد. اگر شماره در سرویس مقصد مسدود یا قبلاً استفاده شده باشد، برای بررسی بازگشت وجه باید مدرک قابل‌بررسی — یک ویدیوی پیوسته که پیام مسدودی و فعال‌سازی شما در ربات را نشان دهد — برای پشتیبانی ارسال شود. مدرک ناقص یا نامرتبط با فعال‌سازی قابل پذیرش نیست.</p></section>
<section><h2>۸) پرداخت و شارژ حساب</h2><p>سفارش‌های شارژ ممکن است برای بررسی‌های ضدتقلب مدتی در وضعیت انتظار بمانند. زمان تأیید پرداخت‌های رمزارزی به تأیید شبکه بلاک‌چین بستگی دارد.</p></section>
<section><h2>۹) تعلیق دسترسی</h2><p>در صورت تقلب یا تلاش برای تقلب، سوءاستفاده، نقض این قوانین یا ایجاد ریسک امنیتی، BlueGate می‌تواند دسترسی حساب را محدود یا مسدود کند. مسدودی به‌معنای ضبط موجودی نیست و وضعیت موجودی از طریق پشتیبانی قابل پیگیری است.</p></section>
<section><h2>۱۰) دسترس‌پذیری سرویس</h2><p>سرویس ممکن است برای نگهداری، به‌روزرسانی یا به‌علت اختلال زیرساخت و اپراتورها موقتاً در دسترس نباشد؛ کارکرد بدون وقفه و بدون خطا تضمین نمی‌شود.</p></section>
<section><h2>۱۱) حریم خصوصی</h2><p>اطلاعات و سوابق فنی لازم برای ارائه سرویس، امنیت، جلوگیری از تقلب و پشتیبانی نگهداری می‌شوند و فقط در مواردی که قانون مقرر کند در اختیار مراجع ذی‌صلاح قرار می‌گیرند.</p></section>
<section><h2>۱۲) پشتیبانی و پیگیری</h2><p>برای پیگیری هر مشکل، آیدی عددی، زمان خرید، شرح مشکل و در صورت نیاز رسید پرداخت یا تصویر/ویدیو را برای پشتیبانی ارسال کنید؛ اطلاعات ناقص، بررسی را به تأخیر می‌اندازد.</p>${support ? `<p style="margin-top:8px">پشتیبانی: <a href="https://t.me/${esc(support)}">@${esc(support)}</a></p>` : ""}</section>
<section><h2>۱۳) تغییر قوانین</h2><p>این قوانین ممکن است به‌روزرسانی شوند. نسخه معتبر همیشه در همین صفحه منتشر می‌شود و ادامه استفاده از ربات به‌معنای پذیرش نسخه جدید است.</p></section>
<p class="foot">BlueGate — دروازه‌ای امن به دنیای پرسرعت<br><a href="/app">بازگشت به صفحه اصلی فروشگاه</a></p>
</div></body></html>`;
}

// ---------- web app: Telegram login, sessions, JSON API ----------
const jsonResp = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
});
const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmacSha256Hex(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
// Telegram Login Widget verification: secret = SHA256(bot token), then
// HMAC-SHA256 over the sorted "key=value" lines of the payload.
async function verifyTelegramAuth(env, data) {
  if (!env.TELEGRAM_BOT_TOKEN || !data || !data.hash || !data.id) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(data.auth_date || 0)) > 3600) return false; // 1h replay window
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  const check = Object.keys(data).filter((k) => k !== "hash").sort().map((k) => `${k}=${data[k]}`).join("\n");
  const sig = await hmacSha256Hex(secret, check);
  const a = new TextEncoder().encode(sig);
  const b = new TextEncoder().encode(String(data.hash));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function kvDel(env, key) { if (env.STORE) await env.STORE.delete(key); }
const SESSION_TTL = 7 * 24 * 3600; // 7 days
async function createSession(env, profile) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  await kvPut(env, `sess:${token}`, {
    userId: String(profile.id), name: profile.first_name || "",
    username: profile.username || "", photoUrl: profile.photo_url || "", createdAt: now(),
  }, SESSION_TTL);
  return token;
}
function sessionTokenFrom(request) {
  // Bearer first: some browsers/WebViews drop or delay cookies on fetch,
  // which used to strand users on the login screen right after a good login.
  const bm = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") || "");
  if (bm) return bm[1];
  const m = /(?:^|;\s*)bg_sess=([a-f0-9]{64})/.exec(request.headers.get("cookie") || "");
  return m ? m[1] : null;
}
async function getSession(env, request) {
  const t = sessionTokenFrom(request);
  if (!t) return null;
  const sess = await kvGet(env, `sess:${t}`);
  return sess ? { token: t, ...sess } : null;
}
const HTML_SEC = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
const sessionCookie = (token) => `bg_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
async function botUsername(env) {
  const cached = await kvGet(env, "sys:botinfo");
  if (cached?.username) return cached.username;
  const me = await tg(env, "getMe", {}).catch(() => null);
  const u = me?.result?.username || "";
  if (u) { try { await kvPut(env, "sys:botinfo", { username: u, at: now() }); } catch (_) {} }
  return u;
}
const apiAct = (act, rec) => ({
  id: act.id ?? rec?.id,
  phone: act.phoneNumber ? `+${act.phoneNumber}` : (rec?.phoneNumber ? `+${rec.phoneNumber}` : ""),
  serviceName: rec?.serviceName || act.service?.name || "",
  status: act.status || rec?.status || "",
  code: act.latestCode || null,
  codes: act.codes || [],
  expiresAt: act.expiresAt || null,
  createdAt: rec?.createdAt || null,
  price: rec?.price ?? null,
});

async function handleApi(env, request, url) {
  const path = url.pathname;
  try {
    if (path === "/api/auth/telegram" && request.method === "POST") {
      if (!(await throttle(env, `auth:${clientIp(request)}`, 10, 60))) return jsonResp({ error: "تلاش بیش از حد؛ یک دقیقه دیگر دوباره تلاش کنید" }, 429);
      const data = await request.json().catch(() => null);
      if (!(await verifyTelegramAuth(env, data))) return jsonResp({ error: "ورود ناموفق بود؛ دوباره تلاش کنید" }, 401);
      await getUser(env, data.id); // ensure the shared bot/web account exists
      const token = await createSession(env, data);
      return jsonResp({ ok: true, token }, 200, { "set-cookie": sessionCookie(token) });
    }
    if (path === "/api/auth/logout" && request.method === "POST") {
      const sess = await getSession(env, request);
      if (sess) await kvDel(env, `sess:${sess.token}`);
      return jsonResp({ ok: true }, 200, { "set-cookie": "bg_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
    }
    const sess = await getSession(env, request);
    if (!sess) return jsonResp({ error: "unauthorized" }, 401);
    const userId = sess.userId;

    if (path === "/api/me") {
      const [user, rate, cfg] = await Promise.all([getUser(env, userId), usdtTomanRate(env), getConfig(env)]);
      return jsonResp({ id: userId, name: sess.name, username: sess.username, photoUrl: sess.photoUrl, balance: Number(user.balance), rate, support: cfg.SUPPORT_USERNAME || null, minTopup: minTopupUsd(cfg) });
    }
    if (path === "/api/countries") {
      const countries = await smsfull(env, "/countries");
      return jsonResp({ countries: countries.map((c) => ({ id: c.id, name: countryEnName(c), emoji: c.emoji || "🌍" })) });
    }
    if (path === "/api/services") {
      const countryId = url.searchParams.get("countryId");
      const cfg = await getConfig(env);
      const [fx, rate] = await Promise.all([brlToUsdRate(env), usdtTomanRate(env)]);
      const services = await smsfull(env, `/services?countryId=${countryId}`);
      return jsonResp({ rate, services: services.filter((x) => x.available > 0).map((x) => ({ id: x.id, name: x.name, available: x.available, priceUsd: fx ? sellPrice(cfg, x.price * fx) : null })) });
    }
    if (path === "/api/buy" && request.method === "POST") {
      const cfgJ = await getConfig(env);
      if (await forceJoinGate(env, cfgJ, userId)) return jsonResp({ error: "🔒 برای خرید، ابتدا در کانال ما عضو شوید و سپس در ربات دکمه «بررسی عضویت» را بزنید.", joinUrl: joinChannelLink(cfgJ) }, 403);
      if (!(await throttle(env, `buy:${userId}`, 10, 60))) return jsonResp({ error: "تعداد درخواست خرید بیش از حد است؛ کمی صبر کنید" }, 429);
      const body = await request.json().catch(() => ({}));
      try {
        const r = await buyActivation(env, userId, body.countryId, body.serviceId);
        const rec = await kvGet(env, `act:${r.act.id}`);
        return jsonResp({ activation: apiAct(r.act, rec) });
      } catch (e) {
        if (e.kind === "provider") {
          const msgs = {
            noNumbersAvailable: "متأسفانه در این لحظه شماره‌ای موجود نیست.",
            insufficientBalance: "موجودی فروشگاه نزد تأمین‌کننده کافی نیست. لطفاً با پشتیبانی تماس بگیرید.",
            priceChanged: "قیمت در لحظه خرید تغییر کرد. لطفاً دوباره تلاش کنید.",
          };
          return jsonResp({ error: msgs[e.code] || e.message }, 400);
        }
        return jsonResp({ error: e.message, kind: e.kind || null, price: e.price ?? null }, 400);
      }
    }
    if (path === "/api/orders") {
      const mine = (await kvList(env, "act:")).filter((x) => x.userId === String(userId))
        .sort((x, y) => y.createdAt - x.createdAt).slice(0, 50);
      return jsonResp({ orders: mine.map((o) => ({ id: o.id, phone: `+${o.phoneNumber}`, serviceName: o.serviceName, status: o.status, price: o.price, createdAt: o.createdAt })) });
    }
    if (path === "/api/activation") {
      const id = url.searchParams.get("id");
      const rec0 = await kvGet(env, `act:${id}`);
      if (!rec0 || rec0.userId !== String(userId)) return jsonResp({ error: "سفارش یافت نشد" }, 404);
      const { act, rec } = await syncActivation(env, id);
      return jsonResp({ activation: apiAct(act, rec) });
    }
    if (path === "/api/activation/action" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!["resend", "cancel", "finish"].includes(body.action)) return jsonResp({ error: "عملیات نامعتبر" }, 400);
      const r = await actAction(env, userId, body.id, body.action);
      if (!r.ok) return jsonResp({ error: r.error }, 400);
      const rec = await kvGet(env, `act:${body.id}`);
      return jsonResp({ activation: apiAct(r.act, rec) });
    }
    if (path === "/api/topup" && request.method === "POST") {
      const cfgJ = await getConfig(env);
      if (await forceJoinGate(env, cfgJ, userId)) return jsonResp({ error: "🔒 برای شارژ حساب، ابتدا در کانال ما عضو شوید و سپس در ربات دکمه «بررسی عضویت» را بزنید.", joinUrl: joinChannelLink(cfgJ) }, 403);
      const body = await request.json().catch(() => ({}));
      let creditUsd = null;
      const extra = {};
      if (body.amountTmn != null) {
        const rate = await usdtTomanRate(env);
        if (!rate) return jsonResp({ error: "نرخ تتر در حال حاضر در دسترس نیست؛ مبلغ را به دلار وارد کنید" }, 400);
        creditUsd = Math.round((Number(body.amountTmn) / rate) * 100) / 100;
        extra.inputToman = Number(body.amountTmn);
        extra.inputRate = rate;
      } else {
        creditUsd = Number(body.amountUsd);
      }
      const minTopup = minTopupUsd(cfgJ);
      if (!(creditUsd >= minTopup && creditUsd <= 5000)) return jsonResp({ error: `مبلغ باید معادل ${faNum(minTopup)} تا ۵۰۰۰ دلار باشد` }, 400);
      // Same rule as the bot: only one active payment session per user.
      const mine = (await kvList(env, "topup:")).filter((t) => t.userId === String(userId) && t.status === "pending");
      const active = mine.find((t) => !topupIsExpired(t));
      if (active) return jsonResp({ error: "یک پرداخت فعال دارید؛ اول آن را تکمیل یا لغو کنید", payUrl: `${url.origin}/pay?t=${active.id}` }, 400);
      const topup = await createPaySession(env, userId, creditUsd, extra);
      return jsonResp({ payUrl: `${url.origin}/pay?t=${topup.id}`, expiresAt: topup.expiresAt });
    }
    return jsonResp({ error: "not found" }, 404);
  } catch (e) {
    return jsonResp({ error: String(e?.message || e) }, 500);
  }
}

// ---------- web app page (/app) ----------
// Single-page app in the same black-and-white design as /pay and the
// approved preview: Telegram login, shop, services, live activation,
// orders and top-up — all backed by the JSON API above and the same
// accounts/balances as the bot.
async function appPage(env, cfg) {
  const username = await botUsername(env);
  const widget = username
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${esc(username)}" data-size="large" data-radius="12" data-onauth="onTelegramAuth(user)" data-request-access="write"></script>`
    : `<p class="small">دکمه ورود در دسترس نیست؛ از ربات تلگرام استفاده کنید.</p>`;
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BlueMajazi — شماره مجازی</title>
<link href="https://fonts.cdnfonts.com/css/yekan-bakh" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:'Yekan Bakh',Tahoma,sans-serif;min-height:100vh}
.wrap{max-width:430px;margin:0 auto;padding:22px 20px 122px;position:relative}
.wrap:before{content:"";position:absolute;top:-120px;left:50%;transform:translateX(-50%);width:340px;height:220px;background:radial-gradient(closest-side,rgba(255,255,255,.09),transparent);pointer-events:none}
.brandrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;position:relative}
.logo{font-weight:800;font-size:17px}
.logo span{color:#8e8e93;font-weight:400;font-size:12px;display:block}
.userchip{display:flex;align-items:center;gap:8px}
.balpill{border:1px solid #2c2c31;border-radius:999px;padding:5px 12px;font-size:13px;color:#fff;background:none;font-family:inherit;cursor:pointer}
.avatar{width:32px;height:32px;border-radius:50%;background:#fff;color:#000;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:14px;overflow:hidden;border:none;cursor:pointer;padding:0}
.avatar img{width:100%;height:100%;object-fit:cover}
.hero{text-align:center;padding:48px 6px 0}
.hero .big{font-size:30px;font-weight:800;line-height:1.5}
.hero .slogan{color:#9a9aa2;margin-top:8px;font-size:14.5px;line-height:1.9}
.tgwrap{margin:30px 0 6px;display:flex;justify-content:center;min-height:48px}
.feats{margin:22px 0 0;text-align:right}
.feats div{padding:11px 2px;border-bottom:1px solid #1b1b1f;color:#c9c9ce;font-size:14px}
.feats div:last-child{border-bottom:none}
.foot{margin-top:26px;color:#6d6d75;font-size:12px;text-align:center;line-height:1.9}
.foot a,.linklike{color:#9a9aa2}
.balcard{border:1px solid #26262b;border-radius:18px;padding:16px;margin-bottom:16px;background:linear-gradient(180deg,#101012,#0a0a0b)}
.balcard .lbl{color:#8e8e93;font-size:12.5px}
.balcard .amt{font-size:27px;font-weight:800;margin:2px 0}
.balcard .tmn{color:#9a9aa2;font-size:13px}
.wbtn{background:#fff;color:#000;border:none;border-radius:11px;padding:11px 16px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer;display:inline-block;text-decoration:none;text-align:center}
.gbtn{background:transparent;color:#fff;border:1px solid #333338;border-radius:11px;padding:11px 16px;font-family:inherit;font-size:14px;cursor:pointer}
.gbtn:disabled{opacity:.45;cursor:default}
.search{width:100%;background:#101012;border:1px solid #26262b;border-radius:12px;color:#fff;padding:11px 14px;font-family:inherit;font-size:14px;margin-bottom:14px}
.search::placeholder{color:#6d6d75}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.country{border:1px solid #232328;border-radius:14px;padding:13px 12px;cursor:pointer;background:#0c0c0e;text-align:right;font-family:inherit;color:#fff;width:100%}
.country .nm{font-size:15px;font-weight:700;margin-top:4px}
.country .fl{font-size:21px}
.nav{position:fixed;bottom:calc(12px + env(safe-area-inset-bottom));right:50%;transform:translateX(50%);width:calc(100% - 28px);max-width:402px;background:rgba(23,23,27,.55);-webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%);border:1px solid rgba(255,255,255,.14);border-radius:26px;box-shadow:0 18px 50px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.09);padding:7px;display:flex;gap:4px;z-index:5}
.nav button,.nav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;color:#b9b9c0;font-size:11px;font-family:inherit;cursor:pointer;text-decoration:none;padding:7px 2px 6px;border-radius:19px;transition:background .2s,color .2s}
.nav .on{background:rgba(255,255,255,.94);color:#000;font-weight:700}
.icn{flex:none;vertical-align:-4px}
h2.title .icn{vertical-align:-5px;margin-left:2px}
.feats .icn{vertical-align:-5px;margin-left:7px}
.back{color:#9a9aa2;font-size:13.5px;cursor:pointer;margin-bottom:10px;background:none;border:none;font-family:inherit;padding:0}
.svc{display:flex;align-items:center;justify-content:space-between;width:100%;padding:13px 2px;border-bottom:1px solid #1b1b1f;cursor:pointer;background:none;border-top:none;border-left:none;border-right:none;color:#fff;font-family:inherit;text-align:right}
.svc.sel{background:#101013}
.svc .nm{font-weight:700;font-size:15px}
.svc .st{color:#8e8e93;font-size:12px;margin-top:1px}
.svc .pr{text-align:left;flex:none}
.svc .pr .usd{font-weight:800}
.svc .pr .tmn{color:#8e8e93;font-size:12px}
.sheetwrap{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;pointer-events:none;transition:opacity .25s;z-index:60}
.sheetwrap.open{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:61;max-width:560px;margin:0 auto;background:#101013;border:1px solid rgba(255,255,255,.12);border-bottom:0;border-radius:26px 26px 0 0;padding:8px 20px calc(20px + env(safe-area-inset-bottom));transform:translateY(106%);transition:transform .34s cubic-bezier(.32,.72,.24,1)}
.sheet.open{transform:none}
.sheet .grab{width:40px;height:4.5px;border-radius:99px;background:rgba(255,255,255,.28);margin:4px auto 14px}
.sheet .sflag{font-size:52px;text-align:center;line-height:1.15}
.sheet h3{font-size:19px;font-weight:800;text-align:center;margin:2px 0 4px}
.sheet .ssub{text-align:center;color:#c7c7cc;font-size:14px;margin:0 0 6px}
.sheet .sdesc{color:#aeaeb2;font-size:13.5px;line-height:2;text-align:center;margin:8px 2px 4px}
.sheet .srow{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10.5px 2px;border-top:1px solid rgba(255,255,255,.08);font-size:14px}
.sheet .srow span{color:#aeaeb2}
.sheet .srow b{font-weight:700;text-align:left}
.sheet .snote{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:11px 13px;font-size:12.8px;line-height:1.95;color:#c7c7cc;margin-top:12px}
.sheet .sbtns{display:flex;gap:10px;margin-top:16px}
.sheet .sbtns .wbtn{flex:1}
.sheet .sbtns .gbtn{flex:0 0 108px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:14px;font:inherit;font-weight:700;font-size:15px;padding:13px 0;cursor:pointer}
.confirm{border:1px solid #2e2e34;border-radius:16px;padding:15px;margin:16px 0 4px;background:#0c0c0e}
.confirm .row{display:flex;justify-content:space-between;color:#c9c9ce;font-size:14px;padding:4px 0}
.confirm .row b{color:#fff}
.numcard{border-radius:18px;padding:18px;background:linear-gradient(135deg,#17171a,#0b0b0d 55%,#121215);border:1px solid #26262b;position:relative;overflow:hidden;cursor:pointer;width:100%;text-align:right;color:#fff;font-family:inherit}
.numcard .lbl{color:#8e8e93;font-size:12.5px}
.numcard .num{font-size:24px;font-weight:800;letter-spacing:1px;direction:ltr;text-align:left;margin:4px 0 2px}
.pill{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 12px;font-size:12.5px;border:1px solid #3a2c17;color:#ff9f43;background:rgba(255,159,67,.07)}
.pill.ok{border-color:#2c2c31;color:#fff;background:#141416}
.pill.bad{border-color:#3d1d1a;color:#ff453a;background:rgba(255,69,58,.06)}
.dot{width:7px;height:7px;border-radius:50%;background:#ff9f43;animation:pl 1.2s infinite}
@keyframes pl{50%{opacity:.25}}
.codezone{margin:20px 0 6px;text-align:center;padding:22px 10px;border:1px dashed #2c2c31;border-radius:16px;color:#9a9aa2;font-size:14px;line-height:2}
.codeboxes{display:flex;gap:7px;justify-content:center;direction:ltr;margin:16px 0 2px;cursor:pointer}
.codeboxes span{min-width:44px;height:54px;padding:0 4px;border:1px solid #333338;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;background:#0c0c0e}
.btnrow{display:flex;gap:9px;margin-top:16px}
.btnrow button{flex:1}
.small{color:#6d6d75;font-size:12px;text-align:center;margin-top:12px;line-height:1.9}
.ord{display:flex;justify-content:space-between;align-items:center;width:100%;padding:13px 2px;border-bottom:1px solid #1b1b1f;background:none;border-top:none;border-left:none;border-right:none;color:#fff;font-family:inherit;cursor:pointer;text-align:right}
.ord .ph{font-weight:700;direction:ltr;text-align:left}
.ord .mt{color:#8e8e93;font-size:12px;margin-top:2px}
.chips{display:flex;gap:8px;margin-bottom:14px}
.chips button{flex:1;background:#141416;color:#c9c9ce;border:1px solid #26262b;border-radius:12px;padding:10px;font-family:inherit;font-size:14px;cursor:pointer}
.chips button.on{background:#fff;color:#000;font-weight:700}
.amtin{width:100%;background:#101012;border:1px solid #26262b;border-radius:12px;color:#fff;padding:13px 14px;font-family:inherit;font-size:17px;margin-bottom:12px;text-align:center}
#toast{position:fixed;bottom:108px;right:50%;transform:translateX(50%) translateY(16px);background:#fff;color:#000;border-radius:999px;padding:9px 18px;font-size:13.5px;font-weight:700;opacity:0;pointer-events:none;transition:.25s;z-index:9;max-width:92vw;text-align:center}
#toast.show{opacity:1;transform:translateX(50%) translateY(0)}
.view{display:none}.view.on{display:block;animation:in .3s ease}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
h2.title{font-size:19px;font-weight:800;margin-bottom:12px}
.loading{color:#8e8e93;text-align:center;padding:26px 0;font-size:14px}
</style></head><body>
<div class="wrap">

  <div id="viewLogin">
    <div class="brandrow"><div class="logo">BlueMajazi<span>دروازه‌ای امن به دنیای پرسرعت</span></div></div>
    <div class="hero">
      <div class="big">شماره مجازی،<br>بدون مرز <svg class="icn" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
      <p class="slogan">خرید شماره از سراسر دنیا و دریافت آنی کد پیامک —<br>همان حساب و موجودی ربات تلگرام شما.</p>
      <div class="tgwrap">${widget}</div>
      <p class="small" id="loginErr" style="color:#ff9f43;min-height:18px"></p>
      <p class="small">اگر دکمه ورود نمایش داده نشد، چند ثانیه صبر کنید یا صفحه را تازه کنید.</p>
      <div class="feats">
        <div><svg class="icn" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>بدون ثبت‌نام و رمز عبور — ورود رسمی تلگرام</div>
        <div><svg class="icn" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>موجودی مشترک با ربات؛ شارژ از هرجا، خرج از هرجا</div>
        <div><svg class="icn" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>کد به‌صورت خودکار و زنده روی صفحه می‌آید</div>
      </div>
    </div>
    <p class="foot">با ورود، <a href="/terms">قوانین و مقررات</a> BlueMajazi را می‌پذیرید.</p>
  </div>

  <div id="viewApp" style="display:none">
    <div class="brandrow">
      <div class="logo">BlueMajazi</div>
      <div class="userchip">
        <button class="balpill" id="hdrBal" onclick="showView('topup')">…</button>
        <button class="avatar" id="hdrAva" title="خروج" onclick="logout()">؟</button>
      </div>
    </div>

    <section class="view on" id="v-shop">
      <div class="balcard">
        <div class="lbl" id="greetName">موجودی شما</div>
        <div class="amt" id="balAmt">…</div>
        <div class="tmn" id="balTmn"></div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="wbtn" onclick="showView('topup')"><svg class="icn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> افزایش موجودی</button>
          <button class="gbtn" onclick="logout()">خروج</button>
        </div>
      </div>
      <input class="search" id="cSearch" placeholder="جستجوی کشور…">
      <div class="grid" id="cGrid"><div class="loading">در حال بارگذاری کشورها…</div></div>
    </section>

    <section class="view" id="v-services">
      <button class="back" onclick="showView('shop')">‹ بازگشت به کشورها</button>
      <h2 class="title" id="svcTitle">سرویس‌ها</h2>
      <input class="search" id="sSearch" placeholder="جستجوی سرویس…">
      <div id="svcList"><div class="loading">در حال بارگذاری…</div></div>
    </section>

    <section class="view" id="v-act">
      <button class="back" onclick="showView('shop')">‹ فروشگاه</button>
      <div id="actBox"><div class="loading">در حال بارگذاری سفارش…</div></div>
    </section>

    <section class="view" id="v-orders">
      <h2 class="title"><svg class="icn" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/></svg> سفارش‌های من</h2>
      <div id="ordList"><div class="loading">در حال بارگذاری…</div></div>
    </section>

    <section class="view" id="v-topup">
      <h2 class="title"><svg class="icn" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> افزایش موجودی</h2>
      <div class="chips">
        <button id="chipUsd" class="on" onclick="setTopupMode('usd')"><svg class="icn" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg> مبلغ به دلار</button>
        <button id="chipTmn" onclick="setTopupMode('tmn')">مبلغ به تومان</button>
      </div>
      <input class="amtin" id="tpAmt" inputmode="numeric" placeholder="$ مبلغ">
      <p class="small" id="tpHint">مبلغ بین ۱ تا ۵۰۰۰ دلار. بعد از ساخت، به صفحه پرداخت می‌روید و روش پرداخت (رمزارز یا کارت‌به‌کارت) را آنجا انتخاب می‌کنید.</p>
      <button class="wbtn" style="width:100%" onclick="doTopup()">ساخت صفحه پرداخت</button>
      <div id="tpResult"></div>
    </section>

    <nav class="nav">
      <button data-nav="shop" class="on" onclick="showView('shop')"><svg class="icn" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>فروشگاه</button>
      <button data-nav="orders" onclick="showView('orders')"><svg class="icn" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/></svg>سفارش‌ها</button>
      <button data-nav="topup" onclick="showView('topup')"><svg class="icn" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>شارژ</button>
      <a href="/terms"><svg class="icn" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>قوانین</a>
    </nav>
  </div>
</div>
<div id="toast"></div>
<div class="sheetwrap" id="sheetWrap" onclick="closeSheet()"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div id="sheetBody"></div></div>
<script>
var S = { me:null, countries:[], country:null, services:[], rate:null, sel:null, act:null, poll:null, cd:null, topupMode:'usd' };
function $(id){ return document.getElementById(id); }
function faDigits(s){ return String(s).replace(/[0-9]/g, function(d){ return '۰۱۲۳۴۵۶۷۸۹'[Number(d)]; }); }
function faUsd(v){ return '$' + Number(v||0).toLocaleString('fa-IR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function faTmn(v){ return Math.round(Number(v||0)).toLocaleString('fa-IR') + ' تومان'; }
function faN(v){ return Number(v||0).toLocaleString('fa-IR'); }
function escH(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var ICONS = {
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  xc: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>'
};
function ico(n, sz){ return '<svg class="icn" width="' + (sz||19) + '" height="' + (sz||19) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n]||'') + '</svg>'; }
var toastTimer=null;
function toast(msg){ var t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.classList.remove('show'); }, 3600); }
function api(path, opts){
  opts = opts || {};
  opts.headers = { 'content-type':'application/json' };
  var tok = null;
  try { tok = sessionStorage.getItem('bg_tok'); } catch (e) {}
  if (tok) opts.headers['authorization'] = 'Bearer ' + tok;
  return fetch(path, opts).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401 && path.indexOf('/api/auth/') !== 0) { showLogin(); throw new Error('unauthorized'); }
      if (!r.ok) { var e = new Error(j.error || 'خطایی رخ داد'); e.data = j; throw e; }
      return j;
    });
  });
}
function onTelegramAuth(user){
  api('/api/auth/telegram', { method:'POST', body: JSON.stringify(user) })
    .then(function(j){
      try { if (j.token) sessionStorage.setItem('bg_tok', j.token); } catch (e) {}
      $('loginErr').textContent = '';
      boot();
    })
    .catch(function(e){ $('loginErr').textContent = e.message; toast(e.message); });
}
function showLogin(){ stopActTimers(); $('viewApp').style.display='none'; $('viewLogin').style.display='block'; }
function showApp(){ $('viewLogin').style.display='none'; $('viewApp').style.display='block'; }
function boot(tries){
  tries = tries || 0;
  api('/api/me').then(function(me){
    S.me = me; showApp(); renderMe(); loadCountries();
  }).catch(function(){
    // KV is eventually consistent: a just-created session can take a few
    // seconds to become readable. Retry a few times before giving up.
    var hasTok = false;
    try { hasTok = !!sessionStorage.getItem('bg_tok'); } catch (e) {}
    if (hasTok && tries < 4) { setTimeout(function(){ boot(tries + 1); }, 1500); return; }
    try { sessionStorage.removeItem('bg_tok'); } catch (e) {}
    showLogin();
  });
}
function renderMe(){
  if (!S.me) return;
  $('hdrBal').innerHTML = ico('wallet', 14) + ' ' + faUsd(S.me.balance);
  $('balAmt').textContent = faUsd(S.me.balance);
  $('balTmn').textContent = S.me.rate ? '≈ ' + faTmn(S.me.balance * S.me.rate) : '';
  $('greetName').textContent = S.me.name ? ('سلام، ' + S.me.name + ' — موجودی شما') : 'موجودی شما';
  var ava = $('hdrAva');
  if (S.me.photoUrl) ava.innerHTML = '<img src="' + escH(S.me.photoUrl) + '" alt="">';
  else ava.textContent = (S.me.name || '؟').charAt(0);
}
function refreshMe(){ return api('/api/me').then(function(me){ S.me = me; renderMe(); updTpHint(); }); }
function logout(){ try { sessionStorage.removeItem('bg_tok'); } catch (e) {} api('/api/auth/logout', { method:'POST' }).then(function(){ location.reload(); }); }
function showView(name){
  closeSheet();
  ['shop','services','act','orders','topup'].forEach(function(v){ $('v-'+v).classList.toggle('on', v===name); });
  document.querySelectorAll('[data-nav]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-nav')===name); });
  if (name !== 'act') stopActTimers();
  if (name === 'orders') loadOrders();
  window.scrollTo(0,0);
}
function loadCountries(){
  api('/api/countries').then(function(j){ S.countries = j.countries || []; renderCountries(''); })
    .catch(function(e){ $('cGrid').innerHTML = '<div class="loading">' + escH(e.message) + '</div>'; });
}
function renderCountries(q){
  q = (q||'').toLowerCase();
  var html = '';
  S.countries.forEach(function(c){
    if (q && c.name.toLowerCase().indexOf(q) === -1) return;
    html += '<button class="country" onclick="pickCountry(' + c.id + ')"><div class="fl">' + escH(c.emoji) + '</div><div class="nm">' + escH(c.name) + '</div></button>';
  });
  $('cGrid').innerHTML = html || '<div class="loading">کشوری پیدا نشد</div>';
}
$('cSearch').addEventListener('input', function(){ renderCountries(this.value); });
function openSheet(html){ $('sheetBody').innerHTML = html; $('sheetWrap').classList.add('open'); $('sheet').classList.add('open'); }
function closeSheet(){ var w = $('sheetWrap'), s = $('sheet'); if (w) w.classList.remove('open'); if (s) s.classList.remove('open'); }
function sheetBtns(okLabel, okFn){
  return '<div class="sbtns"><button class="wbtn" onclick="' + okFn + '">' + okLabel + '</button><button class="gbtn" onclick="closeSheet()">لغو</button></div>';
}
var pendingCountry = null;
function pickCountry(id){
  pendingCountry = null;
  S.countries.forEach(function(c){ if (c.id === id) pendingCountry = c; });
  if (!pendingCountry) return;
  var c = pendingCountry;
  openSheet(
    '<div class="sflag">' + escH(c.emoji) + '</div>'
    + '<h3>' + escH(c.name) + '</h3>'
    + '<p class="ssub">تأیید انتخاب کشور</p>'
    + '<p class="sdesc">شما کشور «' + escH(c.name) + '» را انتخاب کردید. با ادامه، سرویس‌های این کشور را می‌بینید و یک شماره مجازی از ' + escH(c.name) + ' می‌گیرید؛ کد پیامکی همان‌جا روی صفحه شماره نمایش داده می‌شود.</p>'
    + sheetBtns('ادامه — مشاهده سرویس‌ها', 'goCountry()')
  );
}
function goCountry(){
  var c = pendingCountry; closeSheet();
  if (!c) return;
  S.country = c;
  S.sel = null;
  showView('services');
  $('svcTitle').textContent = c.emoji + ' ' + c.name;
  $('svcList').innerHTML = '<div class="loading">در حال بارگذاری…</div>';
  api('/api/services?countryId=' + c.id).then(function(j){
    S.rate = j.rate; S.services = j.services || []; renderServices('');
  }).catch(function(e){ $('svcList').innerHTML = '<div class="loading">' + escH(e.message) + '</div>'; });
}
function renderServices(q){
  q = (q||'').toLowerCase();
  var html = '';
  S.services.forEach(function(s){
    if (q && s.name.toLowerCase().indexOf(q) === -1) return;
    var tmn = (S.rate && s.priceUsd != null) ? '<div class="tmn">≈ ' + faTmn(s.priceUsd * S.rate) + '</div>' : '';
    html += '<button class="svc' + (S.sel && S.sel.id === s.id ? ' sel' : '') + '" onclick="pickService(' + s.id + ')"><span><span class="nm">' + escH(s.name) + '</span><div class="st">موجود: ' + faN(s.available) + ' شماره</div></span><span class="pr"><div class="usd">' + (s.priceUsd != null ? faUsd(s.priceUsd) : '—') + '</div>' + tmn + '</span></button>';
  });
  $('svcList').innerHTML = html || '<div class="loading">سرویسی موجود نیست</div>';
}
$('sSearch').addEventListener('input', function(){ renderServices(this.value); });
function pickService(id){
  S.sel = null;
  S.services.forEach(function(s){ if (s.id === id) S.sel = s; });
  renderServices($('sSearch').value);
  if (!S.sel || !S.country) return;
  var s = S.sel, bal = S.me ? Number(S.me.balance) : 0;
  var price = Number(s.priceUsd || 0);
  var tmnRow = (S.rate && s.priceUsd != null) ? '<div class="srow"><span>معادل تومانی</span><b>' + faTmn(s.priceUsd * S.rate) + '</b></div>' : '';
  var rows = '<div class="srow"><span>سرویس</span><b>' + escH(s.name) + '</b></div>'
    + '<div class="srow"><span>کشور</span><b>' + escH(S.country.emoji + ' ' + S.country.name) + '</b></div>'
    + '<div class="srow"><span>موجودی</span><b>' + faN(s.available) + ' شماره</b></div>'
    + '<div class="srow"><span>مبلغ خرید</span><b>' + (s.priceUsd != null ? faUsd(s.priceUsd) : '—') + '</b></div>'
    + tmnRow
    + '<div class="srow"><span>موجودی شما</span><b>' + faUsd(bal) + '</b></div>'
    + '<div class="srow"><span>موجودی بعد از خرید</span><b>' + faUsd(bal - price) + '</b></div>';
  var note = '<div class="snote">با تأیید خرید، مبلغ از موجودی‌تان کسر و شماره بلافاصله تحویل داده می‌شود. اگر پیامک کد نرسد و به‌موقع لغو کنید، مبلغ کامل به موجودی‌تان برمی‌گردد.</div>';
  var btns;
  if (s.priceUsd != null && bal < price) {
    btns = '<div class="sbtns"><button class="wbtn" onclick="sheetTopup()">موجودی کافی نیست — افزایش موجودی</button><button class="gbtn" onclick="closeSheet()">لغو</button></div>';
  } else {
    btns = sheetBtns('تأیید و خرید', 'sheetBuy()');
  }
  openSheet('<h3 style="margin-top:6px">تأیید خرید</h3><p class="ssub">' + escH(s.name) + ' — ' + escH(S.country.name) + '</p>' + rows + note + btns);
}
function sheetBuy(){ closeSheet(); doBuy(); }
function sheetTopup(){ closeSheet(); showView("topup"); }
function doBuy(){
  if (!S.country || !S.sel) return;
  api('/api/buy', { method:'POST', body: JSON.stringify({ countryId: S.country.id, serviceId: S.sel.id }) })
    .then(function(j){ refreshMe(); openAct(j.activation); })
    .catch(function(e){ toast(e.message); });
}
var STATUS_FA = { waitingSms:'در انتظار پیامک', resendRequested:'درخواست پیامک مجدد ثبت شد', codeReceived:'کد دریافت شد', finished:'پایان‌یافته', cancelled:'لغو شده', expired:'منقضی شده', refunded:'برگشت‌وجه‌شده' };
function statusPill(a){
  if (a.status === 'codeReceived') return '<span class="pill ok">✓ کد دریافت شد</span>';
  if (a.status === 'finished') return '<span class="pill ok">' + ico('flag', 13) + ' پایان‌یافته</span>';
  if (['cancelled','expired','refunded'].indexOf(a.status) !== -1) return '<span class="pill bad">' + (STATUS_FA[a.status]||a.status) + '</span>';
  return '<span class="pill"><span class="dot"></span>' + (STATUS_FA[a.status]||'در انتظار پیامک') + '</span>';
}
function stopActTimers(){ if (S.poll) { clearInterval(S.poll); S.poll = null; } if (S.cd) { clearInterval(S.cd); S.cd = null; } }
function openAct(a){ S.act = a; showView('act'); renderAct(); startActTimers(); }
function openOrder(id){
  api('/api/activation?id=' + encodeURIComponent(id)).then(function(j){ openAct(j.activation); })
    .catch(function(e){ toast(e.message); });
}
function startActTimers(){
  stopActTimers();
  S.cd = setInterval(tickCountdown, 1000); tickCountdown();
  var open = S.act && ['waitingSms','resendRequested','codeReceived'].indexOf(S.act.status) !== -1;
  if (open) S.poll = setInterval(pollAct, 4000);
}
function tickCountdown(){
  var el = $('cdLeft'); if (!el || !S.act || !S.act.expiresAt) return;
  var left = Math.max(0, Math.floor((new Date(S.act.expiresAt).getTime() - Date.now()) / 1000));
  var mm = String(Math.floor(left/60)), ss = String(left%60); if (ss.length<2) ss='0'+ss;
  el.innerHTML = ico('clock', 13) + ' ' + faDigits(mm + ':' + ss) + ' تا پایان مهلت';
}
function pollAct(){
  if (!S.act) return;
  api('/api/activation?id=' + encodeURIComponent(S.act.id)).then(function(j){
    var had = S.act.code; S.act = j.activation; renderAct();
    if (!had && j.activation.code) refreshMe();
    if (['finished','cancelled','expired','refunded'].indexOf(j.activation.status) !== -1) { stopActTimers(); refreshMe(); }
  }).catch(function(){});
}
function renderAct(){
  var a = S.act; if (!a) return;
  var html = '<h2 class="title">شماره شما آماده است</h2>';
  html += '<button class=\"numcard\" id=\"numCard\"><div class=\"lbl\">' + escH(a.serviceName) + '</div><div class=\"num\">' + escH(a.phone) + '</div><div class=\"lbl\">برای کپی، روی شماره بزنید</div></button>';
  html += '<div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">' + statusPill(a) + '<span style="color:#9a9aa2;font-size:13px" id="cdLeft"></span></div>';
  if (a.code) {
    var boxes = '';
    String(a.code).split('').forEach(function(ch){ boxes += '<span>' + escH(ch) + '</span>'; });
    html += '<div class=\"codeboxes\" id=\"codeBoxes\">' + boxes + '</div>';
    html += '<p class="small" style="color:#c9c9ce">کد را در سرویس مقصد وارد کنید — برای کپی روی کد بزنید.</p>';
    if (a.status === 'codeReceived') {
      html += '<div class=\"btnrow\"><button class=\"wbtn\" onclick=\"actDo(&#39;finish&#39;)\">' + ico('flag') + ' اتمام کار</button><button class=\"gbtn\" onclick=\"actDo(&#39;resend&#39;)\">' + ico('send') + ' پیامک مجدد</button></div>';
      html += '<p class="small">با دریافت کد، امکان لغو این سفارش به پایان رسیده است.</p>';
    }
  } else if (['waitingSms','resendRequested'].indexOf(a.status) !== -1) {
    html += '<div class="codezone">در حال گوش دادن به پیامک… ' + ico('send', 15) + '<br>به‌محض رسیدن، کد به‌صورت <b style="color:#fff">خودکار</b> اینجا نمایش داده می‌شود؛ نیازی به رفرش نیست.</div>';
    html += '<div class=\"btnrow\"><button class=\"gbtn\" onclick=\"actDo(&#39;resend&#39;)\">' + ico('send') + ' پیامک مجدد</button><button class=\"gbtn\" onclick=\"actDo(&#39;cancel&#39;)\">' + ico('xc') + ' لغو سفارش</button></div>';
    html += '<p class="small">طبق محدودیت تأمین‌کننده، لغو در ۲ دقیقه اول ممکن نیست؛ اگر کدی نرسد و سفارش لغو یا منقضی شود، مبلغ خودکار به موجودی برمی‌گردد.</p>';
  } else {
    html += '<p class="small">این سفارش به پایان رسیده است (' + escH(STATUS_FA[a.status]||a.status) + '). اگر کدی دریافت نشده بود، مبلغ به موجودی شما برگشته است.</p>';
    html += '<div class=\"btnrow\"><button class=\"gbtn\" onclick=\"showView(&#39;orders&#39;)\">' + ico('list') + ' سفارش‌های من</button></div>';
  }
  $('actBox').innerHTML = html;
  var nc = $('numCard'); if (nc) nc.onclick = function(){ copyTxt(S.act.phone); };
  var cbx = $('codeBoxes'); if (cbx) cbx.onclick = function(){ copyTxt(S.act.code); };
  tickCountdown();
}
function actDo(action){
  if (!S.act) return;
  api('/api/activation/action', { method:'POST', body: JSON.stringify({ id: S.act.id, action: action }) })
    .then(function(j){ S.act = j.activation; renderAct(); startActTimers(); refreshMe(); })
    .catch(function(e){ toast(e.message); pollAct(); });
}
function copyTxt(txt, el){
  function done(){ toast('کپی شد ✓'); }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(done);
  else {
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta); done();
  }
}
function loadOrders(){
  $('ordList').innerHTML = '<div class="loading">در حال بارگذاری…</div>';
  api('/api/orders').then(function(j){
    var html = '';
    (j.orders||[]).forEach(function(o){
      var dt = o.createdAt ? new Date(o.createdAt).toLocaleString('fa-IR', { timeZone:'Asia/Tehran' }) : '';
      html += '<button class="ord" onclick="openOrder(' + o.id + ')"><span><span class="ph">' + escH(o.phone) + '</span><div class="mt">' + escH(o.serviceName) + ' — ' + escH(STATUS_FA[o.status]||o.status) + '</div></span><span class="mt">' + escH(dt) + '</span></button>';
    });
    $('ordList').innerHTML = html || '<div class="loading">هنوز سفارشی ندارید</div>';
  }).catch(function(e){ $('ordList').innerHTML = '<div class="loading">' + escH(e.message) + '</div>'; });
}
function setTopupMode(m){
  S.topupMode = m;
  $('chipUsd').classList.toggle('on', m==='usd');
  $('chipTmn').classList.toggle('on', m==='tmn');
  $('tpAmt').placeholder = m==='usd' ? '$ مبلغ به دلار' : 'مبلغ به تومان';
  $('tpResult').innerHTML = '';
  updTpHint();
}
function updTpHint(){
  var el = $('tpHint'); if (!el) return;
  var min = S.me && S.me.minTopup ? Number(S.me.minTopup) : 1;
  el.textContent = S.topupMode === 'usd'
    ? 'مبلغ بین ' + faUsd(min) + ' تا $۵٬۰۰۰. بعد از ساخت، به صفحه پرداخت می‌روید و روش پرداخت (رمزارز یا کارت‌به‌کارت) را آنجا انتخاب می‌کنید.'
    : 'مبلغ را به تومان وارد کنید؛ معادل دلاری آن باید بین ' + faUsd(min) + ' تا $۵٬۰۰۰ باشد و با نرخ لحظه‌ای تتر تبدیل می‌شود.';
}
function doTopup(){
  var raw = String($('tpAmt').value||'').replace(/[^0-9.]/g,'');
  var val = Number(raw);
  if (!(val > 0)) { toast('مبلغ را وارد کنید'); return; }
  if (S.topupMode === 'usd' && S.me && S.me.minTopup && val < Number(S.me.minTopup)) { toast('حداقل مبلغ شارژ ' + faUsd(Number(S.me.minTopup)) + ' است'); return; }
  var body = S.topupMode === 'usd' ? { amountUsd: val } : { amountTmn: Math.round(val) };
  api('/api/topup', { method:'POST', body: JSON.stringify(body) }).then(function(j){
    $('tpResult').innerHTML = '<div class="confirm"><div class="row"><span>صفحه پرداخت ساخته شد</span><b>۳۰ دقیقه مهلت</b></div><a class="wbtn" style="width:100%;margin-top:10px" href="' + escH(j.payUrl) + '">رفتن به صفحه پرداخت ←</a></div>';
  }).catch(function(e){
    if (e.data && e.data.payUrl) {
      $('tpResult').innerHTML = '<div class="confirm"><div class="row"><span>' + escH(e.message) + '</span></div><a class="wbtn" style="width:100%;margin-top:10px" href="' + escH(e.data.payUrl) + '">ادامه پرداخت قبلی ←</a></div>';
    } else toast(e.message);
  });
}
boot();
</script>
</body></html>`;
}

async function payPage(env, cfg, topup) {
  const head = (step) => paySteps(step);
  if (!topup) {
    return payShell(`${head(1)}
      <h1>پرداخت و افزایش موجودی</h1>
      <p class="sub">پرداخت از داخل ربات تلگرام شروع می‌شود: مبلغ شارژ را به دلار می‌نویسید، لینک پرداخت می‌گیرید و همین‌جا روش پرداخت را انتخاب می‌کنید.</p>
      <ul class="notes">
        <li><b>۱</b> در ربات، «افزایش موجودی» و بعد «ساخت لینک پرداخت» را بزنید.</li>
        <li><b>۲</b> روش را همین‌جا انتخاب کنید؛ فقط ولت و مبلغ همان روش نشان داده می‌شود.</li>
        <li><b>۳</b> هر پرداخت ۳۰ دقیقه مهلت دارد و شارژ ارز دیجیتال خودکار انجام می‌شود.</li>
      </ul>
      ${cfg.SUPPORT_USERNAME ? `<p class="sub">پشتیبانی: <a href="https://t.me/${esc(cfg.SUPPORT_USERNAME)}" style="color:#fff">@${esc(cfg.SUPPORT_USERNAME)}</a></p>` : ""}`);
  }
  const credit = topupCredit(topup);
  const tmn = await usdtTomanRate(env);
  const tomanText = tmn ? `≈ ${faInt(Math.round(credit * tmn))} تومان` : "";
  const summary = `<div class="summary"><div><div class="k">مبلغ شارژ</div><div class="v">$${esc(credit)}</div><div class="vt">${tomanText}</div></div>
    <div class="timer"><div class="cd">30:00</div><div class="k">مهلت باقی‌مانده</div></div></div><div class="timebar"><i id="timebar"></i></div>`;
  const script = payScript(topup, topup.method === "crypto" || topup.method === "card");
  const icoX = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
  const icoHome = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22v-8h6v8"/></svg>';
  const actions = `<div class="payfoot"><button class="footbtn danger" onclick="cancelPay(this)">${icoX} لغو پرداخت</button><a class="footbtn" href="/app">${icoHome} بازگشت به صفحه اصلی</a></div>
  <script>async function cancelPay(btn){if(!confirm('این پرداخت لغو شود؟ اگر مبلغی واریز کرده‌اید، پیش از لغو با پشتیبانی هماهنگ کنید.'))return;btn.disabled=true;try{var r=await fetch('/pay/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:'${topup.id}'})});var d=await r.json();if(d.ok){location.reload()}else{toast(d.error||'خطا در لغو');btn.disabled=false}}catch(e){toast('خطای شبکه');btn.disabled=false}}</script>`;

  if (topup.status === "approved") {
    const user = await getUser(env, topup.userId);
    return payShell(`${head(3)}
      <div class="state"><div class="circ fill">✓</div>
      <h1>پرداخت تأیید شد</h1>
      <p>موجودی شما با موفقیت شارژ شد. می‌توانید این صفحه را ببندید و به ربات برگردید.</p>
      <div class="big">+$${esc(credit)}</div>
      <p>موجودی فعلی: $${esc(user.balance)}</p></div>`);
  }
  if (topup.status === "expired" || topupIsExpired(topup)) {
    return payShell(`${head(2)}
      <div class="state"><div class="circ red">⏱</div>
      <h1 class="red">مهلت پرداخت تمام شد</h1>
      <p>این درخواست پرداخت بسته شد. برای شارژ حساب، داخل ربات یک پرداخت جدید بسازید.</p></div>`);
  }
  if (topup.status === "rejected") {
    return payShell(`${head(2)}
      <div class="state"><div class="circ red">✕</div>
      <h1 class="red">پرداخت رد شد</h1>
      <p>رسید ارسالی توسط ادمین تأیید نشد. اگر مبلغی واریز کرده‌اید، برای پیگیری با پشتیبانی در تماس باشید یا داخل ربات یک پرداخت تازه بسازید.</p></div>`);
  }
  if (topup.status === "cancelled") {
    return payShell(`${head(2)}
      <div class="state"><div class="circ">✕</div>
      <h1>پرداخت لغو شد</h1>
      <p>این درخواست پرداخت لغو و بسته شد. برای شارژ حساب، داخل ربات یا فروشگاه وب یک پرداخت جدید بسازید.</p>
      <p style="margin-top:18px"><a class="footbtn" style="display:inline-flex;flex:none;padding:11px 20px" href="/app">${icoHome} بازگشت به صفحه اصلی</a></p></div>`);
  }
  if (topup.status !== "pending") {
    return payShell(`${head(2)}
      <div class="state"><div class="circ">✕</div>
      <h1>این پرداخت بسته شده است</h1>
      <p>برای شارژ حساب، داخل ربات یک پرداخت جدید بسازید.</p></div>`);
  }

  // --- method selection view ---
  if (topup.method === "session") {
    const rows = [];
    for (const [code, c] of configuredCryptos(cfg)) {
      let approx = "—";
      try {
        const price = await cryptoPriceUsd(env, c.cg);
        approx = (credit / price).toFixed(c.decimals) + " " + COIN_TICKER[code];
      } catch (_) {}
      rows.push(`<button class="method" onclick="selectMethod('${code}')">
        <span class="tick">${COIN_TICKER[code]}</span>
        <span class="inf"><span class="nm">${esc(c.label)}</span></span>
        <span class="ap">${esc(approx)}</span><span class="ch">‹</span></button>`);
    }
    if (cfg.CARD_NUMBER) {
      rows.push(`<button class="method" onclick="selectMethod('CARD')">
        <span class="tick">کارت</span>
        <span class="inf"><span class="nm">کارت به کارت</span></span>
        <span class="ap">${tomanText ? esc(String(Math.round(credit * (tmn || 0))).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")) + " تومان" : "—"}</span><span class="ch">‹</span></button>`);
    }
    return payShell(`${head(1)}
      <h1>روش پرداخت را انتخاب کنید</h1>
      <p class="sub">بعد از انتخاب، فقط ولت و مبلغ دقیق همان روش نمایش داده می‌شود.</p>
      ${summary}
      ${rows.join("\n")}
      ${actions}`, script);
  }

  // --- phone-verification view (card selected, verification pending) ---
  if (topup.method === "card_verify") {
    const botUser = await botUsername(env);
    const deep = botUser ? `https://t.me/${botUser}?start=vfy_${topup.id}` : "";
    return payShell(`${head(2)}
      ${summary}
      <h1>📱 احراز هویت با شماره موبایل</h1>
      <p class="sub">برای پرداخت کارت‌به‌کارت، ابتدا باید شماره موبایلتان را <b>یک‌بار</b> احراز کنید. این کار داخل ربات تلگرام و با دکمه «ارسال شماره» انجام می‌شود؛ شماره باید متعلق به خودتان باشد و تلگرام اصالت آن را تضمین می‌کند.</p>
      <ul class="notes">
        <li><b>۱</b> دکمه زیر را بزنید تا ربات باز شود.</li>
        <li><b>۲</b> در ربات، دکمه «📱 ارسال شماره موبایل» را بزنید و شماره را به اشتراک بگذارید.</li>
        <li><b>۳</b> به همین صفحه برگردید — صفحه به‌صورت خودکار وارد مرحله پرداخت کارت می‌شود.</li>
      </ul>
      ${deep ? `<a href="${deep}" style="display:block;text-align:center;background:#fff;color:#000;border-radius:14px;padding:14px 18px;font-weight:800;text-decoration:none;margin:16px 0">📱 رفتن به ربات و احراز شماره</a>` : `<p class="sub">از داخل ربات روی لینک پرداخت همین سفارش بزنید و مراحل احراز را انجام دهید.</p>`}
      <p class="sub">همین صفحه را باز نگه دارید؛ بعد از احراز موفق، خودش به‌روز می‌شود.</p>
      <script>setInterval(async()=>{try{const r=await fetch('/pay/status?t=${topup.id}&_='+Date.now(),{cache:'no-store'});const d=await r.json();if(d.status!=='pending'||(d.method&&d.method!=='card_verify'))location.reload()}catch(e){}},4000)</script>
      ${actions}`, script);
  }

  // --- card view ---
  if (topup.method === "card") {
    const cardDigits = (cfg.CARD_NUMBER || "").replace(/[^0-9]/g, "");
    const cardGrouped = cardDigits.replace(/(.{4})/g, "$1 ").trim() || esc(cfg.CARD_NUMBER || "");
    const bankCard = `<div class="bankcard">
      <div class="bc-top"><span>${esc(cfg.CARD_BANK || "بانک")}</span><span class="bc-type">کارت بانکی • کارت‌به‌کارت</span></div>
      <div class="bc-mid"><span class="bc-chip"></span>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="2" stroke-linecap="round"><path d="M6 8a8 8 0 0 1 0 8"/><path d="M9.5 5.5a12 12 0 0 1 0 13"/><path d="M13 3a16 16 0 0 1 0 18"/></svg></div>
      <div class="bc-num" dir="ltr">${esc(cardGrouped)}</div>
      <div class="bc-bot"><div><div class="bc-k">به نام</div><div class="bc-holder">${esc(cfg.CARD_HOLDER || "")}</div></div>
      <button class="copy bc-copy" onclick="copyText('${esc(cardDigits || cfg.CARD_NUMBER || "")}',this)">کپی شماره کارت</button></div>
    </div>`;
    const uploadBlock = `<div class="upload">
      <div class="uic">🧾</div>
      <p><b>آپلود رسید پرداخت</b><br>بعد از واریز، عکس رسید را همین‌جا بارگذاری و ثبت کنید؛ رسید مستقیم برای ادمین ارسال می‌شود.</p>
      <img id="rcPrev" alt="پیش‌نمایش رسید">
      <div class="fname" id="rcName"></div>
      <input type="file" id="rcFile" accept="image/*" hidden onchange="onReceiptFile(this)">
      <div class="btnrow" style="margin-top:12px"><button class="btn ghost" onclick="document.getElementById('rcFile').click()">📎 انتخاب عکس رسید</button><button class="btn" id="rcBtn" disabled onclick="submitReceipt(this)">📤 ثبت رسید</button></div>
    </div>`;
    if (topup.receiptFileId) {
      return payShell(`${head(2)}
        <h1>رسید شما دریافت شد</h1>
        <p style="margin:10px 0 2px"><span class="pill"><span class="dot"></span>منتظر تأیید ادمین</span></p>
        <p class="sub">رسید برای ادمین ارسال شده است؛ پس از تأیید، موجودی شما شارژ می‌شود و همین صفحه به‌صورت خودکار به‌روز می‌شود.</p>
        ${summary}
        <div class="btnrow"><button class="btn" onclick="checkStatusBtn(this)">🔄 بررسی وضعیت</button><button class="btn ghost" onclick="document.getElementById('reUp').style.display='block';this.style.display='none'">ارسال رسید جایگزین</button></div>
        <div id="reUp" style="display:none">${uploadBlock}</div>
        ${actions}`, script);
    }
    return payShell(`${head(2)}
      <h1>کارت به کارت</h1>
      <p class="sub">مبلغ زیر را به کارت فروشگاه واریز کنید و رسید را همین‌جا آپلود کنید.</p>
      ${summary}
      ${bankCard}
      <div class="amtbox"><div class="k">مبلغ دقیق واریزی — تومان</div>
        <div class="amt"><span>${esc(String(topup.amountToman || 0))}</span><button class="copy" onclick="copyText('${esc(topup.amountToman || "")}',this)">کپی مبلغ</button></div></div>
      ${uploadBlock}
      <ul class="notes">
        <li><b>۱</b> دقیقاً همین مبلغ را به کارت بالا کارت‌به‌کارت کنید.</li>
        <li><b>۲</b> عکس رسید را همین‌جا آپلود و «ثبت رسید» را بزنید (یا عکس رسید را داخل ربات بفرستید).</li>
        <li><b>۳</b> رسید برای ادمین ارسال می‌شود؛ پس از تأیید، موجودی‌تان شارژ می‌شود.</li>
      </ul>
      <div class="btnrow"><button class="btn ghost" onclick="selectMethod('')">تغییر روش پرداخت</button></div>
      ${actions}`, script);
  }

  // --- crypto payment view: only the chosen wallet + amount ---
  const c = CRYPTOS[topup.crypto] || {};
  const addr = topup.walletAddress || "";
  return payShell(`${head(2)}
    <h1>پرداخت ${esc(c.label || "")}</h1>
    <p class="sub">فقط از همین شبکه و دقیقاً همین مبلغ را واریز کنید.</p>
    ${topup.seenAt ? `<div class="paywrap">
      <div class="ring" style="display:grid;place-items:center;border:1px solid #ff9f43;border-radius:50%;font-size:24px">⏳</div>
      <div><div class="st"><span class="pill"><span class="dot"></span>تراکنش دیده شد — در انتظار تأیید شبکه</span></div><div class="st">مبلغ شارژ: $${esc(credit)} ${tomanText}</div><div class="st">تراکنش شما در شبکه پیدا شده و منتظر تأیید (کانفرم) است. به محض تأیید، شارژ خودکار انجام و این صفحه به‌روز می‌شود. مهلت پرداخت شما تا آن زمان تمدید شده است.</div></div>
    </div>` : `<div class="paywrap">
      <div class="ring"><svg width="66" height="66"><circle cx="33" cy="33" r="26" stroke="#222" stroke-width="3" fill="none"/><circle id="ringfg" cx="33" cy="33" r="26" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="163.36" stroke-dashoffset="0"/></svg><div class="rc cd">30:00</div></div>
      <div><div class="st"><span class="pill"><span class="dot"></span>در انتظار پرداخت</span></div><div class="st">مبلغ شارژ: $${esc(credit)} ${tomanText}</div><div class="st">پس از دیده‌شدن تراکنش در شبکه، شارژ خودکار انجام و این صفحه به‌روز می‌شود.</div></div>
    </div>`}
    <div class="amtbox"><div class="k">مبلغ دقیق پرداختی — ${esc(c.label || "")}</div>
      <div class="amt"><span>${esc(topup.expectedCrypto)}</span><button class="copy" onclick="copyText('${esc(topup.expectedCrypto)}',this)">کپی مبلغ</button></div></div>
    <div class="addr-box"><code class="addr">${esc(addr)}</code><button class="copy" onclick="copyText('${esc(addr)}',this)">کپی آدرس</button></div>
    <div class="qrwrap"><img class="qr" alt="QR" width="140" height="140" loading="lazy" src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=${encodeURIComponent(addr)}"></div>
    <ul class="notes">
      <li><b>شبکه</b> واریز از شبکه دیگری به این آدرس، قابل شناسایی نیست.</li>
      <li><b>مبلغ دقیق</b> کمتر یا بیشتر از مبلغ بالا واریز نکنید؛ سیستم با همین مبلغ پرداخت شما را پیدا می‌کند.</li>
    </ul>
    <div class="btnrow"><button class="btn" onclick="checkNow(this)">🔄 بررسی پرداخت</button><button class="btn ghost" onclick="selectMethod('')">تغییر روش پرداخت</button></div>
      ${actions}`, script);
}

// ---------- Worker entry ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const baseUrl = url.origin;
    // Self-setup: any visit to this Worker (re)registers the Telegram webhook
    // in the background — no manual setWebhook call is needed after deploy.
    if (url.pathname !== "/webhook") ctx.waitUntil(rememberOriginAndWebhook(env, url.origin));
    if (url.pathname === "/setup") {
      const full = diagKeyOk(env, url);
      const lastSetup = await kvGet(env, "sys:setupAt");
      if (!full && lastSetup && now() - lastSetup.at < 30000) return Response.json({ ok: true, kv: !!env.STORE, throttled: true });
      await kvPut(env, "sys:setupAt", { at: now() }, 120);
      const cfgSetup = await getConfig(env);
      const webhook = await ensureWebhook(env, cfgSetup.WORKER_BASE_URL || url.origin, true);
      return Response.json(full ? { ok: webhook.ok, kv: !!env.STORE, webhook } : { ok: webhook.ok, kv: !!env.STORE });
    }
    if (url.pathname === "/" ) return Response.redirect(`${url.origin}/app`, 302);
    if (url.pathname === "/pay/select" && request.method === "POST") {
      return handlePaySelect(env, request);
    }
    if (url.pathname === "/pay/cancel" && request.method === "POST") {
      return handlePayCancel(env, request);
    }
    if (url.pathname === "/pay/receipt" && request.method === "POST") {
      return handlePayReceipt(env, request);
    }
    if (url.pathname === "/pay/status") {
      const t = url.searchParams.get("t");
      let topup = t ? await kvGet(env, `topup:${t}`) : null;
      if (!topup) return Response.json({ status: "notfound" }, { status: 404 });
      topup = await settleTopupLazy(env, topup);
      return Response.json({ status: topup.status, method: topup.method, receipt: !!topup.receiptFileId, expiresAt: topupExpiresAt(topup) }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/api/")) return handleApi(env, request, url);
    if (url.pathname === "/app") {
      const cfgApp = await getConfig(env);
      return new Response(await appPage(env, cfgApp), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HTML_SEC } });
    }
    if (url.pathname === "/terms") {
      const cfgTerms = await getConfig(env);
      return new Response(termsPage(cfgTerms), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HTML_SEC } });
    }
    if (url.pathname === "/pay") {
      const t = url.searchParams.get("t");
      let topup = t ? await kvGet(env, `topup:${t}`) : null;
      if (topup) topup = await settleTopupLazy(env, topup);
      const cfg = await getConfig(env);
      const html = await payPage(env, cfg, topup);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HTML_SEC } });
    }
    if (url.pathname === "/health") {
      if (!diagKeyOk(env, url)) return Response.json({ ok: true, version: BOT_VERSION });
      // Full probes are cached for 60s: this endpoint is public, and each
      // probe used to fan out to several external APIs on every single hit.
      let diag = await kvGet(env, "diag:health");
      if (!diag || now() - diag.at > 60000) {
        const wallex = await probeWallex();
        const usdtToman = await usdtTomanRate(env);
        const tmnDiag = await kvGet(env, "diag:tmn");
        // Telegram delivery state: if the bot goes silent, this shows where
        // updates are being sent and Telegram's last delivery error.
        let webhook = null;
        try {
          const wi = await tg(env, "getWebhookInfo", {});
          const r = wi?.result || {};
          webhook = {
            url: r.url || "",
            pendingUpdates: r.pending_update_count ?? null,
            lastError: r.last_error_message || null,
            lastErrorAt: r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : null,
          };
        } catch (_) {}
        diag = { at: now(), usdtTomanRate: usdtToman, wallex, tmnDiag, webhook };
        await kvPut(env, "diag:health", diag, 300);
      }
      return Response.json({ ok: true, kv: !!env.STORE, version: BOT_VERSION, usdtTomanRate: diag.usdtTomanRate, wallex: diag.wallex, tmnDiag: diag.tmnDiag, webhook: diag.webhook });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (secret !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => ({}));
      const work = (async () => {
        // Tell the admin about brand-new users (first contact) — once per
        // user, only for private chats, and never about the admin themself.
        const fromU = update.message?.from || update.callback_query?.from;
        const pChat = update.message?.chat || update.callback_query?.message?.chat;
        const isPrivateUser = !!(fromU && pChat?.type === "private" && String(pChat.id) === String(fromU.id) && !fromU.is_bot);
        const existedBefore = isPrivateUser && env.STORE ? !!(await env.STORE.get(`user:${fromU.id}`)) : true;
        if (update.message) await handleMessage(env, update.message, baseUrl);
        if (update.callback_query) await handleCallback(env, update.callback_query, baseUrl);
        // Only announce users who actually got in: if the forced-join gate
        // turned them away, no record was saved and they are announced on
        // their first successful entry instead of on every blocked /start.
        const existsAfter = isPrivateUser && !existedBefore && env.STORE ? !!(await env.STORE.get(`user:${fromU.id}`)) : false;
        if (isPrivateUser && !existedBefore && existsAfter && String(fromU.id) !== String(env.ADMIN_CHAT_ID)) {
          const name = [fromU.first_name, fromU.last_name].filter(Boolean).join(" ") || "—";
          await send(env, env.ADMIN_CHAT_ID,
            `👤 <b>کاربر جدید جوین شد</b>\n\nنام: <b>${esc(name)}</b>\nیوزرنیم: ${fromU.username ? "@" + esc(fromU.username) : "—"}\nآیدی عددی: <code>${esc(fromU.id)}</code>`);
        }
      })();
      ctx.waitUntil(work);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
  // Auto-check pending crypto top-ups (set a cron trigger in wrangler.toml / dashboard).
  async scheduled(event, env, ctx) {
    const work = (async () => {
      // Keep the Telegram webhook pointed at this Worker (uses the configured
      // public URL, or the last origin seen from a real visit).
      const storedOrigin = await kvGet(env, "sys:origin");
      const cfgCron = await getConfig(env);
      const origin = cfgCron.WORKER_BASE_URL || storedOrigin?.origin;
      // Forced live verification every cron tick: the KV cache alone once let
      // an externally-cleared webhook go unnoticed for hours (bot fully
      // silent with updates piling up). A getWebhookInfo call every 2 min is
      // cheap; setWebhook is only sent when Telegram's URL actually differs.
      if (origin) await ensureWebhook(env, origin, true);
      for (const t of await kvList(env, "topup:")) {
        if (t.status === "pending") await settleTopupLazy(env, t);
      }
    })();
    ctx.waitUntil(work);
  },
};
