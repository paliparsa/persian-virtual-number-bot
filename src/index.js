// Persian Telegram bot selling virtual numbers via the SmsFull API.
// Runs as a single Cloudflare Worker. Storage: one KV namespace bound as STORE.
// All user-facing bot text is in Persian (fa). Admin texts are Persian too.
//
// Required secrets (Cloudflare dashboard > Worker > Settings > Variables):
//   TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, SMSFULL_API_KEY
// Optional: WEBHOOK_SECRET, PRICE_MARKUP_PERCENT (default 20),
//   TOMAN_PER_BRL (card top-up rate), CARD_NUMBER, CARD_HOLDER, CARD_BANK,
//   WALLET_USDT_TRC20, WALLET_TRX, WALLET_BTC, WALLET_TON, WALLET_LTC,
//   WALLET_ETH, WALLET_USDT_ERC20, ETHERSCAN_API_KEY, SUPPORT_CHAT_ID/USERNAME

const SMSFULL_BASE = "https://core.smsfullbot.com/api/v1";
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

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
const markup = (env) => 1 + (parseFloat(env.PRICE_MARKUP_PERCENT || "20") / 100);
const sellPrice = (env, providerPrice) => Math.ceil(providerPrice * markup(env) * 100) / 100;
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

// ---------- crypto prices & on-chain checks ----------
// CoinGecko free endpoint (no key) for BRL prices, cached in KV for 5 minutes.
async function cryptoPriceBrl(env, coingeckoId) {
  const cacheKey = `price:${coingeckoId}`;
  const cached = await kvGet(env, cacheKey);
  if (cached && now() - cached.at < 5 * 60 * 1000) return cached.brl;
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=brl`
  );
  const d = await r.json().catch(() => ({}));
  const brl = d?.[coingeckoId]?.brl;
  if (!brl) throw new Error("priceUnavailable");
  await kvPut(env, cacheKey, { brl, at: now() }, 600);
  return brl;
}

const CRYPTOS = {
  USDT_TRC20: { label: "تتر (TRC20)", envKey: "WALLET_USDT_TRC20", cg: "tether", decimals: 4 },
  TRX: { label: "ترون (TRX)", envKey: "WALLET_TRX", cg: "tron", decimals: 3 },
  BTC: { label: "بیت‌کوین (BTC)", envKey: "WALLET_BTC", cg: "bitcoin", decimals: 8 },
  TON: { label: "تون (TON)", envKey: "WALLET_TON", cg: "the-open-network", decimals: 4 },
  LTC: { label: "لایت‌کوین (LTC)", envKey: "WALLET_LTC", cg: "litecoin", decimals: 5 },
  USDT_ERC20: { label: "تتر (ERC20)", envKey: "WALLET_USDT_ERC20", cg: "tether", decimals: 4 },
  ETH: { label: "اتریوم (ETH)", envKey: "WALLET_ETH", cg: "ethereum", decimals: 6 },
};
const configuredCryptos = (env) =>
  Object.entries(CRYPTOS).filter(([, c]) => env[c.envKey]);

// Returns true when a matching incoming transfer is found on-chain.
async function checkCryptoPaid(env, topup) {
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
        );
      }
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=50`);
      const d = await r.json().catch(() => ({}));
      return (d.data || []).some((t) => {
        const c = t.raw_data?.contract?.[0];
        const v = c?.parameter?.value;
        return v?.to_address && t.ret?.[0]?.contractRet === "SUCCESS" &&
          Number(v.amount || 0) / 1e6 >= want - 1e-3 &&
          Math.floor(t.block_timestamp / 1000) >= sinceSec;
      });
    }
    if (topup.crypto === "BTC") {
      const r = await fetch(`https://mempool.space/api/address/${addr}/txs`);
      const txs = await r.json().catch(() => []);
      return (Array.isArray(txs) ? txs : []).some((tx) =>
        (tx.vout || []).some((o) => o.scriptpubkey_address === addr && o.value >= Math.round(want * 1e8) - 10) &&
        (tx.status?.block_time || Math.floor(now() / 1000)) >= sinceSec - 3600
      );
    }
    if (topup.crypto === "TON") {
      const r = await fetch(
        `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(addr)}&limit=30&archival=false`
      );
      const d = await r.json().catch(() => ({}));
      return (d.result || []).some((tx) => {
        const msg = tx.in_msg;
        return msg && Number(msg.value || 0) / 1e9 >= want - 1e-4 && Number(tx.utime) >= sinceSec;
      });
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
      );
    }
    if (topup.crypto === "LTC") {
      const r = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${addr}/full?limit=50`);
      const d = await r.json().catch(() => ({}));
      return (d.txs || []).some((tx) =>
        (tx.outputs || []).some((o) => (o.addresses || []).includes(addr) && o.value >= Math.round(want * 1e8) - 100) &&
        (!tx.received || new Date(tx.received).getTime() / 1000 >= sinceSec - 3600)
      );
    }
  } catch (_) { /* network hiccup: stay pending, cron retries */ }
  return false;
}

async function creditTopup(env, topup, note) {
  const fresh = await kvGet(env, `topup:${topup.id}`);
  if (!fresh || fresh.status !== "pending") return false;
  fresh.status = "approved";
  fresh.resolvedAt = now();
  if (note) fresh.note = note;
  await kvPut(env, `topup:${topup.id}`, fresh);
  const user = await getUser(env, fresh.userId);
  user.balance = Math.round((Number(user.balance) + Number(fresh.creditBrl)) * 100) / 100;
  await saveUser(env, user);
  await send(env, fresh.userId,
    `✅ <b>موجودی شما افزایش یافت</b>\n\nمبلغ ${faNum(fresh.creditBrl)} واحد (BRL) به حساب شما اضافه شد.\nموجودی فعلی: ${faNum(user.balance)}`,
    mainMenuKb(env, fresh.userId));
  return true;
}

// ---------- bot UI (Persian) ----------
function mainMenuKb(env, userId) {
  const rows = [
    [btn("🛒 خرید شماره مجازی", "countries:0")],
    [btn("💰 موجودی من", "balance"), btn("💳 افزایش موجودی", "topup")],
    [btn("📱 سفارش‌های من", "orders")],
  ];
  if (env.SUPPORT_USERNAME) rows.push([urlBtn("🎧 پشتیبانی", `https://t.me/${env.SUPPORT_USERNAME}`)]);
  if (isAdmin(env, userId)) rows.push([btn("🛠 پنل مدیریت", "admin")]);
  return kb(rows);
}
const backKb = kb([[btn("⬅️ منوی اصلی", "home")]]);

