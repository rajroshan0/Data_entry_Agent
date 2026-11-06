import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Portal } from './portal.js';
import { visitSite } from './visitor.js';
import { runExtraction } from './extractor.js';
import { buildEntry } from './rules.js';
import { makeLlm, providerName } from './llm.js';
import { aiSettingsNow, keyStatus } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const CSV_COLUMNS = [
  'time', 'mode', 'url', 'final_url', 'site_status', 'kind', 'status', 'email', 'phone', 'country',
  'address', 'city', 'state', 'company_profile', 'name_of_prod', 'image_of_prod', 'desc_of_prod',
  'products', 'additional_products', 'flags', 'submitted',
];

export class Worker {
  /**
   * deps.llm can be injected (used by tests). By default the Claude API is used when a key is set.
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.llmInjected = 'llm' in deps; // tests pass their own AI
    this.llm = this.llmInjected ? deps.llm : makeLlm(cfg);
    this.stopRequested = false;
    this.context = null;
    this.state = this.freshState();
  }

  freshState() {
    return {
      running: false,
      mode: 'review',
      stage: 'idle',
      awaitingLogin: false,
      awaitingSubmit: false,
      currentUrl: '',
      stats: { processed: 0, working: 0, notWorking: 0, needYou: 0 },
      last: null,
      log: [],
      error: '',
      hasAiKey: !!this.llm,
    };
  }

  getState() {
    return this.state;
  }

  log(msg, level = 'info') {
    const line = { t: new Date().toLocaleTimeString(), level, msg };
    this.state.log.push(line);
    if (this.state.log.length > 400) this.state.log.shift();
    console.log(`[${line.t}] ${msg}`);
  }

  setStage(stage) {
    this.state.stage = stage;
  }

  async start({ mode = 'review', limit = 0 } = {}) {
    if (this.state.running) return;
    this.stopRequested = false;
    // Re-read the AI key from .env, so saving the file is enough (no restart needed).
    if (!this.llmInjected) {
      Object.assign(this.cfg, aiSettingsNow());
      this.llm = makeLlm(this.cfg);
    }
    this.state = this.freshState();
    this.state.running = true;
    this.state.mode = mode === 'auto' ? 'auto' : 'review';
    this.run(limit).catch((e) => {
      this.state.error = e.message;
      this.log(`Stopped: ${e.message}`, 'error');
    }).finally(() => {
      // Chrome is left open on purpose, so you can see what is on screen. It is reused next time.
      this.state.running = false;
      this.state.awaitingSubmit = false;
      this.state.awaitingLogin = false;
      this.setStage('idle');
    });
  }

  stop() {
    if (!this.state.running) return;
    this.stopRequested = true;
    this.log('Stop requested. Finishing the current step...');
  }

  async closeBrowser() {
    try {
      await this.context?.close();
    } catch {
      /* already closed */
    }
    this.context = null;
  }

  async launch() {
    const base = {
      headless: this.cfg.headless,
      ignoreHTTPSErrors: true,
      chromiumSandbox: !(process.getuid && process.getuid() === 0), // removes the "--no-sandbox" warning bar in Chrome
      viewport: this.cfg.headless ? { width: 1366, height: 800 } : null,
      args: this.cfg.headless ? [] : ['--start-maximized'],
    };
    if (this.cfg.useSystemChrome) {
      try {
        return await chromium.launchPersistentContext(this.cfg.profileDir, { ...base, channel: 'chrome' });
      } catch {
        this.log('Google Chrome was not found, using the bundled Chromium instead.');
      }
    }
    return chromium.launchPersistentContext(this.cfg.profileDir, base);
  }

  // Waits until fn() is true. Returns false on timeout or when Stop is pressed.
  async waitFor(fn, timeoutMs, pollMs = 400) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.stopRequested) return false;
      if (await fn()) return true;
      await sleep(pollMs);
    }
    return false;
  }

  // One tiny request, so a bad key / blocked network is shown at the start, not after a whole website.
  async checkAi() {
    this.setStage('checking the AI key');
    try {
      const r = await this.llm('Reply with JSON only.', 'Return {"ok": true}');
      if (!/ok/i.test(String(r))) throw new Error(`unexpected answer: ${String(r).slice(0, 80)}`);
      this.log(`AI check: the key works.${this.cfg.groqModelSwitched ? ` (Your account cannot use the default model, so ${providerName(this.cfg)} is used instead.)` : ''}`);
    } catch (e) {
      const msg = e?.cause?.code || e?.cause?.message ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
      this.log(`AI check FAILED: ${msg}`, 'error');
      this.log('  Websites will be filled without the AI (you choose Kind of Business) until this is fixed.', 'warn');
    }
  }

  async run(limit) {
    const cfg = this.cfg;
    fs.mkdirSync(cfg.outDir, { recursive: true });
    this.setStage('opening Chrome');
    this.log(`AI: ${this.llm ? providerName(cfg) : 'none (review mode, you choose Kind of Business)'}`);
    if (!this.llm) this.log(`  ${keyStatus(cfg)}`, 'warn');
    if (this.llm && !this.llmInjected) await this.checkAi();
    if (!this.context) {
      this.log('Opening Chrome...');
      this.context = await this.launch();
      this.context.on('close', () => {
        this.context = null;
      });
    } else {
      this.log('Using the Chrome window that is already open.');
    }
    const page = this.context.pages().find((p) => !p.isClosed()) ?? (await this.context.newPage());
    await page.bringToFront().catch(() => {});
    const portal = new Portal(page, cfg, (m) => this.log(m));

    await portal.open();
    if (!(await portal.isLoggedIn())) {
      this.state.awaitingLogin = true;
      this.setStage('waiting for you to log in');
      this.log('Log in to the portal in the Chrome window. Your login is saved for next time.');
      const ok = await this.waitFor(async () => portal.isLoggedIn(), 10 * 60 * 1000, 1000);
      this.state.awaitingLogin = false;
      if (!ok) throw new Error('Login was not completed.');
      this.log('Logged in.');
    }

    let lastUrl = '';
    let repeats = 0;
    let done = 0;

    while (!this.stopRequested) {
      if (limit && done >= limit) {
        this.log(`Reached the limit of ${limit} sites.`);
        break;
      }
      await portal.open();
      const url = await portal.readUrl();
      if (!url) {
        this.log('The portal did not show a website to check (waited for the URL box to fill).', 'warn');
        this.log(`  ${await portal.describePage()}`, 'warn');
        this.log('  If you expected a website here, copy the two lines above and send them to your developer. Chrome stays open.', 'warn');
        break;
      }
      if (url === lastUrl) {
        repeats += 1;
        if (repeats >= 2) {
          throw new Error(`The portal shows ${url} again. Stopping so nothing is entered twice.`);
        }
        await sleep(1500);
        continue;
      }
      repeats = 0;
      lastUrl = url;
      this.state.currentUrl = url;
      await this.processOne(portal, url);
      done += 1;
    }
    if (this.stopRequested) this.log('Stopped.');
  }

  async processOne(portal, url) {
    const cfg = this.cfg;
    this.log(`Checking ${url}`);

    this.setStage('visiting the website');
    const visit = await visitSite(this.context, url, cfg, (m) => this.log(m));
    this.log(`  site: ${visit.siteStatus}${visit.reason ? ` (${visit.reason})` : ''}, ${visit.pages.length} page(s) read`);

    let extraction = null;
    const flags = [...visit.flags];
    let raw = null;
    let aiError = '';
    if (visit.siteStatus === 'Working') {
      this.setStage('reading the pages');
      const r = await runExtraction({ visit, llm: this.llm, maxChars: cfg.aiMaxChars });
      extraction = r.extraction;
      raw = r.raw;
      flags.push(...r.flags);
      if (r.aiError) {
        aiError = r.aiError;
        this.log(`  AI problem: ${r.aiError}`, 'warn');
      }
    }

    const entry = buildEntry({
      url,
      site: { status: visit.siteStatus },
      extraction,
      options: { stripPunctuation: cfg.stripPhonePunctuation },
    });
    if (!entry.kind || !entry.status) flags.push('kind-needs-your-choice');

    this.setStage('filling the form');
    await portal.fill(entry);
    const mismatches = await portal.verify(entry);
    if (mismatches.length) {
      flags.push('form-mismatch');
      mismatches.forEach((m) => this.log(`  form check: ${m}`, 'warn'));
    }

    const auto = this.state.mode === 'auto' && flags.length === 0;
    let submitted = false;

    if (auto) {
      this.setStage('submitting');
      await portal.submit();
    } else {
      this.state.awaitingSubmit = true;
      this.state.stats.needYou += 1;
      this.setStage('waiting for you to check and click submit');
      this.log(
        flags.length
          ? `  needs you: ${flags.join(', ')}. Check the form in Chrome, then click submit.`
          : '  Form is filled. Check it in Chrome, then click submit.',
        'warn',
      );
    }

    const timeout = auto ? 30000 : cfg.reviewTimeoutMs;
    submitted = await this.waitFor(() => portal.isSubmitted(), timeout);
    this.state.awaitingSubmit = false;
    if (!submitted) {
      if (this.stopRequested) return;
      throw new Error(auto ? 'The portal did not confirm the submit.' : 'No submit within the waiting time.');
    }
    await portal.dismissPopup();

    this.state.stats.processed += 1;
    if (entry.status === 'Working') this.state.stats.working += 1;
    else this.state.stats.notWorking += 1;
    this.state.last = { ...entry, flags, finalUrl: visit.finalUrl };
    this.log(`  saved: ${entry.status}${entry.kind ? ` / ${entry.kind}` : ''}${auto ? ' (auto)' : ''}`);

    this.record({ entry, visit, extraction, raw, flags, submitted, aiError });
  }

  // Log of every entry: results.csv for Excel, results.jsonl with the evidence.
  record({ entry, visit, extraction, raw, flags, submitted, aiError = '' }) {
    const dir = this.cfg.outDir;
    const csvPath = path.join(dir, 'results.csv');
    if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, CSV_COLUMNS.join(',') + '\n');
    const products = (extraction?.products ?? []).map((p) => p.name).join(' | ');
    const more = (extraction?.additionalProducts ?? []).join(' | ');
    const row = [
      new Date().toISOString(), this.state.mode, entry.url, visit.finalUrl, visit.siteStatus,
      entry.kind, entry.status, entry.email, entry.phone, entry.country,
      entry.address, entry.city, entry.state, entry.companyProfile,
      entry.nameOfProd, entry.imageOfProd, entry.descOfProd,
      products, more, flags.join(' '), submitted ? 'yes' : 'no',
    ];
    fs.appendFileSync(csvPath, row.map(csvCell).join(',') + '\n');
    fs.appendFileSync(
      path.join(dir, 'results.jsonl'),
      JSON.stringify({
        time: new Date().toISOString(),
        mode: this.state.mode,
        entry,
        site: { finalUrl: visit.finalUrl, status: visit.siteStatus, reason: visit.reason, screenshot: visit.screenshot },
        pagesRead: visit.pages.map((p) => p.url),
        extraction,
        aiAnswer: raw,
        aiError,
        flags,
      }) + '\n',
    );
  }
}
