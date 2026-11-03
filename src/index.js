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
const BOT_VERSION = "1.7.0"; // shown in the admin panel and /health — check you're on the latest deploy
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
  "SUPPORT_USERNAME", "WORKER_BASE_URL", "PRICE_MARKUP_PERCENT", "TMN_RATE_MANUAL", "GROUP_CHAT_ID",
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
async function ensureWebhook(env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set" };
  if (!origin) return { ok: false, reason: "public origin unknown yet" };
  const target = `${String(origin).replace(/\/+$/, "")}/webhook`;
  try {
    const cached = await kvGet(env, "sys:webhook");
    if (cached?.url === target && now() - cached.at < 6 * 3600 * 1000) {
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

async function checkCryptoState(env, topup) {
  const addr = topup.walletAddress;
  const sinceSec = Math.floor(topup.createdAt / 1000) - 120;
  const want = Number(topup.expectedCrypto);
  try {
    if (topup.crypto === "USDT_TRC20" || topup.crypto === "TRX") {
      if (topup.crypto === "USDT_TRC20") {
        const r = await fetch(
          `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=50&contract_address=${USDT_TRC20_CONTRACT}`
        );
        const d = await r.json().catch(() => ({}));
        return (d.data || []).some(
          (t) => t.to === addr && Number(t.value) / 1e6 >= want - 1e-6 &&
            Math.floor(t.block_timestamp / 1000) >= sinceSec
        ) ? "paid" : "none";
      }
      const wantHex = tronBase58ToHex(addr);
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50`);
      const d = await r.json().catch(() => ({}));
      return (d.data || []).some((t) => {
        const c = t.raw_data?.contract?.[0];
        const v = c?.parameter?.value;
        return wantHex && String(v?.to_address || "").toLowerCase() === wantHex &&
          t.ret?.[0]?.contractRet === "SUCCESS" &&
          Number(v.amount || 0) / 1e6 >= want - 1e-3 &&
          Math.floor(t.block_timestamp / 1000) >= sinceSec;
      }) ? "paid" : "none";
    }
    if (topup.crypto === "BTC") {
      const r = await fetch(`https://mempool.space/api/address/${addr}/txs`);
      const txs = await r.json().catch(() => []);
      const match = (Array.isArray(txs) ? txs : []).find((tx) =>
        (tx.vout || []).some((o) => o.scriptpubkey_address === addr && o.value >= Math.round(want * 1e8) - 10) &&
        (tx.status?.block_time || Math.floor(now() / 1000)) >= sinceSec - 3600
      );
      if (!match) return "none";
      return match.status?.confirmed ? "paid" : "seen";
    }
    if (topup.crypto === "TON") {
      const r = await fetch(
        `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(addr)}&limit=30&archival=false`
      );
      const d = await r.json().catch(() => ({}));
      return (d.result || []).some((tx) => {
        const msg = tx.in_msg;
        return msg && Number(msg.value || 0) / 1e9 >= want - 1e-4 && Number(tx.utime) >= sinceSec;
      }) ? "paid" : "none";
    }
    if (topup.crypto === "USDT_BEP20") {
      // Keyless: read Transfer logs straight from BSC public RPC nodes.
      const rpcCall = async (rpc, method, params) => {
        const r = await fetch(rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message || "rpc error");
        return d.result;
      };
      const toTopic = "0x" + "0".repeat(24) + addr.replace(/^0x/i, "").toLowerCase();
      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const elapsedBlocks = Math.ceil((now() - topup.createdAt) / 3000) + 300; // BSC: ~3s blocks
      const span = Math.min(Math.max(elapsedBlocks, 600), 5000); // public RPC log-range limits
      for (const rpc of ["https://bsc-dataseed.bnbchain.org", "https://bsc.publicnode.com", "https://bsc-dataseed1.defibit.io"]) {
        try {
          const latest = parseInt(await rpcCall(rpc, "eth_blockNumber", []), 16);
          const logs = await rpcCall(rpc, "eth_getLogs", [{
            fromBlock: "0x" + Math.max(0, latest - span).toString(16),
            toBlock: "latest",
            address: USDT_BSC_CONTRACT,
            topics: [transferTopic, null, toTopic],
          }]);
          if (Array.isArray(logs)) {
            return logs.some((l) => Number(BigInt(l.data)) / 1e18 >= want - 1e-4) ? "paid" : "none";
          }
        } catch (_) { /* try the next RPC node */ }
      }
      return "none";
    }
    if ((topup.crypto === "ETH" || topup.crypto === "USDT_ERC20") && env.ETHERSCAN_API_KEY) {
      const isToken = topup.crypto === "USDT_ERC20";
      const action = isToken ? "tokentx" : "txlist";
      const contract = isToken ? `&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7` : "";
      const r = await fetch(
        `https://api.etherscan.io/api?module=account&action=${action}${contract}&address=${addr}&sort=desc&apikey=${env.ETHERSCAN_API_KEY}`
      );
      const d = await r.json().catch(() => ({}));
      return (d.result || []).some((tx) =>
        String(tx.to).toLowerCase() === addr.toLowerCase() &&
        Number(tx.value) / (isToken ? 1e6 : 1e18) >= want - 1e-4 &&
        Number(tx.timeStamp) >= sinceSec
      ) ? "paid" : "none";
    }
    if (topup.crypto === "LTC") {
      const r = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${addr}/full?limit=50`);
      const d = await r.json().catch(() => ({}));
      const match = (d.txs || []).find((tx) =>
        (tx.outputs || []).some((o) => (o.addresses || []).includes(addr) && o.value >= Math.round(want * 1e8) - 100) &&
        (!tx.received || new Date(tx.received).getTime() / 1000 >= sinceSec - 3600)
      );
      if (!match) return "none";
      return Number(match.confirmations || 0) >= 1 ? "paid" : "seen";
    }
  } catch (_) { /* network hiccup: stay pending, cron retries */ }
  return "none";
}
const checkCryptoPaid = async (env, topup) => (await checkCryptoState(env, topup)) === "paid";

async function creditTopup(env, topup, note) {
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
}

// ---------- bot UI (Persian) ----------
function mainMenuKb(env, cfg, userId) {
  const rows = [
    [btn("🛒 خرید شماره مجازی", "countries:0")],
    [btn("💰 موجودی من", "balance"), btn("💳 افزایش موجودی", "topup")],
    [btn("📱 سفارش‌های من", "orders")],
  ];
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
  if (editMsgId) return edit(env, chatId, editMsgId, text, mainMenuKb(env, cfg, chatId));
  return send(env, chatId, text, mainMenuKb(env, cfg, chatId));
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

async function doBuy(env, chatId, msgId, countryId, serviceId, cbId) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const s = services.find((x) => x.id === Number(serviceId));
  if (!s) { await answerCb(env, cbId, "سرویس موجود نیست", true); return; }
  const cfg = await getConfig(env);
  const fx = await brlToUsdRate(env);
  if (!fx) { await answerCb(env, cbId, "نرخ تبدیل ارز در دسترس نیست؛ چند دقیقه دیگر تلاش کنید", true); return; }
  const price = sellPrice(cfg, s.price * fx);
  const user = await getUser(env, chatId);
  if (Number(user.balance) < price) {
    const tmn = await usdtTomanRate(env);
    await answerCb(env, cbId, "موجودی کافی نیست", true);
    return edit(env, chatId, msgId,
      `❌ <b>موجودی کافی نیست.</b>\n\nقیمت: ${usdText(tmn, price)}\nموجودی شما: ${usdText(tmn, user.balance)}\n\nابتدا موجودی خود را افزایش دهید.`,
      kb([[btn("💳 افزایش موجودی", "topup")], [btn("⬅️ منوی اصلی", "home")]]));
  }
  await answerCb(env, cbId, "در حال خرید شماره…");
  let act;
  try {
    act = await smsfull(env, "/activations", {
      method: "POST",
      body: { serviceId: Number(serviceId), countryId: Number(countryId) },
      headers: { "Idempotency-Key": uid() },
    });
  } catch (e) {
    const msgs = {
      noNumbersAvailable: "متأسفانه در این لحظه شماره‌ای موجود نیست.",
      insufficientBalance: "موجودی فروشگاه نزد تأمین‌کننده کافی نیست. لطفاً با پشتیبانی تماس بگیرید.",
      priceChanged: "قیمت در لحظه خرید تغییر کرد. لطفاً دوباره تلاش کنید.",
    };
    return edit(env, chatId, msgId, `❌ خرید انجام نشد.\n${msgs[e.code] || esc(e.message)}`, backKb);
  }
  // Charge the user only for the sell price; provider reserves its own price.
  user.balance = Math.round((Number(user.balance) - price) * 100) / 100;
  await saveUser(env, user);
  await kvPut(env, `act:${act.id}`, {
    id: act.id, userId: String(chatId), price, providerPriceBrl: act.price,
    phoneNumber: act.phoneNumber, serviceName: act.service?.name || s.name,
    status: act.status, createdAt: now(), charged: true,
  });
  return showActivation(env, chatId, msgId, act);
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
  return `📱 <b>شماره شما:</b> <code>+${esc(act.phoneNumber)}</code>\n\nوضعیت: ${statusFa}\n${act.latestCode ? `\n🔑 <b>کد:</b> <code>${esc(act.latestCode)}</code>\nهمه کدها: ${codes}` : "\nهنوز کدی دریافت نشده است. چند لحظه صبر کنید و «بررسی کد» را بزنید."}\n\n⏰ انقضا: ${faDigits(new Date(act.expiresAt).toLocaleString("fa-IR"))}`;
}
function activationKb(act) {
  const open = ["waitingSms", "codeReceived", "resendRequested"].includes(act.status);
  const rows = [[btn("🔄 بررسی کد", `act:${act.id}`)]];
  if (open) rows.push([
    btn("📩 پیامک مجدد", `resend:${act.id}`),
    btn("🏁 اتمام کار", `finish:${act.id}`),
    btn("🚫 لغو", `cancel:${act.id}`),
  ]);
  rows.push([btn("📱 سفارش‌های من", "orders"), btn("⬅️ منوی اصلی", "home")]);
  return kb(rows);
}
async function showActivation(env, chatId, msgId, act) {
  const text = activationText(act);
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

async function refreshActivation(env, chatId, msgId, id) {
  const act = await smsfull(env, `/activations/${id}`);
  const rec = await kvGet(env, `act:${id}`);
  if (rec && rec.status !== act.status) { rec.status = act.status; await kvPut(env, `act:${id}`, rec); }
  // Refund the user if the activation ended with no SMS and we had charged them.
  if (rec && rec.charged && ["cancelled", "expired"].includes(act.status)) {
    const user = await getUser(env, rec.userId);
    user.balance = Math.round((Number(user.balance) + Number(rec.price)) * 100) / 100;
    rec.charged = false;
    await saveUser(env, user);
    await kvPut(env, `act:${id}`, rec);
    await send(env, chatId, `↩️ مبلغ ${usdText(await usdtTomanRate(env), rec.price)} بابت سفارش بدون پیامک به موجودی شما برگشت.`);
  }
  // Announce in the purchases group the first time a code is delivered.
  if (rec && act.latestCode) await postPurchaseToGroup(env, rec);
  return showActivation(env, chatId, msgId, act);
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
function receiptCaption(topup, via) {
  return `🧾 <b>رسید جدید</b> (${via})\nکاربر: ${faDigits(topup.userId)}\nشناسه پرداخت: <code>${esc(topup.id)}</code>\nمبلغ کارت: ${faInt(topup.amountToman)} تومان\nشارژ درخواستی: $${faNum(topupCredit(topup))}${topup.rateUsed ? ` (با نرخ تتر ${faInt(topup.rateUsed)} تومان)` : ""}${topup.receiptCount > 1 ? `\n♻️ رسید جایگزین (شماره ${faDigits(topup.receiptCount)})` : ""}`;
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
  const t = new URL(request.url).searchParams.get("t");
  let topup = t ? await kvGet(env, `topup:${t}`) : null;
  if (!topup) return json({ ok: false, error: "پرداخت پیدا نشد" }, 404);
  topup = await settleTopupLazy(env, topup);
  if (topup.status !== "pending") return json({ ok: false, error: "این پرداخت بسته شده است" });
  if (topup.method !== "card") return json({ ok: false, error: "اول روش کارت‌به‌کارت را انتخاب کنید" });
  let form;
  try { form = await request.formData(); } catch (_) { return json({ ok: false, error: "فرم نامعتبر است" }, 400); }
  const file = form.get("receipt");
  if (!file || typeof file === "string") return json({ ok: false, error: "عکس رسید را انتخاب کنید" });
  if (!String(file.type || "").startsWith("image/")) return json({ ok: false, error: "فقط عکس رسید (JPG یا PNG) قابل قبول است" });
  if (file.size > 8 * 1024 * 1024) return json({ ok: false, error: "حجم عکس باید کمتر از ۸ مگابایت باشد" });
  topup.receiptCount = (topup.receiptCount || 0) + 1;
  const adminKb = kb([[btn("✅ تأیید و شارژ", `apr:${topup.id}`), btn("❌ رد رسید", `rej:${topup.id}`)]]);
  let fileId;
  try {
    fileId = await tgUploadPhoto(env, env.ADMIN_CHAT_ID, file, file.name || "receipt.jpg", receiptCaption(topup, "از صفحه پرداخت"), adminKb);
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
  SUPPORT_USERNAME: { label: "یوزرنیم پشتیبانی", hint: "بدون @ بفرستید، مثال: BlueGateSupport" },
  TMN_RATE_MANUAL: { label: "نرخ دستی تتر (تومان) — پشتیبان", hint: "فقط عدد بفرستید، مثال: 271000 — فقط وقتی استفاده می‌شود که نرخ زنده از والکس و اکسیر نرسد.", numeric: true },
  GROUP_CHAT_ID: { label: "آیدی گروه اعلام خرید موفق", hint: "آیدی عددی گروه را با علامت منفی بفرستید، مثال: -1001234567890 — یا ساده‌تر: ربات را در گروه اضافه کنید و همان‌جا دستور /setgroup را بفرستید تا خودکار ثبت شود." },
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
  general: { title: "🧰 تنظیمات عمومی", keys: ["PRICE_MARKUP_PERCENT", "TMN_RATE_MANUAL", "GROUP_CHAT_ID", "SUPPORT_USERNAME", "WORKER_BASE_URL"] },
};
const groupOfKey = (key) =>
  Object.entries(CONFIG_GROUPS).find(([, g]) => g.keys.includes(key))?.[0] || "general";
const shortVal = (v) => !v ? "— تنظیم نشده" : v.length > 26 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;

function configGroupText(cfg, group) {
  const g = CONFIG_GROUPS[group];
  let text = `⚙️ <b>${g.title}</b>\n\nبرای ویرایش، روی هر مورد بزنید. دکمه 🗑 مقدار را حذف می‌کند.\n`;
  for (const k of g.keys) text += `\n<b>${esc(settingLabel(k))}:</b> <code>${esc(shortVal(cfg[k]))}</code>`;
  return text;
}
function configGroupKb(cfg, group) {
  const g = CONFIG_GROUPS[group];
  const rows = g.keys.map((k) => [
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
  if (key === "GROUP_CHAT_ID") {
    const v = clean.replace(/\s/g, "");
    return /^-?\d{5,20}$/.test(v) ? { value: v } : { error: "آیدی عددی گروه معتبر نیست (مثال: -1001234567890). یا ربات را در گروه اضافه کنید و آنجا /setgroup بفرستید." };
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

// ---------- message / callback router ----------
async function handleMessage(env, msg, baseUrl) {
  const chatId = msg.chat.id;
  const user = await getUser(env, chatId);
  const text = enDigits((msg.text || "").trim());

  if (text === "/start") { user.state = null; await saveUser(env, user); return showHome(env, chatId); }

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

  // Receipt photo for a pending card top-up
  if (user.state === "await_card_receipt" && (msg.photo || msg.document)) {
    const topup = await kvGet(env, `topup:${user.stateData}`);
    if (!topup) { user.state = null; await saveUser(env, user); return send(env, chatId, "درخواست شارژ پیدا نشد. دوباره تلاش کنید.", backKb); }
    topup.receiptFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    topup.receiptVia = "bot";
    topup.receiptCount = (topup.receiptCount || 0) + 1;
    topup.status = "pending";
    await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
    user.state = null; user.stateData = null;
    await saveUser(env, user);
    await send(env, chatId, "🧾 رسید شما دریافت شد و برای تأیید نزد مدیر ارسال شد. پس از تأیید، موجودی‌تان شارژ می‌شود.", mainMenuKb(env, await getConfig(env), chatId));
    // Forward receipt to admin with approve/reject buttons
    const cap = receiptCaption(topup, "از ربات");
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
    if (!(creditUsd >= 1 && creditUsd <= 5000)) {
      return send(env, chatId, "مبلغ شارژ باید بین ۱ تا ۵۰۰۰ دلار باشد. از منوی «افزایش موجودی» دوباره تلاش کنید.", backKb);
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
    if (!(creditUsd >= 1 && creditUsd <= 5000)) {
      return send(env, chatId, `مبلغ تومانی باید معادل ۱ تا ۵۰۰۰ دلار باشد (با نرخ فعلی تتر، حدود ${faInt(rate)} تا ${faInt(rate * 5000)} تومان). از منوی «افزایش موجودی» دوباره تلاش کنید.`, backKb);
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
    if (data === "home") return showHome(env, chatId, msgId);
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
    if (head === "act") return refreshActivation(env, chatId, msgId, a);
    if (head === "resend" || head === "cancel" || head === "finish") {
      await smsfull(env, `/activations/${a}/${head}`, { method: "POST" });
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
          `🇮🇷 <b>ساخت لینک پرداخت — تومان</b>\n\n✍️ مبلغ شارژ را به <b>تومان</b> بنویسید (فقط عدد، مثال: 5000000):\n\nنرخ لحظه‌ای تتر: هر تتر <b>${faInt(rate)} تومان</b> — مبلغ شما با همین نرخ به دلار تبدیل می‌شود (معادل ۱ تا ۵۰۰۰ دلار).\n\nروش پرداخت را بعداً داخل صفحه پرداخت انتخاب می‌کنید و هر پرداخت ۳۰ دقیقه مهلت دارد.`,
          kb([[btn("⬅️ بازگشت", "link_new")]]));
      }
      user.state = "await_link_amount";
      await saveUser(env, user);
      return edit(env, chatId, msgId,
        `💵 <b>ساخت لینک پرداخت — دلار</b>\n\n✍️ مبلغ شارژی را که می‌خواهید به <b>دلار</b> بنویسید (فقط عدد، مثال: 50):\n\nروش پرداخت را بعداً داخل صفحه پرداخت انتخاب می‌کنید و هر پرداخت ۳۰ دقیقه مهلت دارد.`,
        kb([[btn("⬅️ بازگشت", "link_new")]]));
    }
    if (head === "ses_cancel") {
      const topup = await kvGet(env, `topup:${a}`);
      if (topup && topup.userId === String(chatId) && topup.status === "pending") {
        topup.status = "cancelled"; topup.resolvedAt = now();
        await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
        const user = await getUser(env, chatId);
        if (user.state === "await_card_receipt" && user.stateData === topup.id) {
          user.state = null; user.stateData = null; await saveUser(env, user);
        }
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
      const fresh = await settleTopupLazy(env, topup);
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
// and exact amount are shown. Design: professional minimal — pure black,
// white text, hairline dividers, Vazirmatn, countdown ring + auto polling.
const COIN_TICKER = { USDT_TRC20: "USDT", USDT_BEP20: "USDT", USDT_ERC20: "USDT", TRX: "TRX", BTC: "BTC", TON: "TON", LTC: "LTC", ETH: "ETH" };

async function settleTopupLazy(env, topup) {
  if (!topup || topup.status !== "pending") return topup;
  if (topup.method === "crypto") {
    const st = await checkCryptoState(env, topup);
    if (st === "paid") {
      await creditTopup(env, topup, "auto-chain");
      return (await kvGet(env, `topup:${topup.id}`)) || topup;
    }
    if (st === "seen" && !topup.seenAt) {
      // Transaction is on-chain but unconfirmed: keep the payment alive past
      // the 30-minute deadline (topupExpiresAt now counts from seenAt).
      topup.seenAt = now();
      await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
      const cfg = await getConfig(env);
      await send(env, topup.userId,
        `👀 <b>تراکنش شما دیده شد</b>\n\nپرداخت $${faNum(topupCredit(topup))} در شبکه پیدا شد و در انتظار تأیید (کانفرم) است. به محض تأیید، موجودی‌تان به‌صورت خودکار شارژ می‌شود و مهلت پرداخت‌تان تا آن زمان تمدید شد.`,
        mainMenuKb(env, cfg, topup.userId));
    }
  }
  if (topupIsExpired(topup)) {
    await expireTopup(env, topup);
    return (await kvGet(env, `topup:${topup.id}`)) || topup;
  }
  return topup;
}

async function handlePaySelect(env, request) {
  const body = await request.json().catch(() => ({}));
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
<link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{background:#000}
body{background:#000;color:#fff;font-family:Vazirmatn,Tahoma,Arial,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.9}
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
.step.done .dot{border-color:#525252;color:#fff}
.steps .line{flex:1;height:1px;background:#1e1e1e;min-width:14px}
h1{font-size:24px;font-weight:800;letter-spacing:-.01em}
.sub{color:#a3a3a3;font-size:13.5px;margin:6px 0 22px}
.summary{display:flex;align-items:center;gap:14px;background:#0a0a0a;border:1px solid #232323;border-radius:16px;padding:14px 18px;margin-bottom:8px}
.summary .k{font-size:11.5px;color:#8a8a8a}
.summary .v{font-size:19px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums}
.summary .vt{font-size:12px;color:#a3a3a3}
.timer{margin-inline-start:auto;text-align:center}
.timer .cd{font-size:19px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums;line-height:1.3}
.timer .k{font-size:10.5px;color:#8a8a8a}
.timebar{height:3px;background:#1a1a1a;border-radius:99px;overflow:hidden;margin:10px 0 20px}
.timebar i{display:block;height:100%;background:#fff;border-radius:99px;transition:width .3s linear}
.method{display:flex;align-items:center;gap:14px;width:100%;text-align:start;background:transparent;border:0;border-top:1px solid #1c1c1c;padding:17px 2px;cursor:pointer;color:#fff;font-family:inherit;transition:background .15s}
.method:hover{background:#0d0d0d}
.method .tick{width:46px;height:46px;flex:none;border:1px solid #2c2c2c;border-radius:13px;display:grid;place-items:center;font-size:10.5px;font-weight:800;letter-spacing:.04em}
.method .nm{font-size:15px;font-weight:700;line-height:1.6}
.method .ap{font-size:12px;color:#8a8a8a;direction:ltr;text-align:left;font-variant-numeric:tabular-nums}
.method .ch{margin-inline-start:auto;color:#5c5c5c;font-size:19px;flex:none}
.method .inf{flex:1}
.paywrap{display:flex;gap:18px;align-items:center;background:#0a0a0a;border:1px solid #232323;border-radius:18px;padding:18px;margin:4px 0 14px}
.ring{position:relative;width:66px;height:66px;flex:none}
.ring svg{transform:rotate(-90deg)}
.ring .rc{position:absolute;inset:0;display:grid;place-items:center;font-size:13.5px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums}
.paywrap .st{font-size:12px;color:#a3a3a3}
.paywrap .st b{color:#fff;font-size:14px}
.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-inline-end:6px;animation:pl 1.6s infinite}
@keyframes pl{0%,100%{opacity:1}50%{opacity:.25}}
.amtbox{border:1px solid #fff;border-radius:18px;padding:20px;margin-bottom:14px}
.amtbox .k{font-size:12px;color:#a3a3a3;margin-bottom:4px}
.amtbox .amt{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.amtbox .amt span{font-size:29px;font-weight:800;direction:ltr;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.addr-box{display:flex;align-items:center;gap:10px;background:#0a0a0a;border:1px solid #262626;border-radius:13px;padding:11px 13px;margin-bottom:6px}
.addr{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all;direction:ltr;text-align:left;color:#e5e5e5}
.copy{flex:none;background:transparent;color:#fff;border:1px solid #3f3f3f;border-radius:999px;padding:5px 14px;font-family:inherit;font-size:12.5px;cursor:pointer;transition:all .15s}
.copy:hover{background:#fff;color:#000;border-color:#fff}
.qrwrap{display:flex;justify-content:center;padding:10px 0 2px}
.qr{background:#fff;border-radius:14px;padding:7px}
.notes{margin:14px 0 20px}
.notes li{list-style:none;color:#a3a3a3;font-size:13px;padding:7px 0;border-top:1px solid #161616;display:flex;gap:10px}
.notes li b{color:#fff;font-weight:700}
.btnrow{display:flex;gap:10px;flex-wrap:wrap}
.btn{flex:1;min-width:150px;background:#fff;color:#000;border:1px solid #fff;border-radius:13px;padding:12px 18px;font-family:inherit;font-size:14.5px;font-weight:800;cursor:pointer;transition:all .15s}
.btn:hover{background:#e5e5e5}
.btn:disabled{opacity:.55;cursor:wait}
.btn.ghost{background:transparent;color:#fff;border-color:#3a3a3a;font-weight:600}
.btn.ghost:hover{border-color:#fff;background:transparent}
.state{text-align:center;padding:28px 0 6px}
.state .circ{width:74px;height:74px;margin:0 auto 18px;border:1.5px solid #fff;border-radius:50%;display:grid;place-items:center;font-size:31px}
.state h1{margin-bottom:6px}
.state p{color:#a3a3a3;font-size:14px;max-width:40ch;margin:0 auto}
.state .big{font-size:21px;font-weight:800;color:#fff;direction:ltr;margin-top:12px}
.bankcard{position:relative;overflow:hidden;aspect-ratio:1.586;max-width:430px;margin:0 auto 16px;border-radius:20px;padding:20px 22px;color:#fff;background:linear-gradient(130deg,#0b1e4b 0%,#0e4d7a 48%,#0a7a6e 100%);box-shadow:0 18px 40px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.25);display:flex;flex-direction:column;justify-content:space-between;text-align:start}
.bankcard:before{content:"";position:absolute;inset:0;background:radial-gradient(420px 200px at 85% -10%,rgba(255,255,255,.22),transparent 60%),radial-gradient(300px 300px at -10% 110%,rgba(255,255,255,.10),transparent 60%);pointer-events:none}
.bankcard>*{position:relative}
.bc-top{display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:15px}
.bc-type{font-size:11px;font-weight:600;opacity:.75}
.bc-mid{display:flex;justify-content:space-between;align-items:center}
.bc-chip{width:46px;height:34px;flex:none;border-radius:7px;background:linear-gradient(145deg,#f6d789,#c9a227 55%,#e9cd7a);box-shadow:inset 0 0 0 1px rgba(90,64,0,.35);position:relative}
.bc-chip:before,.bc-chip:after{content:"";position:absolute;left:0;right:0;height:1px;background:rgba(90,64,0,.4)}
.bc-chip:before{top:11px}
.bc-chip:after{top:22px}
.bc-num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:clamp(16px,5.2vw,22px);letter-spacing:.13em;text-align:left;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.35);white-space:nowrap}
.bc-bot{display:flex;justify-content:space-between;align-items:flex-end;gap:10px}
.bc-k{font-size:10px;opacity:.7;margin-bottom:2px}
.bc-holder{font-size:14.5px;font-weight:700}
.bc-copy{border-color:rgba(255,255,255,.55);color:#fff}
.bc-copy:hover{background:#fff;color:#0b1e4b;border-color:#fff}
.upload{border:1.5px dashed #3a3a3a;border-radius:16px;padding:18px;text-align:center;margin:16px 0 6px}
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
</style></head>
<body><main>
<header class="brand"><div class="mark">S</div><div><b>فروشگاه شماره مجازی</b><span>درگاه پرداخت</span></div><div class="secure">پرداخت امن</div></header>
${body}
<footer>مبلغ و آدرس را پیش از واریز یک‌بار دیگر بررسی کنید. هر پرداخت ۳۰ دقیقه مهلت دارد؛ پس از آن، درخواست به‌صورت خودکار بسته می‌شود.</footer>
</main>
<div id="toast"></div>
<script>
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200)}
function copyText(text){var done=function(){toast('کپی شد')};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(done)}else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();done()}}
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
function tick(){var ms=EXP-Date.now();var s=Math.max(0,Math.floor(ms/1000));var txt=pad(Math.floor(s/60))+':'+pad(s%60);document.querySelectorAll('.cd').forEach(function(e){e.textContent=txt});var bar=document.getElementById('timebar');if(bar)bar.style.width=Math.max(0,ms/SPAN*100)+'%';var ring=document.getElementById('ringfg');if(ring){var C=163.36;ring.style.strokeDashoffset=C*(1-Math.max(0,ms)/SPAN)}if(ms<=0&&!window._exp){window._exp=1;setTimeout(function(){location.reload()},1500)}}
setInterval(tick,250);tick();
async function selectMethod(m){toast('در حال ثبت روش پرداخت…');try{var r=await fetch('/pay/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:TID,m:m})});var d=await r.json().catch(function(){return{}});if(d.ok){location.reload()}else{toast(d.error||'خطا رخ داد')}}catch(e){toast('خطا در ارتباط')}};
async function checkNow(btn){btn.disabled=true;btn.textContent='در حال بررسی…';try{var r=await fetch('/pay/status?t='+TID+'&_='+Date.now(),{cache:'no-store'});var d=await r.json();if(d.status!=='pending'){location.reload();return}toast('هنوز پرداختی پیدا نشد؛ اگر تازه واریز کرده‌اید چند دقیقه صبر کنید')}catch(e){toast('خطا در بررسی')}btn.disabled=false;btn.textContent='🔄 بررسی پرداخت'}
function onReceiptFile(inp){var f=inp.files&&inp.files[0];var prev=document.getElementById('rcPrev');var btn=document.getElementById('rcBtn');var nm=document.getElementById('rcName');if(!f){if(btn)btn.disabled=true;return}if(nm)nm.textContent=f.name;if(prev){prev.src=URL.createObjectURL(f);prev.style.display='block'}if(btn)btn.disabled=false}
async function submitReceipt(btn){var inp=document.getElementById('rcFile');if(!inp||!inp.files||!inp.files[0]){toast('اول عکس رسید را انتخاب کنید');return}btn.disabled=true;btn.textContent='در حال ارسال…';try{var fd=new FormData();fd.append('receipt',inp.files[0]);var r=await fetch('/pay/receipt?t='+TID,{method:'POST',body:fd});var d=await r.json().catch(function(){return{}});if(d.ok){toast('رسید ثبت شد');setTimeout(function(){location.reload()},700)}else{toast(d.error||'خطا در ثبت رسید');btn.disabled=false;btn.textContent='📤 ثبت رسید'}}catch(e){toast('خطا در ارتباط');btn.disabled=false;btn.textContent='📤 ثبت رسید'}}
async function pollStatus(){try{var r=await fetch('/pay/status?t='+TID+'&_='+Date.now(),{cache:'no-store'});var d=await r.json();if(d.status!=='pending'||(!!d.receipt)!==HAS_RECEIPT)location.reload()}catch(e){}}
async function checkStatusBtn(btn){btn.disabled=true;btn.textContent='در حال بررسی…';await pollStatus();setTimeout(function(){toast('هنوز تأیید نشده؛ به محض تأیید ادمین، صفحه خودکار به‌روز می‌شود');btn.disabled=false;btn.textContent='🔄 بررسی وضعیت'},700)}
${poll ? "setInterval(pollStatus,5000);document.addEventListener('visibilitychange',function(){if(!document.hidden)pollStatus()});window.addEventListener('focus',pollStatus);pollStatus();" : ""}`;
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

  if (topup.status === "approved") {
    const user = await getUser(env, topup.userId);
    return payShell(`${head(3)}
      <div class="state"><div class="circ">✓</div>
      <h1>پرداخت تأیید شد</h1>
      <p>موجودی شما با موفقیت شارژ شد. می‌توانید این صفحه را ببندید و به ربات برگردید.</p>
      <div class="big">+$${esc(credit)}</div>
      <p>موجودی فعلی: $${esc(user.balance)}</p></div>`);
  }
  if (topup.status === "expired" || topupIsExpired(topup)) {
    return payShell(`${head(2)}
      <div class="state"><div class="circ">⏱</div>
      <h1>مهلت پرداخت تمام شد</h1>
      <p>این درخواست پرداخت بسته شد. برای شارژ حساب، داخل ربات یک پرداخت جدید بسازید.</p></div>`);
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
      ${rows.join("\n")}`, script);
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
      <button class="copy bc-copy" onclick="copyText('${esc(cardDigits || cfg.CARD_NUMBER || "")}')">کپی شماره کارت</button></div>
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
        <p class="sub"><span class="pulse"></span>رسید برای ادمین ارسال شده و <b style="color:#fff">منتظر تأیید ادمین</b> است؛ پس از تأیید، موجودی شما شارژ می‌شود و همین صفحه به‌صورت خودکار به‌روز می‌شود.</p>
        ${summary}
        <div class="btnrow"><button class="btn" onclick="checkStatusBtn(this)">🔄 بررسی وضعیت</button><button class="btn ghost" onclick="document.getElementById('reUp').style.display='block';this.style.display='none'">ارسال رسید جایگزین</button></div>
        <div id="reUp" style="display:none">${uploadBlock}</div>`, script);
    }
    return payShell(`${head(2)}
      <h1>کارت به کارت</h1>
      <p class="sub">مبلغ زیر را به کارت فروشگاه واریز کنید و رسید را همین‌جا آپلود کنید.</p>
      ${summary}
      ${bankCard}
      <div class="amtbox"><div class="k">مبلغ دقیق واریزی — تومان</div>
        <div class="amt"><span>${esc(String(topup.amountToman || 0))}</span><button class="copy" onclick="copyText('${esc(topup.amountToman || "")}')">کپی مبلغ</button></div></div>
      ${uploadBlock}
      <ul class="notes">
        <li><b>۱</b> دقیقاً همین مبلغ را به کارت بالا کارت‌به‌کارت کنید.</li>
        <li><b>۲</b> عکس رسید را همین‌جا آپلود و «ثبت رسید» را بزنید (یا عکس رسید را داخل ربات بفرستید).</li>
        <li><b>۳</b> رسید برای ادمین ارسال می‌شود؛ پس از تأیید، موجودی‌تان شارژ می‌شود.</li>
      </ul>
      <div class="btnrow"><button class="btn ghost" onclick="selectMethod('')">تغییر روش پرداخت</button></div>`, script);
  }

  // --- crypto payment view: only the chosen wallet + amount ---
  const c = CRYPTOS[topup.crypto] || {};
  const addr = topup.walletAddress || "";
  return payShell(`${head(2)}
    <h1>پرداخت ${esc(c.label || "")}</h1>
    <p class="sub">فقط از همین شبکه و دقیقاً همین مبلغ را واریز کنید.</p>
    ${topup.seenAt ? `<div class="paywrap">
      <div class="ring" style="display:grid;place-items:center;border:1px solid #2c2c2c;border-radius:50%;font-size:24px">⏳</div>
      <div><div class="st"><span class="pulse"></span><b>تراکنش دیده شد — در انتظار تأیید شبکه</b></div><div class="st">مبلغ شارژ: $${esc(credit)} ${tomanText}</div><div class="st">تراکنش شما در شبکه پیدا شده و منتظر تأیید (کانفرم) است. به محض تأیید، شارژ خودکار انجام و این صفحه به‌روز می‌شود. مهلت پرداخت شما تا آن زمان تمدید شده است.</div></div>
    </div>` : `<div class="paywrap">
      <div class="ring"><svg width="66" height="66"><circle cx="33" cy="33" r="26" stroke="#222" stroke-width="3" fill="none"/><circle id="ringfg" cx="33" cy="33" r="26" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="163.36" stroke-dashoffset="0"/></svg><div class="rc cd">30:00</div></div>
      <div><div class="st"><span class="pulse"></span><b>در انتظار پرداخت</b></div><div class="st">مبلغ شارژ: $${esc(credit)} ${tomanText}</div><div class="st">پس از دیده‌شدن تراکنش در شبکه، شارژ خودکار انجام و این صفحه به‌روز می‌شود.</div></div>
    </div>`}
    <div class="amtbox"><div class="k">مبلغ دقیق پرداختی — ${esc(c.label || "")}</div>
      <div class="amt"><span>${esc(topup.expectedCrypto)}</span><button class="copy" onclick="copyText('${esc(topup.expectedCrypto)}')">کپی مبلغ</button></div></div>
    <div class="addr-box"><code class="addr">${esc(addr)}</code><button class="copy" onclick="copyText('${esc(addr)}')">کپی آدرس</button></div>
    <div class="qrwrap"><img class="qr" alt="QR" width="140" height="140" loading="lazy" src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=${encodeURIComponent(addr)}"></div>
    <ul class="notes">
      <li><b>شبکه</b> واریز از شبکه دیگری به این آدرس، قابل شناسایی نیست.</li>
      <li><b>مبلغ دقیق</b> کمتر یا بیشتر از مبلغ بالا واریز نکنید؛ سیستم با همین مبلغ پرداخت شما را پیدا می‌کند.</li>
    </ul>
    <div class="btnrow"><button class="btn" onclick="checkNow(this)">🔄 بررسی پرداخت</button><button class="btn ghost" onclick="selectMethod('')">تغییر روش پرداخت</button></div>`, script);
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
      const cfgSetup = await getConfig(env);
      const webhook = await ensureWebhook(env, cfgSetup.WORKER_BASE_URL || url.origin);
      return Response.json({ ok: webhook.ok, kv: !!env.STORE, webhook });
    }
    if (url.pathname === "/" ) return Response.redirect(`${url.origin}/pay`, 302);
    if (url.pathname === "/pay/select" && request.method === "POST") {
      return handlePaySelect(env, request);
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
    if (url.pathname === "/pay") {
      const t = url.searchParams.get("t");
      let topup = t ? await kvGet(env, `topup:${t}`) : null;
      if (topup) topup = await settleTopupLazy(env, topup);
      const cfg = await getConfig(env);
      const html = await payPage(env, cfg, topup);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/health") {
      const wallex = await probeWallex();
      const usdtToman = await usdtTomanRate(env);
      const tmnDiag = await kvGet(env, "diag:tmn");
      return Response.json({ ok: true, kv: !!env.STORE, version: BOT_VERSION, usdtTomanRate: usdtToman, wallex, tmnDiag });
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (secret !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => ({}));
      const work = (async () => {
        if (update.message) await handleMessage(env, update.message, baseUrl);
        if (update.callback_query) await handleCallback(env, update.callback_query, baseUrl);
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
      if (origin) await ensureWebhook(env, origin);
      for (const t of await kvList(env, "topup:")) {
        if (t.status === "pending") await settleTopupLazy(env, t);
      }
    })();
    ctx.waitUntil(work);
  },
};
