/**
 * Google product reviews feed for weftrug.com (Merchant Center > Product ratings), Product Reviews XML
 * schema 2.4 (https://www.google.com/shopping/reviews/schema/product/2.4/product_reviews.xsd).
 *
 *   node build-feed.mjs --out site/google-product-reviews.xml [--previous <url of the published feed>]
 *
 * Run every day by .github/workflows/feed.yml, which publishes the file on GitHub Pages; Merchant Center
 * fetches it from there. Google replaces the whole feed with each file and removes the reviews a new file
 * leaves out, so with --previous the run stops (exit 1, nothing published) when the new file would drop
 * more than MAX_MISSING of the published reviews or has none at all: the store answering badly must not
 * wipe the reviews on Google. FORCE=1 publishes anyway (a review really deleted in Zid).
 *
 * Only the reviews written in Zid go in: the 3,136 earlier ones were bulk-imported from the Shopify store
 * on 2026-10-15 and 2026-10-18. They carry the import time as their date (Google wants the time the review
 * was written), and Yotpo, the Shopify review app, may already send them to Google (a review may reach
 * Google only once). So a review counts from SINCE on. Reviews without text are left out (Google needs the
 * content), and a customer's word-for-word repeat on the same rug (one review per size of one order) goes
 * in once, the earliest.
 *
 * Reads only public storefront URLs of the store, one request at a time. The store gives created_at in UTC.
 */
import fs from "node:fs";
import path from "node:path";

const STORE = (process.env.WEFT_FEED_STORE || "https://weftrug.com").replace(/\/+$/, "");
const SINCE = process.env.WEFT_FEED_SINCE || "2026-10-19T00:00:00Z";
const PUBLISHER = "WEFT";
const MAX_MISSING = 5;
const WAITS = [1000, 2000, 4000, 8000, 16000];

const args = process.argv.slice(2);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : "");
const OUT = path.resolve(option("--out") || "site/google-product-reviews.xml");
const PREVIOUS = option("--previous");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the store's text, as the theme publishes it (copied from the theme's src/js/utils/reviews-data.js)

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeOnce(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, decimal, hexa, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : match;
    const code = decimal ? parseInt(decimal, 10) : parseInt(hexa, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

/** HTML entities as characters, again until the text stops changing (the store encodes some twice) */
function decodeEntities(text, passes = 3) {
  let value = String(text == null ? "" : text);
  for (let n = 0; n < passes; n += 1) {
    const next = decodeOnce(value);
    if (next === value) break;
    value = next;
  }
  return value;
}

/** A reviewer's name as it may be published: never an e-mail address or a phone number */
function publicName(name) {
  const value = decodeEntities(name).trim();
  if (!value) return null;
  if (value.includes("@") || /\p{Nd}{7,}/u.test(value.replace(/[\s‐-―-]/gu, ""))) return null;
  return value;
}

// the Slack-style emoji codes the store keeps in review text (":+1::skin-tone-2:"); other ":word:" stay
const EMOJI = {
  "+1": "👍", heart: "❤️", hearts: "♥️", heart_eyes: "😍", ok_hand: "👌", fire: "🔥", star: "⭐", clap: "👏",
  rose: "🌹", sparkles: "✨", heart_eyes_cat: "😻", two_hearts: "💕", grinning_face_with_star_eyes: "🤩", sob: "😭",
  yum: "😋", purple_heart: "💜", cupid: "💘", 100: "💯", hibiscus: "🌺", pray: "🙏", cry: "😢", heartpulse: "💗",
  speak_no_evil: "🙊", dancer: "💃", joy: "😂", slightly_smiling: "🙂", slightly_smiling_face: "🙂",
  left_right_arrow: "↔️", dizzy: "💫", blue_heart: "💙", satisfied: "😆", relaxed: "☺️", seedling: "🌱", herb: "🌿"
};
const TONE_TAKERS = ["+1", "ok_hand", "clap", "pray", "dancer"];
const TONES = {
  "skin-tone-2": "\u{1F3FB}",
  "skin-tone-3": "\u{1F3FC}",
  "skin-tone-4": "\u{1F3FD}",
  "skin-tone-5": "\u{1F3FE}",
  "skin-tone-6": "\u{1F3FF}"
};
const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key);
const VS16 = String.fromCodePoint(0xfe0f);

function emojiFromShortcodes(text) {
  const source = String(text == null ? "" : text);
  const code = /:([a-z0-9_+-]+):/g;
  let out = "";
  let last = 0;
  let toneAt = -1;
  let match;
  while ((match = code.exec(source))) {
    const name = match[1];
    const start = match.index;
    let end = start + match[0].length;
    if (own(TONES, name)) {
      out += source.slice(last, start);
      if (start === toneAt) out += TONES[name];
      else if ((out === "" || /\s$/.test(out)) && /^\s/.test(source.slice(end))) end += 1;
      toneAt = -1;
      last = end;
      code.lastIndex = end;
    } else if (own(EMOJI, name)) {
      const emoji = EMOJI[name];
      if (emoji.endsWith(VS16) && source.startsWith(VS16, end)) end += 1;
      out += source.slice(last, start) + emoji;
      last = end;
      code.lastIndex = end;
      toneAt = TONE_TAKERS.includes(name) ? end : -1;
    } else {
      code.lastIndex = start + 1;
    }
  }
  return out + source.slice(last);
}

// ---- reading the store

/** One JSON answer; 429 / 5xx and network errors are retried with a growing wait */
async function json(url) {
  for (let attempt = 0; ; attempt++) {
    let why;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", cookie: "locale=ar-sa", "user-agent": "Mozilla/5.0 (WEFT reviews feed)" },
        signal: AbortSignal.timeout(90000)
      });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) throw Object.assign(new Error(response.status + " " + url), { fatal: true });
      why = String(response.status);
    } catch (error) {
      if (error.fatal) throw error;
      why = (error.cause && (error.cause.code || error.cause.message)) || error.message;
    }
    if (attempt >= WAITS.length) throw new Error(why + " " + url);
    await sleep(WAITS[attempt]);
  }
}

