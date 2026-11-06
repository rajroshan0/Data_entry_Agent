import { KINDS, normalizeKind, normalizeEmail, normalizeCountry } from './rules.js';
import { countryFromPhone, countryFromHost } from './geo.js';
import { classifyKind } from './classify.js';

// -------------------------------------------------------------------------------------------
// Step 1: plain code finds every email and phone number that is really on the pages.
// The AI may only choose from these, so it can never invent a contact detail.
// -------------------------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Digit groups joined by ONE separator (space, dot, hyphen), so "779090. 12 High Street" stops after 779090.
const PHONE_RE =
  /(?:\+|\b00)?\(?\d{1,4}\)?(?:[\s.\- ]\(?\d{1,6}\)?)+|\+?\d{8,15}/g;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|yourdomain|sentry|wixpress)\./i;

const digits = (s) => String(s).replace(/\D/g, '');
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function findCandidates(pages) {
  const emails = new Map(); // email -> count
  const phones = new Map(); // raw -> source weight
  const addEmail = (raw) => {
    const e = normalizeEmail(raw);
    if (e && !JUNK_EMAIL.test(e)) emails.set(e, (emails.get(e) ?? 0) + 1);
  };
  const addPhone = (raw, weight) => {
    const raw2 = String(raw).trim().replace(/^[\s:.\-]+|[\s:.\-]+$/g, '');
    const d = digits(raw2);
    if (d.length < 8 || d.length > 15) return;
    if (/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(raw2)) return; // year ranges
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(raw2)) return; // dates
    if (!phones.has(raw2)) phones.set(raw2, weight);
  };
  for (const p of pages) {
    p.mailtos.forEach(addEmail);
    (p.text.match(EMAIL_RE) ?? []).forEach(addEmail);
    p.tels.forEach((t) => addPhone(decodeURIComponent(t.replace(/^tel:/i, '')), 2));
    (p.text.match(PHONE_RE) ?? []).forEach((t) => addPhone(t, 1));
  }
  // Most trustworthy numbers first: tel: links, then international (+) format.
  const rank = (raw) => (phones.get(raw) === 2 ? 0 : 0) + (/^(\+|00)/.test(raw) ? 0 : 1);
  const sorted = [...phones.keys()].sort((a, b) => phones.get(b) - phones.get(a) || rank(a) - rank(b));
  return { emails: [...emails.keys()], phones: sorted };
}

// -------------------------------------------------------------------------------------------
// Step 2: the AI reads the page text and answers in JSON.
// -------------------------------------------------------------------------------------------
export const SYSTEM = `You extract business facts from website text for a data-entry team.
Rules:
- Use ONLY the text provided. Never use outside knowledge. Never guess.
- If a fact is not written in the text, return null (false for booleans). Do not invent anything.
- Quotes ("...Evidence" fields) must be copied exactly from the text, word for word.

KIND OF BUSINESS. "kind" must be exactly one of: ${KINDS.join(' | ')}.
Decide in this order and stop at the first rule that fits:
 1. Restricted Site = adult / porn / escort, gambling / casino / betting, or clearly illegal content.
 2. Online Shopping = an online store that sells to the public: "add to cart", "checkout", "buy now", shopping basket, prices with order buttons.
 3. Manufacturer = the company itself makes the goods: "we manufacture", "manufacturer of", "we produce", "our factory", "our plant", "production facility", "OEM", "made in our workshop". Beats every rule below, even if it also exports.
 4. Wholesaler = sells goods in bulk: "wholesale", "wholesaler", "bulk supply", "bulk orders".
 5. Distributer = distributes or resells other brands: "distributor", "authorised/authorized dealer", "sole agent", "dealer of".
 6. Exporter = "exporter", "we export", "export house", "export to ... countries".
 7. Trader = "trading company", "traders", "trading of", buys and sells goods.
 8. Supplier = "supplier of", "we supply", "suppliers" of goods (also use it when it clearly sells goods but none of 4-7 fits).
    Between 4-8 use the word the site itself uses most.
 9. Industrial Services = industrial or technical services for businesses: engineering, fabrication / machining job work, installation, maintenance, repair, construction contracting, testing, calibration, EPC, industrial cleaning.
10. Service Provider = every other service: education, universities, schools, training, consulting, recruitment, health, legal, finance, software / IT, marketing, travel, tourism, real estate, events, NGOs, hotels, restaurants.
11. Other = personal blogs, portfolios, hobby or fan sites, news, forums, or when the purpose is unclear.
Look at what the company DOES and SELLS, not at the website design. Services are not products: a firm that
sells services is a Service Provider or Industrial Services, never a Supplier.
"kindEvidence" = the exact words from the text that made you choose (for Other: why).

CONTACT. Choose "email" and "phone" ONLY from EMAIL_CANDIDATES / PHONE_CANDIDATES. Prefer the main business
contact (the one on the Contact page or in the footer) over personal, support or press ones. Prefer the number
written with a country code.

COUNTRY. The country where the business is based. Look at, in this order: the postal address (country name, or a
city / state you can place), the phone country code (+44, +64, +91 ...), then wording like "Made in" or "serving ... only".
Put the country name in "country" and the words that show it in "countryEvidence" (an address line or the phone number as written).

PRODUCTS. "products" are real product names written on the pages (not services), at most 3. More go in "additionalProducts".
Return ONLY one JSON object, no other text.`;