async function showHome(env, chatId, editMsgId) {
  const user = await getUser(env, chatId);
  const text = `سلام 👋\nبه فروشگاه <b>شماره مجازی</b> خوش آمدید.\n\n💰 موجودی شما: <b>${faNum(user.balance)}</b> واحد\n\nبرای خرید، ابتدا کشور و سپس سرویس موردنظر را انتخاب کنید. کد پیامک به‌صورت خودکار همین‌جا نمایش داده می‌شود.`;
  if (editMsgId) return edit(env, chatId, editMsgId, text, mainMenuKb(env, chatId));
  return send(env, chatId, text, mainMenuKb(env, chatId));
}

function pageKb(items, page, perPage, makeCb, backTo) {
  const start = page * perPage;
  const slice = items.slice(start, start + perPage);
  const rows = slice.map((it) => [btn(it.label, makeCb(it))]);
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", makeCb(null, page - 1)));
  if (start + perPage < items.length) nav.push(btn("بعدی ▶️", makeCb(null, page + 1)));
  if (nav.length) rows.push(nav);
  rows.push([btn("⬅️ بازگشت", backTo)]);
  return kb(rows);
}

async function showCountries(env, chatId, msgId, page) {
  const countries = await smsfull(env, "/countries");
  const items = countries.map((c) => ({ label: `${c.emoji || "🌍"} ${c.name}`, id: c.id }));
  const text = `🌍 <b>کشور را انتخاب کنید:</b>\n\nتعداد کشورها: ${faInt(items.length)}`;
  return edit(env, chatId, msgId, text,
    pageKb(items, page, 10, (it, p) => it ? `services:${it.id}:0` : `countries:${p}`, "home"));
}