/** The rugs on sale that have reviews */
async function reviewedRugs() {
  const rugs = [];
  for (let page = 1; page <= 50; page++) {
    const list = await json(`${STORE}/api/v1/products?page_size=100&page=${page}`);
    const results = list.results || [];
    for (const p of results) if (Number((p.rating || {}).total_count) > 0) rugs.push({ id: String(p.id), slug: String(p.slug || "") });
    if (results.length < 100 || (list.pages_count && page >= list.pages_count)) break;
  }
  return rugs;
}

async function reviewsOf(id) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const data = await json(`${STORE}/api/v1/products/${id}/reviews?page_size=100&page=${page}`);
    const results = data.results || [];
    out.push(...results.filter((item) => !item.status || item.status === "approved"));
    if (results.length < 100 || (data.pages_count && page >= data.pages_count)) break;
  }
  return out;
}

/** "2026-11-05 14:52:57" (UTC) -> "2026-11-05T14:52:57Z" */
function utc(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}T${match[2]}Z` : "";
}

/** A 13-digit GTIN with a valid check digit (Zid keeps the barcode as free text) */
function isGtin13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits.slice(0, 12).reduce((total, d, i) => total + d * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** The rug's identifiers for matching: every size's GTIN and SKU, the rug's own SKU, name and address */
async function productOf(rug) {
  const data = await json(`${STORE}/api/v1/products/${rug.id}`);
  const p = data.payload || data;
  const variants = Array.isArray(p.variants) && p.variants.length ? p.variants : [p];
  const unique = (list) => [...new Set(list.map((v) => String(v || "").trim()).filter(Boolean))];
  return {
    gtins: unique(variants.map((v) => v.barcode)).filter(isGtin13),
    skus: unique([...variants.map((v) => v.sku), p.sku]),
    name: decodeEntities(p.name || "").trim(),
    url: `${STORE}/products/${rug.slug || p.slug}`
  };
}

// ---- the feed

/** Google asks for no full names: first name and the first letter of the last word ("Layan A.") */
function reviewerName(item) {
  if (item.is_anonymous) return null;
  const name = publicName(String((item.customer && item.customer.name) || ""));
  if (!name) return null;
  const words = name.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words.length) return null;
  return words.length > 1 ? `${words[0]} ${[...words[words.length - 1]][0]}.` : words[0];
}

/** The review text as published, without links, e-mail addresses or phone numbers */
function contentOf(item) {
  return emojiFromShortcodes(decodeEntities(String(item.comment || "")))
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/\S+@\S+\.\S+/g, "")
    .replace(/(?:\+|00)?\d[\d\s-]{7,}\d/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const xml = (text) =>
  String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function reviewXml(item, product, slug) {
  const name = reviewerName(item);
  const content = contentOf(item);
  const lines = [
    "    <review>",
    `      <review_id>${xml(item.id)}</review_id>`,
    "      <reviewer>",
    name ? `        <name>${xml(name)}</name>` : '        <name is_anonymous="true">Anonymous</name>',
    "      </reviewer>",
    `      <review_language>${/\p{Script=Arabic}/u.test(content) ? "ar" : "en"}</review_language>`,
    "      <review_country>SA</review_country>",
    `      <review_timestamp>${utc(item.created_at)}</review_timestamp>`,
    `      <content>${xml(content)}</content>`,
    `      <review_url type="group">${xml(`${STORE}/products/${slug}/reviews`)}</review_url>`,
    "      <ratings>",
    `        <overall min="1" max="5">${Math.round(Number(item.rating))}</overall>`,
    "      </ratings>",
    "      <products>",
    "        <product>",
    "          <product_ids>"
  ];
  if (product.gtins.length) lines.push("            <gtins>", ...product.gtins.map((g) => `              <gtin>${g}</gtin>`), "            </gtins>");
  if (product.skus.length) lines.push("            <skus>", ...product.skus.map((s) => `              <sku>${xml(s)}</sku>`), "            </skus>");
  lines.push(
    "          </product_ids>",
    `          <product_name>${xml(product.name)}</product_name>`,
    `          <product_url>${xml(product.url)}</product_url>`,
    "        </product>",
    "      </products>",
    "      <is_spam>false</is_spam>",
    `      <is_verified_purchase>${item.bought_this_item ? "true" : "false"}</is_verified_purchase>`,
    "    </review>"
  );
  return lines.join("\n");
}

/** The review ids of the feed published now; null when there is none yet (first run) */
async function publishedIds(url) {
  if (!url) return null;
  const response = await fetch(url + "?t=" + Date.now(), { signal: AbortSignal.timeout(60000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the published feed answered ${response.status}: ${url}`);
  return [...(await response.text()).matchAll(/<review_id>([^<]+)<\/review_id>/g)].map((m) => m[1]);
}

