# Persian Virtual Number Bot — ربات فروش شماره مجازی

A Telegram bot with a **fully Persian user interface** that sells virtual numbers
through the [SmsFull API](https://docs.smsfullbot.com/), running as a single
**Cloudflare Worker** deployed automatically from this GitHub repo.

Users browse countries → services (live price + stock from SmsFull), buy a number
with their in-bot balance, and read the SMS code inside the bot.
If no SMS arrives and the activation is cancelled/expires, the user's balance is
refunded automatically (the provider only charges on a finished activation with SMS).

## How the money works

- **Shop currency is USD.** Provider (SmsFull) prices arrive in BRL and are converted
  automatically (daily FX rate from open.er-api.com), then sold at
  `USD price × (1 + markup/100)`. User balances are kept in USD in Cloudflare KV.
- **Every dollar amount is also shown in Toman**, converted automatically with the
  live USDT/TMN rate from the **Wallex API** (`api.wallex.ir/v1/markets`, cached 5 min).
- **Card (کارت به کارت):** your card details are shown in the bot. The user enters the
  Toman amount, and uploads the receipt right on the payment page (or sends the
  receipt photo in the bot); either way you get the receipt with the user id, the
  payment details and Approve/Reject buttons, and the user is told the receipt
  awaits admin approval.
  The Toman → USD credit conversion is automatic using the Wallex USDT rate
  (the rate used is stored on each top-up and shown to the admin).
- **Pay page design v2 (v1.8.0):** still minimal black/white — matte-black premium bank card, hero summary amount, filled-white success check, inline copied-feedback on copy buttons; orange is reserved for pending states and the under-5-minutes countdown, red only for rejected/expired states (including a dedicated rejected view).
- **Selection popups + rebrand (v2.4.0):** in the web app, tapping a country now opens a confirmation bottom sheet (big flag, country name, what happens next) and only «ادامه» proceeds to the services; tapping a service opens a «تأیید خرید» sheet with service, country, stock, price, Toman equivalent, current balance and balance-after-purchase (plus the refund note) — the old inline confirm card is gone, and an insufficient balance turns the primary button into a top-up shortcut. The brand shown across the web app and shop surfaces changed from BlueGate to **BlueMajazi**; the terms page (and its bot lead-in) intentionally keep the BlueGate name.
- **Yekan Bakh web font (v2.3.2):** all three web pages (/app, /pay, /terms) now load the Yekan Bakh family (weights 100–950 from cdnfonts) instead of Vazirmatn; every UI element inherits it, while wallet addresses and the bank-card number keep their monospace stack on purpose.
- **Emoji sweep completion (v2.3.1):** the last two UI emojis in the web app (🎉 in the activation heading, ⏰ in the expiry countdown) are gone — the heading is clean text and the countdown uses the same white SVG clock icon set.
- **Security round 2 + web design refresh (v2.3.0):** the BTC candidate scan regained its time filter (confirmed blocks older than the payment window are ignored, so an unrelated older transfer to a reused wallet address can no longer settle a new top-up); card receipts are indexed on first sight (bot path: Telegram `file_id`; web path: SHA-256 of the uploaded bytes, `rcpt:*`) and a receipt that appears for a second payment is flagged in the admin caption with a duplicate warning; the bot's activation view (`act:` → number + SMS code) now enforces the same ownership check as the actions; bot receipts are photos only (documents are refused, as on the web); `/pay`, `/app` and `/terms` send `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy` headers. The web app's UI emojis were replaced with pure-white inline SVG icons and the bottom tab bar is now a floating Apple-style glass pill (`backdrop-filter` blur/saturate, active tab inverted); `/pay` gained a working «لغو پرداخت» cancel button (new `POST /pay/cancel`, under the same per-topup KV lock, refused once a transfer is seen) plus a «بازگشت به صفحه اصلی» link and a dedicated cancelled view, and `/terms` got back/home buttons.
- **Security hardening (v2.2.0):** crypto top-ups now match transfers by txid with single-use claims (`txclaim:*`), a tight amount band (−3%/+1% around the unique expected amount) and best-match arbitration among competing open topups on the same wallet, so one deposit settles exactly one top-up; money paths are serialized with best-effort KV locks (credit, refund flag-first, expire, cancel, per-user buy lock + 30s identical-purchase debounce with a deterministic outcome); /pay method switching locks once a transfer is seen or a receipt exists, receipts are capped at 3 per payment, and KV rate limits guard auth, buy, select, receipt and the check button; /health and /setup return only `{ok, version}` publicly (full diagnostics require `?k=<DIAG_KEY or WEBHOOK_SECRET>`, probes cached 60s); web sessions last 7 days and the Telegram auth replay window is 1 hour; shop flows are private-chat only (groups: /setgroup only); a broken forced-join membership check now truly fails open and alerts the admin (throttled 6h) instead of silently blocking or passing. (Operator note: the WEBHOOK_SECRET was set in Cloudflare on 2026-11-03 and the webhook verified working, so the forged-update vector is closed.)
- **Web login fix (v2.1.1):** the /app inline script had a quoting bug (escaped quotes inside the Worker's template literal collapsed, producing invalid client JS) that killed the whole script — the Telegram login completed but `onTelegramAuth`/`boot` never ran, stranding users on the login screen. Fixed the five affected renderAct lines (event binding by id + HTML entities), added a Bearer-token session fallback (token returned in the auth response, kept in sessionStorage) alongside the cookie, boot retries for KV eventual consistency, and persistent login error text. Lesson: always extract the rendered client <script> and `node --check` it after editing inline page scripts.
- **Join notify, forced channel join, phone verification (v2.1.0):** the admin gets a one-time Telegram message when a brand-new user actually enters the bot (name, @username, numeric id). A settings section «عضویت و احراز هویت» adds: forced channel membership (toggle + channel @username/id; non-members are gated in the bot with a join + re-check prompt, and /api/buy & /api/topup return 403; the check fails open on API/config errors and the bot must be an admin in the channel) and phone verification for card-to-card only (toggle; selecting card parks the session as `card_verify`, /pay shows an explanation + deep link into the bot, the user shares their own contact via Telegram's request-contact button — foreign contacts are rejected — after which the session flips to card automatically, the page auto-advances, and both receipt paths stay blocked until verified). Note for maintainers: new shop settings must be added to CONFIG_KEYS or getConfig silently drops them.
- **Web app (v2.0.0):** a standalone web app at `/app` (the worker root now redirects there) with Telegram Login Widget auth (HMAC-verified against the bot token, 30-day HttpOnly session cookie) and a JSON API (`/api/me|countries|services|buy|activation|activation/action|orders|topup|auth/*`). It shares the bot's accounts, balances and orders (same KV records) — buy in the bot, track on the web and vice versa; the activation view auto-polls for the SMS code, and purchases/refunds/group announcements run through the same shared `buyActivation`/`syncActivation`/`actAction` core as the bot. One manual step: the bot's domain must be registered once with @BotFather via `/setdomain` or the login widget will not render.
- **Iran time + rules page (v1.10.0):** user-facing clock displays (activation expiry, last-check line) use the Asia/Tehran timezone; a Persian «قوانین و مقررات» page — distilled key rules under the BlueGate brand only — is served at `/terms` and linked from a main-menu URL button.
- **Activation screen rules (v1.9.0):** «بررسی کد» always answers (toast + a fresh last-check line, so the message visibly updates); «لغو» is blocked with a countdown alert during the provider's 2-minute no-cancel window and becomes impossible once a code is received; «اتمام کار» is only offered after a code has been received.
- **Purchase announcements (v1.7.0):** add the bot to a group and send /setgroup there as admin (or set GROUP_CHAT_ID in the admin settings panel); the first time a purchase's SMS code is delivered, the bot posts a success summary in that group — masked number, service and the buyer's numeric id. /unsetgroup disables it.
- **Payment sessions (v1.3.0, Toman entry added v1.5.0):** the user enters the top-up amount in the bot in USD, or in Toman — converted to USD at the live USDT/TMN rate, with the entered Toman and the rate shown on the session;
  that creates a payment session with a **30-minute deadline** and a link to the
  payment page on the bot's own domain (`/pay?t=<session-id>`). The payment
  method is chosen **on the page** (any configured crypto, or card-to-card);
  only then are the wallet, the unique exact crypto amount (or the Toman card
  total) fixed, and the page shows only that method. The page has a live
  countdown, polls `/pay/status` automatically, and expired sessions are
  closed by the cron. Crypto payments keep a **unique exact amount** on your
  shared wallet address and are checked automatically (button + page + cron every
  2 minutes). On a match it tops up the user automatically.
   Confirmation hardening (v1.3.1): BTC requires a confirmed transaction (mempool.space `status.confirmed`) and LTC requires >= 1 BlockCypher confirmation before crediting; a seen-but-unconfirmed BTC/LTC payment is marked seen, the user is notified, and its deadline extends to 24h after first sighting instead of expiring at 30 minutes. The TRX check verifies the recipient exactly (TronGrid hex to_address vs the Base58 wallet decoded to hex), same as USDT-TRC20.
  Auto-check supports USDT-TRC20, TRX, BTC, TON, LTC, USDT-BEP20 (read keylessly from BSC public RPC nodes via Transfer logs; BSC USDT has 18 decimals), and ETH / USDT-ERC20
  (ERC20 needs a free `ETHERSCAN_API_KEY`). Crypto USD prices are fetched redundantly — CoinGecko → Coinbase → Wallex-derived, with USDT fixed at $1 and a stale-cache last resort — because CoinGecko's free API aggressively rate-limits Cloudflare Workers' shared IPs, which used to abort top-ups with “price unavailable”.

## 1. Deploy from GitHub to Cloudflare (no code changes needed)

1. In Cloudflare Dashboard: **Workers & Pages → Create → Import a repository**
   (Connect to Git) → select this repository → Deploy.
   Build settings: framework preset **None**, build command empty,
   deploy command `npx wrangler deploy` (the default for Workers Git integration).
2. Every push to `main` now redeploys the Worker automatically.

## 2. Storage (KV) — automatic ✅

Nothing to do. `wrangler.toml` declares a KV binding named exactly **`STORE`**
with **no namespace id**, and the repo pins Wrangler v4, so on the first deploy
Cloudflare **automatically creates the KV namespace and binds it** to the Worker
(automatic resource provisioning). Its generated id shows in the dashboard under
Worker → Settings → Bindings; it is not written back to this repo, and the
binding stays linked on later deploys.

Fallback (only if auto-provisioning is unavailable on your account): create a KV
namespace manually and add its `id = "…"` under the `[[kv_namespaces]]` block in
`wrangler.toml`, then redeploy.

## 3. Set variables & secrets

> **Shop settings are managed inside Telegram now.** Card details, the Toman
> rate, all crypto wallet addresses, the markup %, the support username and the
> public Worker URL are edited from the bot itself: **Admin panel → ⚙️ تنظیمات
> فروشگاه** (button-based, with edit/delete per field, validation included).
> They are stored in KV and apply immediately — no redeploy, no Cloudflare visit.
> The Cloudflare variables of the same name below now only act as *initial
> defaults*; a value saved in the Telegram panel overrides them. Only the three
> secrets (bot token, admin ID, SmsFull key) must live in Cloudflare.

Worker → **Settings → Variables and Secrets**:

| Name | Type | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | Token from @BotFather |
| `ADMIN_CHAT_ID` | Secret/Text | Your numeric Telegram ID (get it from @userinfobot) |
| `SMSFULL_API_KEY` | Secret | SmsFull key: `smsfull_test_…` for sandbox, `smsfull_live_…` for real numbers |
| `WEBHOOK_SECRET` | Secret | Any random string; must match step 4 (optional but recommended) |
| `PRICE_MARKUP_PERCENT` | Text | e.g. `20` |
| `CARD_NUMBER`, `CARD_HOLDER`, `CARD_BANK` | Text | Shown to users for کارت به کارت |
| `WALLET_USDT_TRC20`, `WALLET_TRX`, `WALLET_BTC`, `WALLET_TON`, `WALLET_LTC`, `WALLET_ETH`, `WALLET_USDT_ERC20` | Text | Your wallet addresses; only set the ones you accept. They are shown publicly on `/pay` |
| `ETHERSCAN_API_KEY` | Secret | Only for ETH / USDT-ERC20 auto-check |
| `SUPPORT_USERNAME` | Text | Telegram username (no @) for the support button |
| `WORKER_BASE_URL` | Text | Optional: your public Worker URL. Lets the cron job restore the webhook even before anyone opens the Worker page |

Public URL note: wallet addresses and card details are *meant* to be shown to
customers, which is why they are plain variables — never put the bot token or the
SmsFull key anywhere except Secrets.

## 4. Telegram webhook — automatic ✅

Nothing to run. The Worker sets its own webhook to
`https://<your-worker-domain>/webhook`:

- The first time anyone opens the Worker URL (the root page, `/pay`, `/health`
  or `/setup`), it registers the webhook in the background.
- The cron job (every 2 minutes) re-checks it using the last seen public
  origin — or `WORKER_BASE_URL` if you set that variable — and fixes it if the
  domain changed or the webhook was deleted.
- Open `https://<your-worker-domain>/setup` to see the live result as JSON.

Notes: the bot token (and `WEBHOOK_SECRET`, if you set one) must already be in
the Worker secrets for this to work. Manual fallback if you ever need it:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR-WORKER-DOMAIN>/webhook&secret_token=<WEBHOOK_SECRET>"
```

Check it works: open `https://<YOUR-WORKER-DOMAIN>/health` → `{"ok":true,"kv":true}`
and `https://<YOUR-WORKER-DOMAIN>/pay` → the Persian wallet page.
- `GET /health` also reports the bot version plus a live Wallex probe (markets + depth endpoints, HTTP status, parsed USDT/TMN rate) and the last Toman-rate diagnostic — if Toman equivalents ever go missing in the bot, this shows whether Wallex is reachable from the Worker. The Toman rate falls back in order: Wallex /markets -> Wallex /depth -> Exir order book (USDT/IRT) -> an operator-set manual rate in the admin settings panel -> stale cache. (Wallex returns HTTP 403 to Cloudflare Workers egress IPs, verified via the /health probe on the live Worker; Exir is a different Iranian exchange whose API answered.)
Then send `/start` to your bot.

## 5. Test in sandbox first

Use an `smsfull_test_` key: real catalog/prices, fake balance (R$ 1,000),
numbers are fictitious and a code arrives ~15 seconds after buying.
Switch to the `smsfull_live_` key when you go live — no code change.

## SmsFull API endpoints used

Base: `https://core.smsfullbot.com/api/v1`, header `Authorization: Bearer <key>`

- `GET /countries`, `GET /services?countryId=`, `GET /balance`
- `POST /activations` (with `Idempotency-Key`), `GET /activations/{id}`
- `POST /activations/{id}/cancel | /resend | /finish`

## Admin (inside Telegram)

Send `/start` as the admin (or open «پنل مدیریت»): see provider balance,
approve/reject card receipts, review pending crypto payments and force a chain check,
and open **⚙️ تنظیمات فروشگاه** (also directly in the admin's main menu, or by sending `/settings`).
The admin panel shows the bot version — if the settings button is missing, your Worker is
still running an older deploy; check the latest deployment in Cloudflare and redeploy.
`GET /health` also reports `version`. — a full button panel with three groups:

- **💳 پرداخت کارتی:** card number, card holder, bank name (the Toman rate is automatic via Wallex — nothing to set)
- **🪙 کیف‌پول‌های کریپتو:** one editable wallet address per crypto (USDT-TRC20, USDT-BEP20, TRX, BTC, TON, LTC, ETH, USDT-ERC20)
- **🧰 عمومی:** markup %, support username, public Worker URL

Tap a field → send the new value as a message → it's validated and saved to KV
instantly. The 🗑 button next to a field clears it.

## Known limits of v1

- Country names are shown in English: SmsFull returns Portuguese names, but each country also carries a flag emoji encoding its ISO code, which the bot maps to the English name (Portuguese-name dictionary fallback). The country menu is two buttons per row with a search button (matches English/Portuguese names and ISO codes); the service menu also has a search button. The purchase confirmation shows an explicit Toman line converted at the live Wallex USDT rate.
- One shared wallet address per crypto (payments are matched by the unique exact
  amount — users must pay the exact amount shown, within 30 minutes).
- Card top-ups need your approval in the bot (there is no bank API in the flow).

---

## راهنمای کوتاه فارسی

۱. همین مخزن را در Cloudflare از بخش Workers & Pages به گیت‌هاب وصل کنید تا با هر پوش، خودش دیپلوی شود.
۲. فضای KV با نام `STORE` هنگام اولین دیپلوی به‌صورت خودکار ساخته و وصل می‌شود؛ کاری لازم نیست.
۳. توکن ربات، شناسه عددی مدیر و کلید SmsFull را فقط در Secrets کلودفلر بگذارید — هرگز داخل گیت‌هاب نگذارید.
۴. شماره کارت و آدرس کیف‌پول‌ها را در Variables بگذارید تا در ربات و صفحه پرداخت (`/pay`) نشان داده شوند.
۵. وبهوک تلگرام هم خودکار تنظیم می‌شود: فقط کافی است یک‌بار آدرس ورکر را باز کنید (یا `/setup` را ببینید)، بعد با `/start` تست بگیرید.