const SCHEMA = `{
  "kind": "<one of the kinds>",
  "kindEvidence": "<short exact quote or reason>",
  "confidence": "high" | "medium" | "low",
  "email": "<one of EMAIL_CANDIDATES, the official business email, or null>",
  "phone": "<one of PHONE_CANDIDATES, the official business number, or null>",
  "country": "<country of the business or null>",
  "countryEvidence": "<exact quote from the text that shows the country, or null>",
  "address": "<exact street address text as written, or null>",
  "city": "<city or null>",
  "state": "<state / province / region or null>",
  "hasCompanyProfile": true | false,
  "products": [ { "name": "<exact product name>", "hasDescription": true | false, "descriptionEvidence": "<exact quote of at least 25 characters describing it, or null>" } ],
  "additionalProducts": [ "<product name>" ]
}`;

// maxChars caps the page text sent to the AI (free tiers have small limits). The budget is shared
// between the pages, and contact pages are listed first because they matter most.
export function buildPrompt(visit, cands, maxChars = 60000) {
  const ordered = [...visit.pages].sort((a, b) => {
    const rank = (p) => (/contact/i.test(p.url) ? 0 : /about/i.test(p.url) ? 1 : p === visit.pages[0] ? 2 : 3);
    return rank(a) - rank(b);
  });
  const perPage = Math.max(1500, Math.floor(maxChars / Math.max(1, ordered.length)));
  const parts = [
    `WEBSITE: ${visit.inputUrl}${visit.finalUrl !== visit.inputUrl ? ` (final URL: ${visit.finalUrl})` : ''}`,
    `EMAIL_CANDIDATES: ${JSON.stringify(cands.emails)}`,
    `PHONE_CANDIDATES: ${JSON.stringify(cands.phones)}`,
    '',
    `Return JSON in this shape:\n${SCHEMA}`,
    '',
  ];
  for (const p of ordered) {
    parts.push(`=== PAGE: ${p.url} (title: ${p.title}) ===`);
    parts.push((p.text || '(no text)').slice(0, perPage));
    const imgs = p.imgs.filter((i) => i.alt || i.src).slice(0, 15);
    if (imgs.length) parts.push('IMAGES: ' + imgs.map((i) => `${i.alt || '-'} | ${i.src}`).join('; '));
    parts.push('');
  }
  return parts.join('\n');
}

export function parseJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI did not return JSON');
  return JSON.parse(s.slice(start, end + 1));
}

