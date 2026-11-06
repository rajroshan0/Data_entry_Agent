// Picks the Kind of Business from the page text with plain keyword rules (no AI needed).
// Used when the AI is unavailable or failed, and to catch gambling/adult spam the AI may miss.
// Same order of rules as the AI instructions. Returns { kind, evidence, strong } where evidence is
// the exact words found on the pages.

const RULES = [
  ['Restricted Site', /\b(casino|slots?(?:\s+online)?|sbobet|togel|judi\s+online|poker|sportsbook|sports\s+betting|online\s+betting|gambling|porn|xxx|escort|sex\s+cam)\b/gi],
  ['Online Shopping', /\b(add\s+to\s+(?:cart|basket|bag)|shopping\s+(?:cart|basket|bag)|checkout|buy\s+now)\b/gi],
  ['Manufacturer', /\b(we\s+(?:manufacture|produce|fabricate)|(?:leading\s+)?manufacturers?\s+(?:of|and)|manufacturing\s+(?:company|unit|facility)|our\s+(?:factory|plant|production\s+facility)|oem\s+manufactur\w+)\b/gi],
  ['Wholesaler', /\b(wholesalers?|wholesale\s+(?:supply|prices?|orders?|distribution)|bulk\s+(?:supply|orders?))\b/gi],
  ['Distributer', /\b(distributors?|authori[sz]ed\s+(?:dealers?|distributors?)|sole\s+agents?)\b/gi],
  ['Exporter', /\b(exporters?|we\s+export|export\s+house)\b/gi],
  ['Trader', /\b(trading\s+(?:company|co\b|house)|traders?)\b/gi],
  ['Supplier', /\b(suppliers?\s+of|we\s+supply|leading\s+suppliers?)\b/gi],
  ['Industrial Services', /\b((?:fabrication|installation|maintenance|repair|engineering|machining|calibration|construction|fitting|welding)\s+(?:services?|works?|contractors?)|contractors?|epc\b)/gi],
  ['Service Provider', /\b(universit(?:y|ies)|college|school|education|training|courses?|consult(?:ing|ancy|ants?)|recruit(?:ment|ing)|clinic|hospital|doctor|dentist|law\s+firm|lawyers?|attorneys?|software|web\s+design|marketing\s+agency|travel|tours?|hotels?|restaurant|real\s+estate|insurance|accounting|our\s+services|services)\b/gi],
];

function snippet(text, index, len) {
  return text.slice(Math.max(0, index - 20), index + len + 20).replace(/\s+/g, ' ').trim();
}

export function classifyKind(pages) {
  const text = pages.map((p) => `${p.title ?? ''}\n${p.text ?? ''}`).join('\n');
  if (text.trim().length < 40) return { kind: 'Other', evidence: 'almost no text on the pages', strong: false };

  const hits = (re) => [...text.matchAll(new RegExp(re.source, re.flags))];

  // Restricted needs more than one mention, so a single word like "poker face" does not trigger it.
  const bad = hits(RULES[0][1]);
  if (bad.length >= 2) {
    return { kind: 'Restricted Site', evidence: snippet(text, bad[0].index, bad[0][0].length), strong: bad.length >= 3 };
  }
  for (const [kind, re] of RULES.slice(1)) {
    const m = hits(re);
    if (!m.length) continue;
    const needed = kind === 'Service Provider' || kind === 'Online Shopping' ? 1 : 1;
    if (m.length >= needed) return { kind, evidence: snippet(text, m[0].index, m[0][0].length), strong: false };
  }
  return { kind: 'Other', evidence: 'no business words found', strong: false };
}