async function showServices(env, chatId, msgId, countryId, page) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const avail = services.filter((s) => s.available > 0);
  const items = avail.map((s) => ({
    label: `${s.name} — ${faNum(sellPrice(env, s.price))} | موجود: ${faInt(s.available)}`,
    id: s.id,
  }));
  const text = items.length
    ? `📲 <b>سرویس را انتخاب کنید:</b>\nقیمت‌ها با احتساب کارمزد فروشگاه و به واحد BRL است.`
    : `در حال حاضر برای این کشور شماره‌ای موجود نیست. لطفاً بعداً دوباره تلاش کنید.`;
  return edit(env, chatId, msgId, text,
    pageKb(items, page, 10, (it, p) => it ? `confirm:${countryId}:${it.id}` : `services:${countryId}:${p}`, "countries:0"));
}

async function showConfirm(env, chatId, msgId, countryId, serviceId) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const s = services.find((x) => x.id === Number(serviceId));
  if (!s) return edit(env, chatId, msgId, "این سرویس دیگر موجود نیست.", backKb);
  const price = sellPrice(env, s.price);
  const user = await getUser(env, chatId);
  const text = `🧾 <b>تأیید خرید</b>\n\nسرویس: <b>${esc(s.name)}</b>\nقیمت: <b>${faNum(price)}</b> واحد\nموجودی شما: ${faNum(user.balance)} واحد\nموجودی لحظه‌ای: ${faInt(s.available)} شماره\n\nپس از خرید، شماره نمایش داده می‌شود و تا ${faDigits(20)} دقیقه منتظر کد پیامک می‌ماند. اگر کدی نیاید، مبلغی از موجودی کسر نخواهد شد.`;
  return edit(env, chatId, msgId, text, kb([
    [btn("✅ تأیید و خرید", `buy:${countryId}:${serviceId}`)],
    [btn("⬅️ بازگشت", `services:${countryId}:0`)],
  ]));
}