// -------------------------------------------------------------------------------------------
// Step 3: check every AI answer against the real page text. Anything that cannot be found
// on the pages is dropped and flagged, so a person looks at it.
// -------------------------------------------------------------------------------------------
// An image counts for a product when most words of the product name appear in ONE image's
// alt text / file name. (One shared generic word like "valve" is not enough.)
function imageMatch(name, pages) {
  const tokens = norm(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const need = Math.max(1, Math.ceil(tokens.length * 0.6));
  return pages.some((p) =>
    p.imgs.some((i) => {
      const hay = norm(`${i.alt} ${i.src}`);
      return tokens.filter((t) => hay.includes(t)).length >= need;
    }),
  );
}

export function validate(raw, visit, cands) {
  const flags = [];
  const pages = visit.pages;
  const allText = norm(pages.map((p) => p.text).join('\n'));
  const found = (quote) => !!quote && allText.includes(norm(quote));

  const out = {
    kind: normalizeKind(raw.kind),
    kindEvidence: raw.kindEvidence ?? '',
    confidence: raw.confidence ?? 'medium',
    email: '',
    phone: '',
    country: '',
    addressFound: false,
    cityFound: false,
    stateFound: false,
    hasCompanyProfile: false,
    products: [],
    additionalProducts: [],
    city: '',
    state: '',
    address: '',
  };

  if (out.confidence === 'low') flags.push('ai-low-confidence');
  if (!out.kind) flags.push('kind-not-recognised');
  else if (raw.kindEvidence && !found(raw.kindEvidence) && out.confidence !== 'high') flags.push('kind-evidence-unverified');

  // Email: must be one found on the pages
  const siteHost = visit.finalUrl.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
  const wantEmail = normalizeEmail(raw.email);
  if (wantEmail && cands.emails.includes(wantEmail)) out.email = wantEmail;
  else {
    if (wantEmail) flags.push('email-not-on-page');
    const sameDomain = cands.emails.find((e) => siteHost.endsWith(e.split('@')[1]) || e.split('@')[1].endsWith(siteHost));
    out.email = sameDomain ?? cands.emails[0] ?? '';
  }

  // Phone: digits must match a number found on the pages
  const wantPhone = digits(raw.phone ?? '');
  const hit = wantPhone && cands.phones.find((c) => digits(c) === wantPhone);
  if (hit) out.phone = hit;
  else {
    if (wantPhone) flags.push('phone-not-on-page');
    out.phone = cands.phones[0] ?? '';
  }

  // Country: from a quote on the page, else from the phone's country code or the domain ending.
  const phoneLong = countryFromPhone(out.phone);
  const hostLong = countryFromHost(siteHost);
  const phoneCountry = normalizeCountry(phoneLong);
  const hostCountry = normalizeCountry(hostLong);
  const aiCountry = normalizeCountry(raw.country);
  if (aiCountry && (found(raw.countryEvidence) || aiCountry === phoneCountry || aiCountry === hostCountry)) {
    out.country = String(raw.country).trim();
    out.countrySource = found(raw.countryEvidence) ? 'page text' : aiCountry === phoneCountry ? 'phone code' : 'domain';
  } else {
    if (aiCountry) flags.push('country-unverified');
    const inferred = phoneCountry || hostCountry;
    if (inferred) {
      out.country = phoneCountry ? phoneLong : hostLong;
      out.countrySource = phoneCountry ? 'phone code' : 'domain';
      if (aiCountry && aiCountry !== inferred) flags.push('country-mismatch');
    }
  }
  if (out.country && phoneCountry && normalizeCountry(out.country) !== phoneCountry && !flags.includes('country-mismatch')) {
    flags.push('country-differs-from-phone-code');
  }

  // Address / city / state: only Y when the text is on the pages
  if (raw.address && found(raw.address)) {
    out.addressFound = true;
    out.address = raw.address;
  }
  if (raw.city && found(raw.city)) {
    out.cityFound = true;
    out.city = raw.city;
  }
  if (raw.state && found(raw.state)) {
    out.stateFound = true;
    out.state = raw.state;
  }

  // Company profile: AI says yes, or an About/Company page was really opened and has content
  out.hasCompanyProfile =
    !!raw.hasCompanyProfile ||
    pages.some((p) => /about|company|profile/i.test(new URL(p.url).pathname) && p.text.length > 200);

  // Products: the name must appear on the pages, otherwise it is dropped
  for (const p of raw.products ?? []) {
    if (!p?.name) continue;
    if (!found(p.name)) {
      flags.push(`product-not-on-page:${String(p.name).slice(0, 40)}`);
      continue;
    }
    if (out.products.length >= 3) {
      out.additionalProducts.push(p.name);
      continue;
    }
    out.products.push({
      name: String(p.name).trim(),
      hasImage: imageMatch(p.name, pages),
      hasDescription: found(p.descriptionEvidence) && norm(p.descriptionEvidence).length >= 25,
    });
  }
  for (const name of raw.additionalProducts ?? []) {
    if (found(name) && !out.additionalProducts.includes(name)) out.additionalProducts.push(name);
  }

  // A working-type company with no way to contact it deserves a human look
  const workingKind = !['Service Provider', 'Online Shopping', 'Restricted Site', 'Other'].includes(out.kind);
  if (workingKind) {
    if (!out.email && !out.phone) flags.push('no-contact-info');
    if (!out.country) flags.push('no-country');
  }
  return { extraction: out, flags };
}

// No AI answer (no key, error, bad reply): keyword rules still pick the kind, and the phone code /
// domain give the country. The person checks it (flag), because keywords are less exact than the AI.
function noAiExtraction(cands, visit) {
  const guess = classifyKind(visit.pages);
  const host = visit.finalUrl.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
  const phone = cands.phones[0] ?? '';
  return {
    extraction: {
      kind: guess.kind,
      kindEvidence: guess.evidence,
      email: cands.emails[0] ?? '',
      phone,
      country: countryFromPhone(phone) || countryFromHost(host) || '',
      hasCompanyProfile: visit.pages.some((p) => /about|company|profile/i.test(new URL(p.url).pathname) && p.text.length > 200),
      products: [],
      additionalProducts: [],
    },
    flags: ['kind-guessed-by-keywords'],
  };
}

export async function runExtraction({ visit, llm, maxChars }) {
  const cands = findCandidates(visit.pages);
  if (!llm) return { ...noAiExtraction(cands, visit), flags: ['no-ai-key', 'kind-guessed-by-keywords'], cands, raw: null };
  let reply;
  try {
    reply = await llm(SYSTEM, buildPrompt(visit, cands, maxChars));
  } catch (e) {
    // The AI service failed (rate limit, bad key...). Do not crash and do not guess: leave it for the person.
    return { ...noAiExtraction(cands, visit), flags: ['ai-error', 'kind-guessed-by-keywords'], cands, raw: null, aiError: e.message };
  }
  let raw;
  try {
    raw = parseJson(reply);
  } catch (e) {
    return { ...noAiExtraction(cands, visit), flags: ['ai-bad-json', 'kind-guessed-by-keywords'], cands, raw: reply };
  }
  const { extraction, flags } = validate(raw, visit, cands);
  // Gambling / adult spam hidden inside an ordinary-looking site: the keyword check wins.
  const guess = classifyKind(visit.pages);
  if (guess.kind === 'Restricted Site' && guess.strong && extraction.kind !== 'Restricted Site') {
    flags.push(`kind-changed-to-restricted (AI said ${extraction.kind || 'nothing'}; page mentions: ${guess.evidence})`);
    extraction.kind = 'Restricted Site';
    extraction.kindEvidence = guess.evidence;
  }
  return { extraction, flags, cands, raw };
}
