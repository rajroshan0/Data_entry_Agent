// Works out a country from facts that are really on the page: the phone's country code and the
// domain ending (.co.uk, .nz ...). Used when the page does not spell the country out.

// International dialling codes (longest match wins). +1 is shared (USA/Canada) so it is not guessed.
const PHONE_CODES = {
  44: 'United Kingdom', 91: 'India', 61: 'Australia', 64: 'New Zealand', 971: 'United Arab Emirates',
  92: 'Pakistan', 977: 'Nepal', 880: 'Bangladesh', 94: 'Sri Lanka', 49: 'Germany', 33: 'France',
  39: 'Italy', 34: 'Spain', 31: 'Netherlands', 32: 'Belgium', 41: 'Switzerland', 43: 'Austria',
  46: 'Sweden', 47: 'Norway', 45: 'Denmark', 358: 'Finland', 353: 'Ireland', 351: 'Portugal',
  30: 'Greece', 48: 'Poland', 420: 'Czech Republic', 36: 'Hungary', 40: 'Romania', 7: 'Russia',
  90: 'Turkey', 20: 'Egypt', 27: 'South Africa', 234: 'Nigeria', 254: 'Kenya', 966: 'Saudi Arabia',
  974: 'Qatar', 965: 'Kuwait', 968: 'Oman', 973: 'Bahrain', 972: 'Israel', 98: 'Iran', 86: 'China',
  852: 'Hong Kong', 81: 'Japan', 82: 'South Korea', 65: 'Singapore', 60: 'Malaysia', 66: 'Thailand',
  62: 'Indonesia', 63: 'Philippines', 84: 'Vietnam', 55: 'Brazil', 54: 'Argentina', 56: 'Chile',
  52: 'Mexico', 57: 'Colombia', 51: 'Peru', 380: 'Ukraine', 375: 'Belarus', 994: 'Azerbaijan',
};

// Country-code domain endings. Generic ones (.com .org .net ...) say nothing and are not listed.
const TLDS = {
  uk: 'United Kingdom', nz: 'New Zealand', au: 'Australia', in: 'India', ca: 'Canada', de: 'Germany',
  fr: 'France', it: 'Italy', es: 'Spain', nl: 'Netherlands', be: 'Belgium', ch: 'Switzerland',
  at: 'Austria', se: 'Sweden', no: 'Norway', dk: 'Denmark', fi: 'Finland', ie: 'Ireland',
  pt: 'Portugal', gr: 'Greece', pl: 'Poland', cz: 'Czech Republic', hu: 'Hungary', ro: 'Romania',
  ru: 'Russia', tr: 'Turkey', eg: 'Egypt', za: 'South Africa', ng: 'Nigeria', ke: 'Kenya',
  ae: 'United Arab Emirates', sa: 'Saudi Arabia', qa: 'Qatar', kw: 'Kuwait', om: 'Oman',
  bh: 'Bahrain', il: 'Israel', pk: 'Pakistan', np: 'Nepal', bd: 'Bangladesh', lk: 'Sri Lanka',
  cn: 'China', hk: 'Hong Kong', jp: 'Japan', kr: 'South Korea', sg: 'Singapore', my: 'Malaysia',
  th: 'Thailand', id: 'Indonesia', ph: 'Philippines', vn: 'Vietnam', br: 'Brazil', ar: 'Argentina',
  cl: 'Chile', mx: 'Mexico', co: null, us: 'United States', ua: 'Ukraine', by: 'Belarus',
};

export function countryFromPhone(phone) {
  const s = String(phone ?? '').trim();
  const m = s.match(/^(?:\+|00)\s*\(?(\d[\d\s().-]*)/);
  if (!m) return '';
  const d = m[1].replace(/\D/g, '');
  for (const len of [3, 2, 1]) {
    const c = PHONE_CODES[d.slice(0, len)];
    if (c) return c;
  }
  return '';
}

export function countryFromHost(host) {
  const parts = String(host ?? '').toLowerCase().split('.');
  const tld = parts[parts.length - 1];
  // .co.uk / .com.au / .ac.nz: the last part is the country
  return TLDS[tld] ?? '';
}
