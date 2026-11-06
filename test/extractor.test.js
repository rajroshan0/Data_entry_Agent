import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM, findCandidates, parseJson, runExtraction, validate } from '../src/extractor.js';
import { countryFromPhone, countryFromHost } from '../src/geo.js';

const page = (over = {}) => ({
  url: 'http://acme.test/',
  title: 'Acme',
  text: '',
  links: [],
  mailtos: [],
  tels: [],
  imgs: [],
  ...over,
});

const visit = (pages) => ({ inputUrl: 'http://acme.test', finalUrl: 'http://acme.test/', pages });

const goodText =
  'Acme Valves Ltd is a manufacturer of industrial valves. Products: Ball Valve BV-100, Gate Valve GV-200. ' +
  'Contact: info@acme.test Tel +44 1554 779090. 12 High Street, Llanelli, Wales, United Kingdom. ' +
  'Ball Valve BV-100 is a high pressure stainless steel valve for oil and gas lines.';

test('findCandidates: finds emails and phones, ignores junk and dates', () => {
  const c = findCandidates([
    page({
      text: 'Mail info@acme.test or logo@2x.png. Call +44 1554 779090. Founded 2019-2024. Date 2024-05-01.',
      mailtos: ['mailto:Sales@Acme.test?subject=x'],
      tels: ['tel:+441554779090'],
    }),
  ]);
  assert.ok(c.emails.includes('info@acme.test'));
  assert.ok(c.emails.includes('sales@acme.test'));
  assert.ok(!c.emails.some((e) => e.endsWith('.png')));
  assert.ok(c.phones.some((p) => p.replace(/\D/g, '') === '441554779090'));
  assert.ok(!c.phones.some((p) => p.includes('2019')));
  assert.ok(!c.phones.some((p) => p.includes('2024-05')));
});

test('validate: drops invented email, phone, country and products', () => {
  const v = visit([page({ text: goodText })]);
  const cands = findCandidates(v.pages);
  const { extraction, flags } = validate(
    {
      kind: 'Manufacturer',
      confidence: 'high',
      email: 'made.up@nowhere.com',
      phone: '+1 555 000 1111',
      country: 'Germany',
      countryEvidence: 'Berlin, Germany',
      products: [{ name: 'Ball Valve BV-100' }, { name: 'Magic Widget' }],
    },
    v,
    cands,
  );
  assert.equal(extraction.country, 'United Kingdom'); // invented country dropped; the page's own +44 number decides
  assert.equal(extraction.products.length, 1);
  assert.equal(extraction.products[0].name, 'Ball Valve BV-100');
  // falls back to the real email on the page, and says so
  assert.equal(extraction.email, 'info@acme.test');
  assert.ok(flags.includes('email-not-on-page'));
  assert.ok(flags.includes('phone-not-on-page'));
  assert.ok(flags.includes('country-unverified'));
  assert.ok(flags.some((f) => f.startsWith('product-not-on-page')));
});

test('validate: a clean answer has no flags and keeps the evidence-backed values', () => {
  const v = visit([page({ text: goodText, imgs: [{ alt: 'Ball Valve', src: 'bv-100.jpg' }] })]);
  const cands = findCandidates(v.pages);
  const { extraction, flags } = validate(
    {
      kind: 'Manufacturer',
      confidence: 'high',
      email: 'info@acme.test',
      phone: '+44 1554 779090',
      country: 'United Kingdom',
      countryEvidence: 'Llanelli, Wales, United Kingdom',
      address: '12 High Street',
      city: 'Llanelli',
      state: 'Wales',
      products: [
        {
          name: 'Ball Valve BV-100',
          hasDescription: true,
          descriptionEvidence: 'a high pressure stainless steel valve for oil and gas lines',
        },
        { name: 'Gate Valve GV-200', hasDescription: false },
      ],
    },
    v,
    cands,
  );
  assert.deepEqual(flags, []);
  assert.equal(extraction.country, 'United Kingdom'); // rules.js turns this into UK later
  assert.equal(extraction.addressFound, true);
  assert.equal(extraction.cityFound, true);
  assert.equal(extraction.stateFound, true);
  assert.equal(extraction.products[0].hasImage, true);
  assert.equal(extraction.products[0].hasDescription, true);
  assert.equal(extraction.products[1].hasImage, false);
  assert.equal(extraction.products[1].hasDescription, false);
});

