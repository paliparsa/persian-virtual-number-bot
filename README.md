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
- **Real wallet-address checksum validation (v2.9.0):** Panel wallet entries are no longer accepted on a charset/length check — each network's actual checksum is verified before saving, so a single mistyped character can no longer silently burn user payments: TRON and BTC/LTC legacy addresses via Base58Check (double-SHA256, per-network version bytes), BTC/LTC SegWit and Taproot via Bech32/Bech32m (BIP-173/350, including witness-version/program rules), TON friendly addresses via their CRC16-XMODEM (raw `0:…` form also accepted), and EVM addresses (ETH, USDT ERC20/BEP20) via EIP-55 using an in-Worker Keccak-256 (single-case addresses carry no checksum and are accepted as-is; a mixed-case address with a broken checksum is rejected, as are cross-network mix-ups like an LTC address in the BTC field). `validateSetting` became async for the WebCrypto digests. Verified with 28 panel-flow cases (valid + tampered/truncated/cross-network per network).
- **Provider low-balance alert (v2.8.0):** The admin is now warned before the SmsFull balance runs out: when the spendable provider balance drops below a threshold (new «هشدار موجودی تأمین‌کننده (رئال)» setting in تنظیمات عمومی; default R$100, `0` disables), the bot sends the admin an alert with the balance in BRL and its USD equivalent, reminds at most every 6 hours while it stays low, and sends one recovery note when it tops back up. The check runs on the 2-minute cron (own balance fetch throttled to every 30 minutes) and piggybacks for free on the balance fetch the admin panel already makes, so opening the panel evaluates the alert immediately. Alert state lives in `sys:balAlert` (crossing/re-arm hysteresis, no spam). Fully flow-tested: crossing, no-duplicate, 6h reminder, recovery, re-arm, panel-set threshold, disabled, panel set/invalid flows, and the panel piggyback.
- **Zoom locked on all web pages (v2.7.4):** At the owner's request the web app, /pay and /terms no longer allow pinch, double-tap or trackpad zoom, while scrolling stays untouched. Applied on all three pages: viewport gains `maximum-scale=1, user-scalable=no`, `html{touch-action:manipulation}` kills double-tap zoom (and the tap delay), and a tiny script blocks iOS `gesturestart`/`gesturechange` (the pinch path Safari still honors) plus Ctrl+wheel zoom. The app search input went from 14px to 16px so iOS no longer auto-zooms when it is focused (the amount input was already 17px). Verified on the rendered pages: all guards present, all inline scripts still parse, the intro's touchstart/touchend swipe is unaffected, and the crypto suite still passes.
- **Etherscan key from the admin panel + apikey interpolation fix (v2.7.3):** The Etherscan API key no longer has to be a Cloudflare secret: it is a regular shop setting (Admin panel → تنظیمات عمومی → «کلید API اتراسکن (Etherscan)»), stored in KV config and overriding the Cloudflare variable of the same name, which remains as a fallback default. `findCryptoCandidates` resolves the key through `getConfig` for both Etherscan V2 calls (chainid 1 and 56). The key is treated as a secret in the UI (`SECRET_KEYS`): the settings list, edit prompt and save confirmation only ever show «ثبت شده (…last4)», and input is validated as 20–64 alphanumeric characters. The stricter panel-flow test (its mock rejects any apikey except the one registered in the panel) also exposed a real defect in v2.7.2: both Etherscan URLs had shipped with a literal placeholder instead of the interpolated key, so the key-based path could never have authenticated — the URLs are now built with `URLSearchParams` and byte-verified. The keyless paths (Blockscout for ERC20, BlastAPI for BEP20) were unaffected. Verified end-to-end: admin registers the key in the bot (invalid key rejected, stored value masked everywhere), then ERC20 and BEP20 top-ups are detected and credited with no Cloudflare key and the keyless sources disabled; the v2.7.2 suite still passes unchanged.
- **Crypto detection audit + fixes (v2.7.2):** A full end-to-end audit of the four USDT/TON detection paths against the live chain APIs found: (1) **USDT-ERC20 detection was completely dead** — the code called Etherscan's V1 API, which was shut down in 2025 and returns an error string instead of results, so no ERC20 payment could ever be detected (even with an API key). Fixed by moving to Etherscan API V2 (chainid 1) and adding Blockscout's public Ethereum index as a keyless primary source, so ERC20 works even without a key. (2) **USDT-BEP20's keyless path was broken** — the public BSC RPC nodes (BNB Chain dataseeds, PublicNode) now reject anonymous `eth_getLogs` outright ("limit exceeded" even for tiny ranges), and BSC's block time dropped to ~0.45s, invalidating the old lookback math. Fixed: BlastAPI's public BSC endpoint (verified to still serve `eth_getLogs`) is now tried first, the span is computed at 0.45s/block from selection time, every candidate log is verified against its block's real timestamp (an older in-band transfer can no longer match — logs carry no timestamp), and Etherscan V2 with chainid 56 is used when a key is configured. (3) **TON hardening** — incoming-message candidates now require a real sender (`in_msg.source`); transactions the wallet itself initiated (external trigger messages whose attached value is the amount being SENT plus fees) can no longer be mistaken for deposits. (4) TRC20 verified healthy against live TronGrid responses (exact field match) and gained a `type === "Transfer"` guard. All four paths re-tested end-to-end with payloads modeled on the real captured API responses, including negative controls (outgoing/old transfers, self-sends, duplicate sources) — no double credits.
- **Critical fix: KV TTL floor + app-styled cancel confirmations (v2.7.1):** Cloudflare KV rejects writes with `expirationTtl < 60`, but the concurrency lock wrote its key with a 30-second TTL — so on the live KV every lock-guarded action threw: admin receipt approval failed with an error, and payment cancellation failed with a network error in the bot, the web app and the pay page (purchases were unaffected because the buy lock used exactly 60s). `kvPut` now clamps every TTL to at least 60 seconds at the single choke point; logical short lifetimes (locks) are still enforced via the stored timestamp. Verified with a strict mock KV that reproduces the Cloudflare rejection. Also: the cancel-payment confirmation is no longer the browser's native `confirm()` — the web app uses its bottom-sheet design and the /pay page uses a matching slide-up modal, both with a red confirm action.
- **Pending payments everywhere, payment history tab, self-hosted QR + Toman display fixes (v2.7.0):** the bot's main menu now shows a «⏳ پرداخت‌های در انتظار» button whenever the user has an open payment; it lists each open payment with its own continue/cancel message. The web app shows open payments at the top of the شارژ view (amount, method, status, deadline, continue + cancel) and gains a fifth glass-nav tab «پرداخت‌ها» with the full payment history (new `GET /api/topups` returns pending + history). The minimum top-up is admin-driven end-to-end (no hardcoded figure remains anywhere, and the web app re-reads it whenever the شارژ view opens). The /pay wallet QR code is no longer loaded from an external QR API — the Worker generates it itself (compact QR encoder: byte mode, EC level M, versions 1–8, matrices verified against a reference implementation) and inlines it as SVG. Converted amounts on /pay can no longer overflow their cards on mobile (wrapping/clamp fixes) and the Toman equivalent now also fills in live via the status poll when the rate source is slow at first render.
- **PWA + first-visit intro (v2.6.0):** the web app is now an installable PWA — the Worker serves `/manifest.webmanifest` (BlueMajazi, standalone, RTL/fa), the app icons (`/icons/icon-192.png`, `/icons/icon-512.png` incl. maskable, `/icons/apple-touch-icon.png`, embedded as base64) and `/sw.js`, a deliberately conservative service worker that cache-firsts only those static assets and never touches pages, API or payment traffic; `/app` carries the manifest/theme/apple meta tags and registers the SW. A dismissible «نصب اپلیکیشن» card in the shop drives the install: Chrome/Android uses the captured `beforeinstallprompt`, iOS gets step-by-step Add-to-Home-Screen instructions in a sheet, and the card hides when already installed or dismissed. On the very first visit an intro overlay shows three slides (worldwide numbers / fast & simple / risk-free refunds + install hint) with dots, next/start buttons, a skip button and swipe support; it is remembered via `localStorage` and never shown again.
- **Admin-set minimum top-up (v2.5.0):** the minimum top-up amount is no longer hardcoded to $1 — a new «حداقل مبلغ شارژ (دلار)» field (`MIN_TOPUP_USD`) in the shop settings (general group, validated > 0 and ≤ 5000, delete to restore the $1 default) is enforced in the bot's USD and Toman amount handlers (rejection messages quote the configured minimum and its Toman equivalent), in `POST /api/topup`, in both bot amount prompts, and in the web app (exposed via `/api/me` as `minTopup`, shown in the top-up hint and pre-checked client-side).
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