async function doBuy(env, chatId, msgId, countryId, serviceId, cbId) {
  const services = await smsfull(env, `/services?countryId=${countryId}`);
  const s = services.find((x) => x.id === Number(serviceId));
  if (!s) { await answerCb(env, cbId, "سرویس موجود نیست", true); return; }
  const price = sellPrice(env, s.price);
  const user = await getUser(env, chatId);
  if (Number(user.balance) < price) {
    await answerCb(env, cbId, "موجودی کافی نیست", true);
    return edit(env, chatId, msgId,
      `❌ <b>موجودی کافی نیست.</b>\n\nقیمت: ${faNum(price)}\nموجودی شما: ${faNum(user.balance)}\n\nابتدا موجودی خود را افزایش دهید.`,
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
    id: act.id, userId: String(chatId), price, providerPrice: act.price,
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
    await send(env, chatId, `↩️ مبلغ ${faNum(rec.price)} واحد بابت سفارش بدون پیامک به موجودی شما برگشت.`);
  }
  return showActivation(env, chatId, msgId, act);
}

// ---------- top-ups: card receipt + crypto ----------
function topupMenuText() {
  return `💳 <b>افزایش موجودی</b>\n\nیکی از روش‌ها را انتخاب کنید:\n\n💳 <b>کارت به کارت:</b> مبلغ را به کارت فروشگاه واریز کنید و رسید را همین‌جا بفرستید. پس از تأیید مدیر، موجودی شارژ می‌شود.\n\n🪙 <b>ارز دیجیتال:</b> از صفحه کیف‌پول، آدرس ارز موردنظر را بردارید، <b>مبلغ دقیق</b> نمایش‌داده‌شده را واریز کنید؛ سیستم به‌صورت خودکار واریز را بررسی و حسابتان را شارژ می‌کند.`;
}
async function showTopup(env, chatId, msgId) {
  const rows = [];
  if (env.CARD_NUMBER) rows.push([btn("💳 کارت به کارت + ارسال رسید", "topup_card")]);
  if (configuredCryptos(env).length) rows.push([btn("🪙 پرداخت با ارز دیجیتال", "topup_crypto")]);
  rows.push([btn("⬅️ منوی اصلی", "home")]);
  const text = rows.length > 1 ? topupMenuText()
    : "روش پرداختی هنوز توسط مدیر تنظیم نشده است. لطفاً با پشتیبانی تماس بگیرید.";
  return edit(env, chatId, msgId, text, kb(rows));
}

async function startCardTopup(env, chatId, msgId) {
  const user = await getUser(env, chatId);
  user.state = "await_card_amount";
  await saveUser(env, user);
  const rate = env.TOMAN_PER_BRL ? `نرخ فعلی: هر واحد = ${faInt(env.TOMAN_PER_BRL)} تومان` : "نرخ توسط مدیر هنگام تأیید محاسبه می‌شود.";
  return edit(env, chatId, msgId,
    `💳 <b>کارت به کارت</b>\n\nشماره کارت: <code>${esc(env.CARD_NUMBER)}</code>\nبه نام: ${esc(env.CARD_HOLDER || "")}${env.CARD_BANK ? `\nبانک: ${esc(env.CARD_BANK)}` : ""}\n\n${rate}\n\n✍️ مبلغی را که واریز می‌کنید به <b>تومان</b> بنویسید (فقط عدد):`,
    kb([[btn("⬅️ بازگشت", "topup")]]));
}

async function startCryptoTopup(env, chatId, msgId) {
  const rows = configuredCryptos(env).map(([code, c]) => [btn(c.label, `crypto_new:${code}`)]);
  rows.push([btn("⬅️ بازگشت", "topup")]);
  return edit(env, chatId, msgId, `🪙 <b>ارز را انتخاب کنید:</b>\n\nدر مرحله بعد مبلغ شارژ (به واحد BRL) را می‌نویسید و مبلغ دقیق ارزی و آدرس کیف‌پول به شما نشان داده می‌شود.`, kb(rows));
}

async function createCryptoTopup(env, chatId, cryptoCode, creditBrl, baseUrl) {
  const c = CRYPTOS[cryptoCode];
  const price = await cryptoPriceBrl(env, c.cg); // BRL per 1 coin
  const base = creditBrl / price;
  // Unique tail so the exact amount identifies this top-up on a shared wallet.
  const tail = cryptoCode === "BTC"
    ? (Math.floor(Math.random() * 900) + 100) / 1e8
    : (Math.floor(Math.random() * 900) + 100) / 1e6;
  const expected = Number((base + tail).toFixed(c.decimals));
  const topup = {
    id: uid(), userId: String(chatId), method: "crypto", crypto: cryptoCode,
    walletAddress: env[c.envKey], creditBrl, expectedCrypto: expected,
    status: "pending", createdAt: now(), expiresAt: now() + 60 * 60 * 1000,
  };
  await kvPut(env, `topup:${topup.id}`, topup, 2 * 24 * 3600);
  return topup;
}

// ---------- admin ----------
async function showAdmin(env, chatId, msgId) {
  let balText = "";
  try {
    const b = await smsfull(env, "/balance");
    balText = `\n\n💼 موجودی نزد تأمین‌کننده: <b>${faNum(b.spendable)}</b> ${esc(b.currency)} (کل: ${faNum(b.balance)})`;
  } catch (e) { balText = `\n\n⚠️ خطا در دریافت موجودی تأمین‌کننده: ${esc(e.message)}`; }
  const text = `🛠 <b>پنل مدیریت</b>${balText}`;
  const rows = [
    [btn("🧾 رسیدهای در انتظار تأیید", "adm_pending")],
    [btn("🪙 پرداخت‌های کریپتوی در انتظار", "adm_crypto_pending")],
    [btn("⬅️ منوی اصلی", "home")],
  ];
  if (msgId) return edit(env, chatId, msgId, text, kb(rows));
  return send(env, chatId, text, kb(rows));
}
async function showPending(env, chatId, msgId, method) {
  const all = (await kvList(env, "topup:")).filter(
    (t) => t.status === "pending" && t.method === method);
  if (!all.length) return edit(env, chatId, msgId, "موردی در انتظار نیست. ✅", kb([[btn("⬅️ پنل مدیریت", "admin")]]));
  let text = method === "card" ? "🧾 <b>رسیدهای در انتظار:</b>\n" : "🪙 <b>پرداخت‌های کریپتوی در انتظار:</b>\n";
  const rows = [];
  for (const t of all.slice(0, 10)) {
    text += `\n— کاربر ${faDigits(t.userId)} | شارژ: ${faNum(t.creditBrl)} واحد${t.method === "card" ? ` | مبلغ کارت: ${faInt(t.amountToman)} تومان` : ` | ${esc(t.crypto)}: ${faDigits(t.expectedCrypto)}`}`;
    rows.push([
      btn(`✅ تأیید ${faNum(t.creditBrl)}`, `apr:${t.id}`),
      btn("❌ رد", `rej:${t.id}`),
    ]);
    if (t.method === "crypto") rows.push([btn("🔄 بررسی زنجیره", `chk:${t.id}`)]);
  }
  rows.push([btn("⬅️ پنل مدیریت", "admin")]);
  return edit(env, chatId, msgId, text, kb(rows));
}

// ---------- message / callback router ----------
async function handleMessage(env, msg, baseUrl) {
  const chatId = msg.chat.id;
  const user = await getUser(env, chatId);
  const text = enDigits((msg.text || "").trim());

  if (text === "/start") { user.state = null; await saveUser(env, user); return showHome(env, chatId); }
  if (text === "/admin" && isAdmin(env, chatId)) return showAdmin(env, chatId);

  // Receipt photo for a pending card top-up
  if (user.state === "await_card_receipt" && (msg.photo || msg.document)) {
    const topup = await kvGet(env, `topup:${user.stateData}`);
    if (!topup) { user.state = null; await saveUser(env, user); return send(env, chatId, "درخواست شارژ پیدا نشد. دوباره تلاش کنید.", backKb); }
    topup.receiptFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    topup.status = "pending";
    await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
    user.state = null; user.stateData = null;
    await saveUser(env, user);
    await send(env, chatId, "🧾 رسید شما دریافت شد و برای تأیید نزد مدیر ارسال شد. پس از تأیید، موجودی‌تان شارژ می‌شود.", mainMenuKb(env, chatId));
    // Forward receipt to admin with approve/reject buttons
    const cap = `🧾 <b>رسید جدید</b>\nکاربر: ${faDigits(chatId)}\nمبلغ کارت: ${faInt(topup.amountToman)} تومان\nشارژ درخواستی: ${faNum(topup.creditBrl)} واحد`;
    const adminKb = kb([[btn("✅ تأیید و شارژ", `apr:${topup.id}`), btn("❌ رد رسید", `rej:${topup.id}`)]]);
    if (msg.photo) await tg(env, "sendPhoto", { chat_id: env.ADMIN_CHAT_ID, photo: topup.receiptFileId, caption: cap, parse_mode: "HTML", reply_markup: adminKb });
    else await tg(env, "sendDocument", { chat_id: env.ADMIN_CHAT_ID, document: topup.receiptFileId, caption: cap, parse_mode: "HTML", reply_markup: adminKb });
    return;
  }

  if (user.state === "await_card_amount" && /^[0-9]+$/.test(text.replace(/[,٬]/g, ""))) {
    const amountToman = Number(text.replace(/[,٬]/g, ""));
    const rate = Number(env.TOMAN_PER_BRL || 0);
    const creditBrl = rate > 0 ? Math.floor((amountToman / rate) * 100) / 100 : 0;
    const topup = {
      id: uid(), userId: String(chatId), method: "card", amountToman,
      creditBrl, status: "awaiting_receipt", createdAt: now(),
    };
    await kvPut(env, `topup:${topup.id}`, topup, 7 * 24 * 3600);
    user.state = "await_card_receipt"; user.stateData = topup.id;
    await saveUser(env, user);
    return send(env, chatId,
      `مبلغ ${faInt(amountToman)} تومان ثبت شد.${rate > 0 ? `\nمعادل تقریبی شارژ: ${faNum(creditBrl)} واحد` : ""}\n\n📸 حالا <b>عکس رسید</b> واریز را همین‌جا بفرستید:`,
      kb([[btn("⬅️ منوی اصلی", "home")]]));
  }

  if (user.state?.startsWith("await_crypto_amount:") && /^[0-9]+(\.[0-9]+)?$/.test(text)) {
    const cryptoCode = user.state.split(":")[1];
    const creditBrl = Number(text);
    user.state = null;
    await saveUser(env, user);
    if (creditBrl < 1) return send(env, chatId, "حداقل مبلغ شارژ ۱ واحد است.", backKb);
    try {
      const topup = await createCryptoTopup(env, chatId, cryptoCode, creditBrl, baseUrl);
      const c = CRYPTOS[cryptoCode];
      const payUrl = `${baseUrl}/pay?t=${topup.id}`;
      return send(env, chatId,
        `🪙 <b>پرداخت ${esc(c.label)}</b>\n\nمبلغ دقیق: <code>${faDigits(topup.expectedCrypto)}</code>\nآدرس کیف‌پول:\n<code>${esc(topup.walletAddress)}</code>\n\n⚠️ دقیقاً همین مبلغ را واریز کنید تا سیستم خودکار آن را پیدا کند. اعتبار این درخواست: ${faDigits(60)} دقیقه\n\nپس از واریز، دکمه «بررسی پرداخت» را بزنید (بررسی خودکار هم هر چند دقیقه انجام می‌شود).`,
        kb([
          [urlBtn("🌐 صفحه پرداخت و کیف‌پول‌ها", payUrl)],
          [btn("🔄 بررسی پرداخت", `chk:${topup.id}`)],
          [btn("⬅️ منوی اصلی", "home")],
        ]));
    } catch (e) {
      return send(env, chatId, "در حال حاضر دریافت قیمت ارز ممکن نیست. چند دقیقه دیگر تلاش کنید.", backKb);
    }
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
    if (head === "countries") return showCountries(env, chatId, msgId, Number(a || 0));
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
      return edit(env, chatId, msgId, `💰 <b>موجودی شما:</b> ${faNum(user.balance)} واحد (BRL)\n\nواحد موجودی معادل قیمت تأمین‌کننده به رئال برزیل (BRL) به‌همراه کارمزد فروشگاه است.`, kb([[btn("💳 افزایش موجودی", "topup")], [btn("⬅️ منوی اصلی", "home")]]));
    }
    if (data === "orders") {
      const mine = (await kvList(env, "act:")).filter((x) => x.userId === String(chatId))
        .sort((x, y) => y.createdAt - x.createdAt).slice(0, 10);
      if (!mine.length) return edit(env, chatId, msgId, "هنوز سفارشی ندارید.", backKb);
      const rows = mine.map((o) => [btn(`📱 +${o.phoneNumber} — ${o.serviceName}`, `act:${o.id}`)]);
      rows.push([btn("⬅️ منوی اصلی", "home")]);
      return edit(env, chatId, msgId, "📱 <b>سفارش‌های اخیر شما:</b>", kb(rows));
    }
    if (data === "topup") return showTopup(env, chatId, msgId);
    if (data === "topup_card") return startCardTopup(env, chatId, msgId);
    if (data === "topup_crypto") return startCryptoTopup(env, chatId, msgId);
    if (head === "crypto_new") {
      const user = await getUser(env, chatId);
      user.state = `await_crypto_amount:${a}`;
      await saveUser(env, user);
      return edit(env, chatId, msgId, `🪙 ${esc(CRYPTOS[a].label)} انتخاب شد.\n\n✍️ مبلغ شارژ را به <b>واحد BRL</b> بنویسید (فقط عدد، مثال: 50):`, kb([[btn("⬅️ بازگشت", "topup_crypto")]]));
    }
    if (head === "chk") {
      const topup = await kvGet(env, `topup:${a}`);
      if (!topup || topup.status !== "pending") { await answerCb(env, cq.id, "این پرداخت قبلاً تعیین‌تکلیف شده است"); return; }
      const paid = await checkCryptoPaid(env, topup);
      if (paid) { await creditTopup(env, topup, "auto-chain"); await answerCb(env, cq.id, "پرداخت تأیید و حساب شارژ شد ✅"); return showHome(env, chatId, msgId); }
      await answerCb(env, cq.id, "هنوز واریزی با مبلغ دقیق پیدا نشد. اگر تازه واریز کرده‌اید چند دقیقه صبر کنید.", true);
      return;
    }
    if (data === "admin" && isAdmin(env, chatId)) return showAdmin(env, chatId, msgId);
    if (data === "adm_pending" && isAdmin(env, chatId)) return showPending(env, chatId, msgId, "card");
    if (data === "adm_crypto_pending" && isAdmin(env, chatId)) return showPending(env, chatId, msgId, "crypto");
    if ((head === "apr" || head === "rej") && isAdmin(env, chatId)) {
      const topup = await kvGet(env, `topup:${a}`);
      if (!topup || !["pending", "awaiting_receipt"].includes(topup.status)) { await answerCb(env, cq.id, "قبلاً تعیین‌تکلیف شده"); return; }
      if (head === "apr") {
        if (topup.method === "card" && !(topup.creditBrl > 0)) {
          await answerCb(env, cq.id, "نرخ TOMAN_PER_BRL تنظیم نشده؛ ابتدا نرخ را در تنظیمات Worker ست کنید، یا مبلغ شارژ را دستی اصلاح کنید.", true);
          return;
        }
        topup.status = "pending"; // creditTopup expects pending
        await kvPut(env, `topup:${topup.id}`, topup);
        await creditTopup(env, topup, "admin-approved");
        await answerCb(env, cq.id, "تأیید و شارژ شد ✅");
      } else {
        topup.status = "rejected"; topup.resolvedAt = now();
        await kvPut(env, `topup:${topup.id}`, topup);
        await send(env, topup.userId, "❌ درخواست افزایش موجودی شما رد شد. برای پیگیری با پشتیبانی در تماس باشید.", mainMenuKb(env, topup.userId));
        await answerCb(env, cq.id, "رد شد");
      }
      return showAdmin(env, chatId, msgId);
    }
  } catch (e) {
    await answerCb(env, cq.id, "خطایی رخ داد. دوباره تلاش کنید.", true);
  }
}

