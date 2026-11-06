import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCountry,
  normalizePhone,
  normalizeEmail,
  normalizeKind,
  statusForKind,
  buildEntry,
} from '../src/rules.js';

test('country: United States -> USA, United Kingdom -> UK', () => {
  assert.equal(normalizeCountry('United States'), 'USA');
  assert.equal(normalizeCountry('United States of America'), 'USA');
  assert.equal(normalizeCountry('U.S.A.'), 'USA');
  assert.equal(normalizeCountry('United Kingdom'), 'UK');
  assert.equal(normalizeCountry('united kingdom'), 'UK');
  assert.equal(normalizeCountry('U.K.'), 'UK');
  assert.equal(normalizeCountry('India'), 'India');
  assert.equal(normalizeCountry('Not Available'), '');
});

test('phone: spaces removed, nothing else changed by default', () => {
  assert.equal(normalizePhone('+44 1554 779090'), '+441554779090');
  assert.equal(normalizePhone('+60 3-5882 3566'), '+603-58823566');
  assert.equal(normalizePhone('tel:+1 708 865 1717'), '+17088651717');
  assert.equal(normalizePhone('+60 3-5882 3566', { stripPunctuation: true }), '+60358823566');
});

test('email: cleaned and validated', () => {
  assert.equal(normalizeEmail('mailto:Info@Example.com?subject=hi'), 'info@example.com');
  assert.equal(normalizeEmail('not an email'), '');
});

test('kind -> status table', () => {
  for (const k of ['Manufacturer', 'Industrial Services', 'Exporter', 'Trader', 'Distributer', 'Supplier', 'Wholesaler']) {
    assert.equal(statusForKind(k), 'Working', k);
  }
  for (const k of ['Service Provider', 'Online Shopping', 'Restricted Site', 'Other']) {
    assert.equal(statusForKind(k), 'Not Working', k);
  }
});

test('kind aliases map to the portal spelling', () => {
  assert.equal(normalizeKind('Distributor'), 'Distributer');
  assert.equal(normalizeKind('industrial service'), 'Industrial Services');
  assert.equal(normalizeKind('Restricted Sites'), 'Restricted Site');
  assert.equal(normalizeKind('something odd'), 'Other');
});

test('buildEntry: working kind fills everything', () => {
  const e = buildEntry({
    url: 'http://a.test',
    site: { status: 'Working' },
    extraction: {
      kind: 'Manufacturer',
      email: 'info@a.test',
      phone: '+44 1554 779090',
      country: 'United Kingdom',
      addressFound: true,
      cityFound: true,
      stateFound: false,
      hasCompanyProfile: true,
      products: [
        { name: 'A', hasImage: true, hasDescription: true },
        { name: 'B', hasImage: false, hasDescription: true },
      ],
    },
  });
  assert.deepEqual(
    { ...e },
    {
      url: 'http://a.test',
      status: 'Working',
      kind: 'Manufacturer',
      email: 'info@a.test',
      phone: '+441554779090',
      country: 'UK',
      address: 'Y',
      city: 'Y',
      state: 'N',
      companyProfile: 'Y',
      nameOfProd: '2',
      imageOfProd: '1',
      descOfProd: '2',
    },
  );
});

test('buildEntry: Service Provider -> Not Working, but email / phone / country are still entered', () => {
  const e = buildEntry({
    url: 'http://b.test',
    site: { status: 'Working' },
    extraction: {
      kind: 'Service Provider', email: 'X@B.test', phone: '+49 30 123 456', country: 'Germany',
      addressFound: true, cityFound: true, hasCompanyProfile: true,
      products: [{ name: 'Thing', hasImage: true, hasDescription: true }],
    },
  });
  assert.equal(e.status, 'Not Working');
  assert.equal(e.kind, 'Service Provider');
  assert.equal(e.email, 'x@b.test');
  assert.equal(e.phone, '+4930123456');
  assert.equal(e.country, 'Germany');
  assert.equal(e.address, 'Y');
  assert.equal(e.companyProfile, 'Y');
  assert.equal(e.nameOfProd, '0'); // not a product seller
  assert.equal(e.imageOfProd, '0');
});

test('buildEntry: dead / parked site -> that status, kind Other', () => {
  const e = buildEntry({ url: 'http://c.test', site: { status: 'Not Working' }, extraction: null });
  assert.equal(e.status, 'Not Working');
  assert.equal(e.kind, 'Other');
  assert.equal(e.address, 'N');
  const d = buildEntry({ url: 'http://d.test', site: { status: 'Domain Expired' }, extraction: null });
  assert.equal(d.status, 'Domain Expired');
});

test('buildEntry: no extraction on a working site leaves kind/status for the person', () => {
  const e = buildEntry({ url: 'http://e.test', site: { status: 'Working' }, extraction: null });
  assert.equal(e.kind, '');
  assert.equal(e.status, '');
});
