// Your data-entry rules, in one place. No AI is involved here.

// Labels exactly as the portal spells them (including "Distributer").
export const KINDS = [
  'Manufacturer',
  'Industrial Services',
  'Exporter',
  'Trader',
  'Distributer',
  'Supplier',
  'Wholesaler',
  'Service Provider',
  'Online Shopping',
  'Restricted Site',
  'Other',
];

// Kinds that mean "Working". Every other kind means "Not Working".
const WORKING_KINDS = new Set([
  'Manufacturer',
  'Industrial Services',
  'Exporter',
  'Trader',
  'Distributer',
  'Supplier',
  'Wholesaler',
]);

export const SITE_STATUSES = [
  'Working',
  'Not Working',
  'Domain Expired',
  'Non English',
  'Under Construction',
  'Flash Site',
  'Redirect Site',
];

export function statusForKind(kind) {
  return WORKING_KINDS.has(kind) ? 'Working' : 'Not Working';
}

const KIND_ALIASES = new Map([
  ['distributor', 'Distributer'],
  ['distributers', 'Distributer'],
  ['distributors', 'Distributer'],
  ['industrial service', 'Industrial Services'],
  ['restricted sites', 'Restricted Site'],
  ['restricted', 'Restricted Site'],
  ['restricted / blocked', 'Restricted Site'],
  ['online shop', 'Online Shopping'],
  ['online store', 'Online Shopping'],
  ['manufacturers', 'Manufacturer'],
  ['exporters', 'Exporter'],
  ['traders', 'Trader'],
  ['suppliers', 'Supplier'],
  ['wholesalers', 'Wholesaler'],
  ['service', 'Service Provider'],
  ['services', 'Service Provider'],
]);

export function normalizeKind(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const exact = KINDS.find((k) => k.toLowerCase() === s);
  if (exact) return exact;
  return KIND_ALIASES.get(s) ?? 'Other';
}

// United States -> USA, United Kingdom -> UK. Anything else is kept as written.
const COUNTRY_MAP = new Map([
  ['united states', 'USA'],
  ['united states of america', 'USA'],
  ['usa', 'USA'],
  ['us', 'USA'],
  ['america', 'USA'],
  ['united kingdom', 'UK'],
  ['uk', 'UK'],
  ['great britain', 'UK'],
  ['gb', 'UK'],
  ['england', 'UK'],
  ['scotland', 'UK'],
  ['wales', 'UK'],
  ['northern ireland', 'UK'],
]);

export function normalizeCountry(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s || /^not available$/i.test(s)) return '';
  const key = s.toLowerCase().replace(/\./g, '').trim(); // "U.S.A." -> "usa"
  return COUNTRY_MAP.get(key) ?? s;
}

// Remove spaces so the number stays together: "+44 1554 779090" -> "+441554779090".
// With stripPunctuation also keeps only + and digits.
export function normalizePhone(raw, { stripPunctuation = false } = {}) {
  let s = String(raw ?? '').replace(/^\s*tel:/i, '').trim();
  s = s.replace(/[\s   ]+/g, '');
  if (stripPunctuation) s = s.replace(/[^\d+]/g, '');
  return s;
}

export function normalizeEmail(raw) {
  let s = String(raw ?? '').trim().replace(/^mailto:/i, '');
  s = s.split('?')[0].trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? s : '';
}

const yn = (b) => (b ? 'Y' : 'N');

// Entry for sites with no data to enter: status + kind, everything else empty / N / 0.
function emptyEntry(url, status, kind) {
  return {
    url,
    status,
    kind,
    email: '',
    phone: '',
    country: '',
    address: 'N',
    city: 'N',
    state: 'N',
    companyProfile: 'N',
    nameOfProd: '0',
    imageOfProd: '0',
    descOfProd: '0',
  };
}

/**
 * Turns what we learned about a site into the values for the portal form.
 *  site:       { status }  status is 'Working' or one of the other site statuses
 *  extraction: result of the extractor (only used when the site is Working)
 */
export function buildEntry({ url, site, extraction, options = {} }) {
  // Site itself is not "Working" (dead, parked, expired, under construction...)
  if (site.status !== 'Working') return emptyEntry(url, site.status, 'Other');

  // No extraction (no AI key): leave Kind/Status for the person to choose.
  if (!extraction || !extraction.kind) {
    const e = emptyEntry(url, '', '');
    e.email = extraction?.email ?? '';
    e.phone = extraction?.phone ? normalizePhone(extraction.phone, options) : '';
    return e;
  }

  const kind = normalizeKind(extraction.kind);
  const status = statusForKind(kind);

  // Kinds in the "Not Working" group (Service Provider, Online Shopping, Restricted Site, Other):
  // status is Not Working, but the contact details that really are on the site are still entered.
  // Products stay 0, because these sites are not product sellers.
  const notWorking = status === 'Not Working';
  const products = (extraction.products ?? []).slice(0, 3);
  return {
    url,
    status,
    kind,
    email: normalizeEmail(extraction.email),
    phone: normalizePhone(extraction.phone, options),
    country: normalizeCountry(extraction.country),
    address: yn(extraction.addressFound),
    city: yn(extraction.cityFound),
    state: yn(extraction.stateFound),
    companyProfile: yn(extraction.hasCompanyProfile),
    nameOfProd: notWorking ? '0' : String(products.length),
    imageOfProd: notWorking ? '0' : String(products.filter((p) => p.hasImage).length),
    descOfProd: notWorking ? '0' : String(products.filter((p) => p.hasDescription).length),
  };
}
