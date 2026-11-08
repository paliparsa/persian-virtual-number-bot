// lib/backup.js — admin shop backup: export / validate / restore (v3.2.0,
// ported from BG-3x-ui-sell and adapted to this shop's keyspaces).
//
// A backup is ONE JSON document the admin downloads into their own
// Telegram chat and can later upload back to restore the shop. It covers
// the shop's durable state only:
//   included: config (shop settings — includes the bank card details,
//             crypto wallets and the Etherscan API key, so the file must
//             be kept safe; the SmsFull API key is a Cloudflare secret
//             and is NOT in config), top-up packages (topup_pkgs), and
//             the record keyspaces coupon:* / user:* / act:* exported as
//             full-KV-key → record maps so a restore can rebuild the
//             exact same keys. act:* records are this shop's orders.
//   excluded (deliberately): topup:* (payment sessions and history —
//             payment state must never be rewound), sess:* web sessions,
//             lock:* KV locks, rl:* rate-limit buckets, sys:* state,
//             rate caches, audit:* entries, lastbuy:* dedupe keys.
//
// Restore REPLACES each covered keyspace (existing keys are deleted
// first — never merged), and bot.js always sends a fresh pre-restore
// backup of the current state before applying one. This module stays a
// leaf: it reads/writes KV directly through lib/core.js helpers and
// never imports shop.js/payments.js/bot.js.
import { BOT_VERSION, kvDel, kvDeletePrefix, kvGet, kvKeys, kvPut, now } from "./core.js";

export const BACKUP_VERSION = 1;
export const BACKUP_APP = "persian-virtual-number-bot";
export const BACKUP_KIND = "bluemajazi-backup";
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const RECORD_PREFIXES = ["coupon:", "user:", "act:"];

// Tehran wall-clock stamp for file names: YYYYMMDD-HHmm.
export function tehranStamp(ts = now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}${g("month")}${g("day")}-${g("hour")}${g("minute")}`;
}

// One human-readable Tehran date for captions/summaries.
export function tehranDateText(ts) {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ts));
  } catch (_) { return new Date(ts).toISOString(); }
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Builds the backup object from live KV state.
export async function buildBackup(env) {
  const [config, pkgs] = await Promise.all([kvGet(env, "config"), kvGet(env, "topup_pkgs")]);
  const records = {};
  for (const prefix of RECORD_PREFIXES) {
    for (const key of await kvKeys(env, prefix)) {
      const v = await kvGet(env, key);
      if (v !== null && v !== undefined) records[key] = v;
    }
  }
  return {
    app: BACKUP_APP, kind: BACKUP_KIND, version: BACKUP_VERSION,
    botVersion: BOT_VERSION, createdAt: now(),
    data: {
      config: isPlainObject(config) ? config : null,
      pkgs: Array.isArray(pkgs) ? pkgs : null,
      records,
    },
  };
}

export function backupCounts(backup) {
  const d = backup?.data || {};
  const rec = isPlainObject(d.records) ? d.records : {};
  const count = (p) => Object.keys(rec).filter((k) => k.startsWith(p)).length;
  return {
    pkgs: Array.isArray(d.pkgs) ? d.pkgs.length : 0,
    coupons: count("coupon:"),
    users: count("user:"),
    acts: count("act:"),
  };
}

// Everything bot.js needs to send a backup document: pretty JSON bytes,
// a stamped file name ("bluemajazi-backup-…" or
// "bluemajazi-pre-restore-…") and the per-section counts for the caption.
export async function buildBackupFile(env, kind = "backup") {
  const backup = await buildBackup(env);
  const stamp = tehranStamp(backup.createdAt);
  const filename = kind === "pre-restore" ? `bluemajazi-pre-restore-${stamp}.json` : `bluemajazi-backup-${stamp}.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(backup, null, 2));
  return { backup, bytes, filename, counts: backupCounts(backup) };
}

// Strict shape validation for an uploaded backup. Returns { ok, error? }.
// Anything wrong → the caller writes NOTHING.
export function validateBackup(obj) {
  if (!isPlainObject(obj)) return { ok: false, error: "فایل بکاپ معتبر نیست (JSON خراب است)" };
  if (obj.kind !== BACKUP_KIND || obj.app !== BACKUP_APP) {
    return { ok: false, error: "این فایل، بکاپ این فروشگاه نیست" };
  }
  if (!(Number(obj.version) >= 1) || Number(obj.version) > BACKUP_VERSION) {
    return { ok: false, error: `نسخه بکاپ (${obj.version}) توسط این نسخه از ربات پشتیبانی نمی‌شود` };
  }
  const d = obj.data;
  if (!isPlainObject(d)) return { ok: false, error: "بخش داده‌های بکاپ وجود ندارد" };
  for (const k of ["config", "pkgs", "records"]) {
    if (!(k in d)) return { ok: false, error: `بخش «${k}» در بکاپ وجود ندارد` };
  }
  if (d.config !== null && !isPlainObject(d.config)) return { ok: false, error: "بخش تنظیمات بکاپ نامعتبر است" };
  if (d.pkgs !== null && !Array.isArray(d.pkgs)) return { ok: false, error: "بخش «pkgs» در بکاپ نامعتبر است" };
  if (!isPlainObject(d.records)) return { ok: false, error: "بخش رکوردهای بکاپ نامعتبر است" };
  const entries = Object.entries(d.records);
  if (entries.length > 20000) return { ok: false, error: "بکاپ بیش از حد بزرگ است" };
  for (const [key, value] of entries) {
    if (!RECORD_PREFIXES.some((p) => key.startsWith(p)) || !isPlainObject(value)) {
      return { ok: false, error: `رکورد نامعتبر در بکاپ: ${key}` };
    }
    // The key must agree with the record's own identity so a hand-edited
    // file can't smuggle a record under a different key.
    if (key.startsWith("user:") && String(value.id) !== key.slice(5)) return { ok: false, error: `رکورد کاربر ناسازگار: ${key}` };
    if (key.startsWith("act:") && String(value.id) !== key.slice(4)) return { ok: false, error: `رکورد سفارش ناسازگار: ${key}` };
    if (key.startsWith("coupon:") && String(value.code || "").toUpperCase() !== key.slice(7)) return { ok: false, error: `رکورد کوپن ناسازگار: ${key}` };
  }
  return { ok: true };
}

// Applies a validated backup: each covered keyspace is REPLACED (existing
// keys deleted first, then the backup's records written back under their
// original keys). Payment sessions, web sessions, locks and caches are
// never touched.
export async function applyRestore(env, backup) {
  const d = backup.data;
  const putSingleton = async (key, value) => {
    if (value === null || value === undefined) await kvDel(env, key);
    else await kvPut(env, key, value);
  };
  await putSingleton("config", d.config);
  await putSingleton("topup_pkgs", d.pkgs);
  for (const prefix of RECORD_PREFIXES) await kvDeletePrefix(env, prefix);
  for (const [key, value] of Object.entries(d.records)) {
    await kvPut(env, key, value);
  }
  return backupCounts(backup);
}
