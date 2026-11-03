# Persian Virtual Number Bot — ربات فروش شماره مجازی

A Telegram bot with a **fully Persian user interface** that sells virtual numbers
through the [SmsFull API](https://docs.smsfullbot.com/), running as a single
**Cloudflare Worker** deployed automatically from this GitHub repo.

Users browse countries → services (live price + stock from SmsFull), buy a number
with their in-bot balance, and read the SMS code inside the bot.
If no SMS arrives and the activation is cancelled/expires, the user's balance is
refunded automatically (the provider only charges on a finished activation with SMS).

## How the money works

- Provider prices are in **BRL**. The bot sells at `provider price × (1 + PRICE_MARKUP_PERCENT/100)`.
- User balance is kept in BRL credits in Cloudflare KV.
- **Card (کارت به کارت):** your card details are shown in the bot. The user enters the
  Toman amount, sends a receipt photo, and you approve/reject it from the admin panel
  inside the bot (you also get the receipt forwarded with Approve/Reject buttons).
  Set `TOMAN_PER_BRL` so the bot can convert Toman → BRL credits automatically.
- **Crypto:** the bot creates a payment with a **unique exact amount** on your shared
  wallet address, links the user to the wallet page on the bot's own domain
  (`/pay?t=<topup-id>`), and checks the chain automatically (button + cron every
  2 minutes). On a match it tops up the user automatically.
  Auto-check supports USDT-TRC20, TRX, BTC, TON, LTC, and ETH / USDT-ERC20
  (ERC20 needs a free `ETHERSCAN_API_KEY`). Prices in BRL come from CoinGecko.

## 1. Deploy from GitHub to Cloudflare (no code changes needed)

1. In Cloudflare Dashboard: **Workers & Pages → Create → Import a repository**
   (Connect to Git) → select this repository → Deploy.
   Build settings: framework preset **None**, build command empty,
   deploy command `npx wrangler deploy` (the default for Workers Git integration).
2. Every push to `main` now redeploys the Worker automatically.

## 2. Add storage (KV)

Worker → **Settings → Bindings → Add → KV namespace**:

- Create a namespace (e.g. `persian-bot-store`)
- Variable name: **`STORE`** ← must be exactly this

## 3. Set variables & secrets

Worker → **Settings → Variables and Secrets**:

| Name | Type | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | Token from @BotFather |
| `ADMIN_CHAT_ID` | Secret/Text | Your numeric Telegram ID (get it from @userinfobot) |
| `SMSFULL_API_KEY` | Secret | SmsFull key: `smsfull_test_…` for sandbox, `smsfull_live_…` for real numbers |
| `WEBHOOK_SECRET` | Secret | Any random string; must match step 4 (optional but recommended) |
| `PRICE_MARKUP_PERCENT` | Text | e.g. `20` |
| `TOMAN_PER_BRL` | Text | Toman price of 1 BRL credit (needed for automatic card credit) |
| `CARD_NUMBER`, `CARD_HOLDER`, `CARD_BANK` | Text | Shown to users for کارت به کارت |
| `WALLET_USDT_TRC20`, `WALLET_TRX`, `WALLET_BTC`, `WALLET_TON`, `WALLET_LTC`, `WALLET_ETH`, `WALLET_USDT_ERC20` | Text | Your wallet addresses; only set the ones you accept. They are shown publicly on `/pay` |
| `ETHERSCAN_API_KEY` | Secret | Only for ETH / USDT-ERC20 auto-check |
| `SUPPORT_USERNAME` | Text | Telegram username (no @) for the support button |

Public URL note: wallet addresses and card details are *meant* to be shown to
customers, which is why they are plain variables — never put the bot token or the
SmsFull key anywhere except Secrets.

## 4. Point Telegram at the Worker (webhook)

After the first deploy, run once (replace the values):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR-WORKER-DOMAIN>/webhook&secret_token=<WEBHOOK_SECRET>"
```

Check it works: open `https://<YOUR-WORKER-DOMAIN>/health` → `{"ok":true,"kv":true}`
and `https://<YOUR-WORKER-DOMAIN>/pay` → the Persian wallet page.
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
approve/reject card receipts, review pending crypto payments and force a chain check.

## Known limits of v1

- Country names come from SmsFull in Portuguese; service names as provided.
- One shared wallet address per crypto (payments are matched by the unique exact
  amount — users must pay the exact amount shown, within 60 minutes).
- Card top-ups need your approval in the bot (there is no bank API in the flow).

---

## راهنمای کوتاه فارسی

۱. همین مخزن را در Cloudflare از بخش Workers & Pages به گیت‌هاب وصل کنید تا با هر پوش، خودش دیپلوی شود.
۲. یک KV بسازید و با نام `STORE` به ورکر وصل کنید.
۳. توکن ربات، شناسه عددی مدیر و کلید SmsFull را فقط در Secrets کلودفلر بگذارید — هرگز داخل گیت‌هاب نگذارید.
۴. شماره کارت و آدرس کیف‌پول‌ها را در Variables بگذارید تا در ربات و صفحه پرداخت (`/pay`) نشان داده شوند.
۵. وبهوک تلگرام را با دستور مرحله ۴ روی آدرس ورکر تنظیم کنید و با `/start` تست بگیرید.