// ---------- wallet / payment web page (Persian) ----------
function walletPage(env, topup) {
  const wallets = configuredCryptos(env).map(([code, c]) => {
    const addr = env[c.envKey];
    const hot = topup && topup.crypto === code;
    return `<section class="card${hot ? " hot" : ""}"><h2>${esc(c.label)}${hot ? " ⭐️ پرداخت شما" : ""}</h2>
      <code class="addr">${esc(addr)}</code>
      <button onclick="navigator.clipboard.writeText('${esc(addr)}')">کپی آدرس</button>
      <img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(addr)}">
    </section>`;
  }).join("\n");
  const topupBox = topup
    ? `<section class="card hot"><h2>مبلغ دقیق پرداخت</h2><p class="amt">${esc(topup.expectedCrypto)} — ${esc(CRYPTOS[topup.crypto]?.label || "")}</p><p>دقیقاً همین مبلغ را به آدرس بالا واریز کنید. شارژ به‌صورت خودکار پس از دیده‌شدن تراکنش در شبکه انجام می‌شود.</p></section>`
    : "";
  const cardBox = env.CARD_NUMBER
    ? `<section class="card"><h2>کارت به کارت</h2><code class="addr">${esc(env.CARD_NUMBER)}</code><p>به نام: ${esc(env.CARD_HOLDER || "")}${env.CARD_BANK ? ` — ${esc(env.CARD_BANK)}` : ""}</p><p>پس از واریز، رسید را داخل ربات تلگرام بفرستید.</p></section>`
    : "";
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>کیف‌پول و پرداخت — فروشگاه شماره مجازی</title>
<style>body{font-family:Tahoma,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
main{max-width:640px;margin:0 auto}h1{font-size:20px}.card{background:#1e293b;border-radius:14px;padding:16px;margin:12px 0}
.hot{outline:2px solid #22c55e}.addr{display:block;word-break:break-all;background:#0f172a;padding:10px;border-radius:8px;direction:ltr;text-align:left}
button{margin-top:8px;padding:8px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}
img{display:block;margin-top:10px;border-radius:8px;background:#fff;padding:4px}.amt{font-size:20px;font-weight:bold;direction:ltr;text-align:right}</style></head>
<body><main><h1>💳 صفحه پرداخت فروشگاه شماره مجازی</h1>
<p>برای افزایش موجودی، یکی از روش‌های زیر را استفاده کنید. در پرداخت ارزی، حتماً <b>مبلغ دقیق</b> نمایش‌داده‌شده در ربات را واریز کنید.</p>
${topupBox}${wallets}${cardBox}
<p>بعد از پرداخت ارزی، در ربات دکمه «بررسی پرداخت» را بزنید؛ بررسی خودکار هم انجام می‌شود.</p>
</main></body></html>`;
}

// ---------- Worker entry ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const baseUrl = url.origin;
    if (url.pathname === "/" ) return Response.redirect(`${url.origin}/pay`, 302);
    if (url.pathname === "/pay") {
      const t = url.searchParams.get("t");
      const topup = t ? await kvGet(env, `topup:${t}`) : null;
      return new Response(walletPage(env, topup), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, kv: !!env.STORE });
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
      const pending = (await kvList(env, "topup:")).filter(
        (t) => t.method === "crypto" && t.status === "pending" && t.expiresAt > now());
      for (const t of pending) {
        if (await checkCryptoPaid(env, t)) await creditTopup(env, t, "auto-chain-cron");
      }
    })();
    ctx.waitUntil(work);
  },
};
