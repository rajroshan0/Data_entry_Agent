import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKind } from '../src/classify.js';
import { statusForKind } from '../src/rules.js';

const pg = (text, title = '') => [{ url: 'http://x.test/', title, text }];
const kind = (t, title) => classifyKind(pg(t, title)).kind;
const pad = ' This page has enough words so that it is long enough to be judged properly by the rules.';

test('classify: gambling menu on a safety-training site -> Restricted Site (the rospaworkplacesafety case)', () => {
  const r = classifyKind(pg('WORKPLACE SAFETY TRAINING AND COMPLIANCE RESOURCES CASINO SLOT SBOBET SLOT ONLINE CONTACT' + pad));
  assert.equal(r.kind, 'Restricted Site');
  assert.equal(r.strong, true);
  assert.equal(statusForKind('Restricted Site'), 'Not Working');
});

test('classify: each of the main kinds from typical wording', () => {
  assert.equal(kind('We manufacture stainless steel valves in our factory.' + pad), 'Manufacturer');
  assert.equal(kind('Leading wholesaler of kitchen goods, bulk orders welcome.' + pad), 'Wholesaler');
  assert.equal(kind('Authorized dealer and distributor of electrical brands.' + pad), 'Distributer');
  assert.equal(kind('We are an exporter of spices to 20 countries.' + pad), 'Exporter');
  assert.equal(kind('Add to cart and checkout securely. Free shipping.' + pad), 'Online Shopping');
  assert.equal(kind('Welcome to the University of Auckland. Study with us.' + pad), 'Service Provider');
  assert.equal(kind('Pipe fabrication services and maintenance contractors.' + pad), 'Industrial Services');
  assert.equal(kind('My personal photos and thoughts about my holidays on the beach.' + pad), 'Other');
  assert.equal(kind('x'), 'Other');
});

test('classify: manufacturer beats exporter; one stray "poker" word is not Restricted', () => {
  assert.equal(kind('We manufacture bags and export them worldwide.' + pad), 'Manufacturer');
  assert.notEqual(kind('A poker face is hard to read. We manufacture chairs.' + pad), 'Restricted Site');
});

test('rules: kinds below Service Provider are Not Working, kinds above are Working', () => {
  for (const k of ['Service Provider', 'Online Shopping', 'Restricted Site', 'Other']) assert.equal(statusForKind(k), 'Not Working');
  for (const k of ['Manufacturer', 'Industrial Services', 'Exporter', 'Trader', 'Distributer', 'Supplier', 'Wholesaler']) assert.equal(statusForKind(k), 'Working');
});
