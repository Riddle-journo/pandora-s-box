// Anti-abuse safeguards for the anonymous tip channel.
//
// Threat model: (a) bot floods / astroturfing to smear or whitewash a
// politician, (b) attempts to deanonymize tipsters, (c) injection of
// defamatory content that publishes automatically.
//
// Defenses:
//   1. Proof-of-work: client must burn CPU per tip (browser SHA-256 search).
//      Raises the cost of flooding without identifying anyone.
//   2. In-memory IP rate limit: throttles bursts. IPs live ONLY in RAM with a
//      short TTL and are never written to the store or logs (see store.js —
//      tips persist only an ISO-week bucket).
//   3. Content rules: length caps, honeypot field, PII/doxxing pattern strip.
//   4. Human-in-the-loop: tips land in a moderation queue; nothing publishes
//      automatically, and a tip only influences a report after a moderator
//      marks it corroborated by a verifiable record.
import crypto from "node:crypto";

const DIFFICULTY_BITS = Number(process.env.POW_DIFFICULTY_BITS || 18);

// ---- Proof of work ----
const challenges = new Map(); // challenge -> expiry epoch ms (single use)
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function issueChallenge() {
  const challenge = crypto.randomBytes(16).toString("hex");
  challenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
  // opportunistic cleanup
  for (const [c, exp] of challenges) if (exp < Date.now()) challenges.delete(c);
  return { challenge, difficulty_bits: DIFFICULTY_BITS };
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function verifyPow(challenge, nonce) {
  const exp = challenges.get(challenge);
  if (!exp || exp < Date.now()) return false;
  const hash = crypto.createHash("sha256").update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(hash) < DIFFICULTY_BITS) return false;
  challenges.delete(challenge); // single use
  return true;
}

// ---- Ephemeral IP rate limit (RAM only, never persisted) ----
const buckets = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 3;

export function rateLimitTip(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

// ---- Content rules ----
const PHONE_RE = /(\+?91[\s-]?)?[6-9]\d{9}/g; // Indian mobile numbers
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;

export function sanitizeTip(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < 30) return { error: "Tip too short — describe what happened, when, and where (min 30 chars)." };
  if (trimmed.length > 2000) return { error: "Tip too long (max 2000 chars)." };
  // Strip PII of third parties AND of the tipster (protects both)
  const cleaned = trimmed
    .replace(PHONE_RE, "[phone removed]")
    .replace(AADHAAR_RE, "[id removed]")
    .replace(EMAIL_RE, "[email removed]");
  return { text: cleaned };
}

export const TIP_CATEGORIES = [
  "corruption",
  "favoritism",
  "broken_promise",
  "abuse_of_power",
  "misuse_of_funds",
  "good_work", // positive tips are equally welcome
  "other",
];