const since = Date.parse(SINCE);
const rugs = await reviewedRugs();
const entries = [];
const skipped = { imported: 0, noText: 0, badRating: 0, repeats: 0 };
for (const rug of rugs) {
  const kept = (await reviewsOf(rug.id)).filter((item) => {
    if (Date.parse(utc(item.created_at)) < since) return skipped.imported++, false;
    if (!contentOf(item)) return skipped.noText++, false;
    const rating = Math.round(Number(item.rating));
    if (!(rating >= 1 && rating <= 5)) return skipped.badRating++, false;
    return true;
  });
  // oldest first, so a repeat keeps its first copy
  kept.sort((a, b) => (utc(a.created_at) < utc(b.created_at) ? -1 : 1));
  const seen = new Set();
  const once = kept.filter((item) => {
    const key = `${(item.customer && item.customer.id) || item.id}|${contentOf(item).replace(/[\s\p{P}\p{S}]+/gu, "")}|${item.rating}`;
    if (seen.has(key)) return skipped.repeats++, false;
    seen.add(key);
    return true;
  });
  if (!once.length) continue;
  const product = await productOf(rug);
  for (const item of once) entries.push({ id: String(item.id), at: utc(item.created_at), body: reviewXml(item, product, rug.slug) });
}
entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

const rugsIn = new Set(entries.map((entry) => /<product_url>([^<]+)/.exec(entry.body)[1])).size;
console.log(`${entries.length} reviews on ${rugsIn} rugs (since ${SINCE}); left out: ${skipped.imported} older (imported), ${skipped.repeats} repeats, ${skipped.noText} without text, ${skipped.badRating} without a 1-5 rating`);

const before = await publishedIds(PREVIOUS);
const now = new Set(entries.map((entry) => entry.id));
const missing = before ? before.filter((id) => !now.has(id)) : [];
if (missing.length) console.log(`${missing.length} published review(s) not in the new file: ${missing.join(", ")}`);
if (!entries.length || missing.length > MAX_MISSING) {
  if (process.env.FORCE === "1") console.log("FORCE=1: published anyway");
  else {
    console.error(`stopped: the new file has ${entries.length} reviews and drops ${missing.length} of the published ones (limit ${MAX_MISSING}); the published feed stays as it is. Run the workflow with "force" if the reviews were really deleted.`);
    process.exit(1);
  }
}

const feed = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.4/product_reviews.xsd">',
  "  <version>2.4</version>",
  "  <publisher>",
  `    <name>${PUBLISHER}</name>`,
  "  </publisher>",
  "  <reviews>",
  ...entries.map((entry) => entry.body),
  "  </reviews>",
  "</feed>",
  ""
].join("\n");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, feed);
const status = { built: new Date().toISOString(), reviews: entries.length, rugs: rugsIn, newest: entries.length ? entries[0].at : null, dropped: missing };
fs.writeFileSync(path.join(path.dirname(OUT), "status.json"), JSON.stringify(status, null, 2) + "\n");
console.log(`written ${OUT}`);
