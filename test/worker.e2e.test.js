// End-to-end test: real Chrome, mock portal, mock websites, fake AI.
// Skipped automatically when Google Chrome is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import cfgBase from '../src/config.js';
import { Worker } from '../src/worker.js';
import { startMocks } from './mock-servers.js';

const hasChrome = fs.existsSync('/usr/bin/google-chrome') || (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

// A fake AI that answers from the page text, the way the real one is instructed to.
const fakeLlm = async (_system, user) => {
  if (/WEBSITE: \S*\/site\/(good|nolinks)/.test(user)) {
    return JSON.stringify({
      kind: 'Manufacturer', kindEvidence: 'manufacturer of industrial valves', confidence: 'high',
      email: 'info@acmevalves.test', phone: '+44 1554 779090',
      country: 'United Kingdom', countryEvidence: 'Llanelli, Wales, United Kingdom',
      address: '12 High Street', city: 'Llanelli', state: 'Wales', hasCompanyProfile: false,
      products: [
        { name: 'Ball Valve BV-100', hasDescription: true, descriptionEvidence: 'a high pressure stainless steel valve for oil and gas lines' },
        { name: 'Gate Valve GV-200', hasDescription: false, descriptionEvidence: null },
        { name: 'Check Valve CV-300', hasDescription: false, descriptionEvidence: null },
      ],
      additionalProducts: [],
    });
  }
  return JSON.stringify({
    kind: 'Service Provider', kindEvidence: 'health and safety consultancy, HSE training', confidence: 'high',
    email: 'info@nist-training.test', phone: '+91 44 4564 3333', country: 'India', countryEvidence: 'Tamil Nadu, India',
    products: [], additionalProducts: [],
  });
};

async function runWorker(queue, mode, llm = fakeLlm, { delayUrlMs = 0, limit = queue.length, urlKind = 'url' } = {}) {
  const mocks = await startMocks(queue, { delayUrlMs, urlKind });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deb-'));
  const cfg = {
    ...cfgBase,
    portalUrl: `http://127.0.0.1:${mocks.port}/`,
    profileDir: path.join(tmp, 'profile'),
    outDir: path.join(tmp, 'out'),
    headless: true,
    maxPages: 3,
    navTimeoutMs: 8000,
    reviewTimeoutMs: 20000,
    urlWaitMs: 6000,
  };
  const worker = new Worker(cfg, { llm });
  await worker.start({ mode, limit });
  const end = Date.now() + 60000;
  while (worker.getState().running && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
  const state = worker.getState();
  const chromeStillOpen = !!worker.context;
  await worker.closeBrowser();
  await mocks.close();
  return { state, mocks, cfg, chromeStillOpen };
}

test('auto mode: working manufacturer is filled and submitted; parked and service sites become Not Working', { skip: !hasChrome, timeout: 90000 }, async () => {
  const { state, mocks, cfg } = await runWorker(['/site/good', '/site/parked', '/site/services'], 'auto');
  assert.equal(state.error, '', state.log.map((l) => l.msg).join('\n'));
  assert.equal(mocks.submissions.length, 3);

  const [good, parked, service] = mocks.submissions;

  assert.equal(good['Website Status'], 'Working');
  assert.equal(good['Kind of Bussiness'], 'Manufacturer');
  assert.equal(good.Email, 'info@acmevalves.test');
  assert.equal(good['Phone Number'], '+441554779090'); // spaces removed
  assert.equal(good.Country, 'UK'); // United Kingdom -> UK
  assert.equal(good.Address, 'Y');
  assert.equal(good.City, 'Y');
  assert.equal(good.State, 'Y');
  assert.equal(good['Name of Prod'], '3');
  assert.equal(good['Image of Prod'], '1'); // only Ball Valve has a matching image
  assert.equal(good['Desc of Prod'], '1');

  assert.equal(parked['Website Status'], 'Not Working');
  assert.equal(parked['Kind of Bussiness'], 'Other');
  assert.equal(parked.Email, '');
  assert.equal(parked['Name of Prod'], '0');

  assert.equal(service['Website Status'], 'Not Working'); // Service Provider => Not Working
  assert.equal(service['Kind of Bussiness'], 'Service Provider');
  assert.equal(service.Email, 'info@nist-training.test'); // contact details are still entered
  assert.equal(service['Phone Number'], '+914445643333');
  assert.equal(service.Country, 'India');

  const csv = fs.readFileSync(path.join(cfg.outDir, 'results.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 4); // header + 3 rows
  assert.ok(fs.existsSync(path.join(cfg.outDir, 'results.jsonl')));
});

test('auto mode does NOT submit when the AI answer cannot be verified (needs you)', { skip: !hasChrome, timeout: 90000 }, async () => {
  // AI invents an email and a product that are not on the page. Nobody clicks submit, so the run must wait, not submit.
  const liar = async () =>
    JSON.stringify({
      kind: 'Manufacturer', confidence: 'high', email: 'ceo@invented.test', phone: '+99 123 456 7890',
      country: 'United Kingdom', countryEvidence: 'Llanelli, Wales, United Kingdom',
      products: [{ name: 'Quantum Widget' }],
    });
  const { state, mocks } = await runWorker(['/site/good'], 'auto', liar);
  assert.equal(mocks.submissions.length, 0, 'must not submit by itself');
  assert.match(state.error, /No submit within the waiting time/);
  assert.ok(state.stats.needYou >= 1);
});

test('review mode without an AI key leaves Kind for the person and never submits', { skip: !hasChrome, timeout: 90000 }, async () => {
  const { state, mocks } = await runWorker(['/site/good'], 'review', null);
  assert.equal(mocks.submissions.length, 0);
  assert.ok(state.log.some((l) => /needs you/i.test(l.msg)));
});

test('portal that fills the URL box a moment after loading is waited for', { skip: !hasChrome, timeout: 90000 }, async () => {
  const { state, mocks } = await runWorker(['/site/parked'], 'auto', fakeLlm, { delayUrlMs: 2500 });
  assert.equal(state.error, '', state.log.map((l) => l.msg).join('\n'));
  assert.equal(mocks.submissions.length, 1);
  assert.equal(mocks.submissions[0]['Website Status'], 'Not Working');
});

for (const urlKind of ['text-disabled', 'plain']) {
  test(`website shown as "${urlKind}" (not a url-type box) is still found`, { skip: !hasChrome, timeout: 90000 }, async () => {
    const { state, mocks } = await runWorker(['/site/parked', '/site/services'], 'auto', fakeLlm, { urlKind });
    assert.equal(state.error, '', state.log.map((l) => l.msg).join('\n'));
    assert.equal(mocks.submissions.length, 2);
    assert.match(mocks.submissions[0].url, /\/site\/parked$/);
    assert.match(mocks.submissions[1].url, /\/site\/services$/);
  });
}

test('Contact page that the home page does not link to is found by trying /contact', { skip: !hasChrome, timeout: 90000 }, async () => {
  const contactOnly = async (_sys, user) => {
    assert.ok(user.includes('info@acmevalves.test'), 'the guessed /contact page must be part of what the AI reads');
    return JSON.stringify({
      kind: 'Manufacturer', kindEvidence: 'We make industrial valves', confidence: 'high',
      email: 'info@acmevalves.test', phone: '+44 1554 779090',
      country: 'United Kingdom', countryEvidence: 'Llanelli, Wales, United Kingdom',
      products: [], additionalProducts: [],
    });
  };
  const { state, mocks } = await runWorker(['/site/nolinks'], 'auto', contactOnly);
  assert.equal(state.error, '', state.log.map((l) => l.msg).join('\n'));
  assert.equal(mocks.submissions.length, 1);
  assert.equal(mocks.submissions[0].Email, 'info@acmevalves.test');
  assert.equal(mocks.submissions[0].Country, 'UK');
  assert.equal(mocks.submissions[0]['Phone Number'], '+441554779090');
});

test('no website shown: explains why, and Chrome is NOT closed', { skip: !hasChrome, timeout: 90000 }, async () => {
  const { state, chromeStillOpen } = await runWorker([], 'review', fakeLlm, { limit: 0 });
  assert.ok(state.log.some((l) => /did not show a website/i.test(l.msg)));
  assert.ok(state.log.some((l) => /url box:/i.test(l.msg)), 'should show what is on the page');
  assert.equal(chromeStillOpen, true);
});