test('validate: working kind with no contact info is flagged for a person', () => {
  const v = visit([page({ text: 'We are a manufacturer of widgets.' })]);
  const { flags } = validate({ kind: 'Manufacturer', confidence: 'high' }, v, findCandidates(v.pages));
  assert.ok(flags.includes('no-contact-info'));
});

test('runExtraction: no AI key -> keyword rules pick the kind, flagged for a look', async () => {
  const v = visit([page({ text: goodText })]);
  const r = await runExtraction({ visit: v, llm: null });
  assert.equal(r.extraction.kind, 'Manufacturer');
  assert.equal(r.extraction.country, 'United Kingdom'); // from the +44 number
  assert.ok(r.flags.includes('no-ai-key'));
  assert.ok(r.flags.includes('kind-guessed-by-keywords'));
});

test('runExtraction: bad JSON from the AI is flagged, not trusted', async () => {
  const v = visit([page({ text: goodText })]);
  const r = await runExtraction({ visit: v, llm: async () => 'sorry, I cannot do that' });
  assert.equal(r.extraction.kind, 'Manufacturer'); // keyword fallback
  assert.ok(r.flags.includes('ai-bad-json'));
});

test('parseJson: tolerates text around the JSON', () => {
  assert.deepEqual(parseJson('Here you go: {"a":1} thanks'), { a: 1 });
});

// ---- country from phone code / domain, like a person would do it
const mkVisit = (url, text) => ({
  inputUrl: url, finalUrl: url,
  pages: [{ url, title: 't', text, mailtos: [], tels: [], imgs: [], links: [] }],
});

test('country: taken from the phone country code when the page does not name it', () => {
  const visit = mkVisit('http://www.opportunities.auckland.ac.nz/', 'Student services. Email studentinfo@auckland.ac.nz or call +64 9 373 7513 for help.');
  const cands = findCandidates(visit.pages);
  const { extraction } = validate({ kind: 'Service Provider', confidence: 'high', phone: '+64 9 373 7513', email: 'studentinfo@auckland.ac.nz', country: null }, visit, cands);
  assert.equal(extraction.country, 'New Zealand');
  assert.equal(extraction.phone, '+64 9 373 7513');
});

test('country: domain ending is used when there is no phone code; generic .com says nothing', () => {
  const uk = mkVisit('http://www.vira.co.uk/', 'We design bags. Call 01234 567890.');
  assert.equal(validate({ kind: 'Manufacturer', confidence: 'high', country: null }, uk, findCandidates(uk.pages)).extraction.country, 'United Kingdom');
  const com = mkVisit('http://www.acme.com/', 'We design bags. Call 01234 567890.');
  assert.equal(validate({ kind: 'Manufacturer', confidence: 'high', country: null }, com, findCandidates(com.pages)).extraction.country, '');
});

test('country: AI country that contradicts the phone code is flagged, the code wins', () => {
  const v = mkVisit('http://www.acme.com/', 'Call +91 98765 43210 today.');
  const { extraction, flags } = validate({ kind: 'Supplier', confidence: 'high', phone: '+91 98765 43210', country: 'Germany', countryEvidence: 'made up' }, v, findCandidates(v.pages));
  assert.equal(extraction.country, 'India');
  assert.ok(flags.includes('country-mismatch'));
});

test('geo: phone codes and domain endings', () => {
  assert.equal(countryFromPhone('+44 1554 779090'), 'United Kingdom');
  assert.equal(countryFromPhone('+971 4 123 4567'), 'United Arab Emirates');
  assert.equal(countryFromPhone('+1 312 555 0100'), ''); // shared code, not guessed
  assert.equal(countryFromPhone('0044 20 7946 0000'), 'United Kingdom');
  assert.equal(countryFromHost('www.example.co.uk'), 'United Kingdom');
  assert.equal(countryFromHost('example.com'), '');
});

test('phone candidates: tel links and +country-code numbers come first', () => {
  const pages = [{ url: 'http://a.test/', text: 'Fax 020 7946 0001. Reach us on +44 20 7946 0000', mailtos: [], tels: ['tel:+442079460000'], imgs: [], links: [] }];
  assert.match(findCandidates(pages).phones[0], /^\+44/);
});

test('prompt: tells the AI the kind rules and lists the 11 portal kinds', () => {
  assert.ok(SYSTEM.includes('Manufacturer') && SYSTEM.includes('Restricted Site'));
  assert.ok(SYSTEM.includes('phone country code'));
});
