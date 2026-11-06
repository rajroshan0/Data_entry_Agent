// Talks to the Online Data Portal page. If the portal changes, only this file needs updating.

// Each dropdown is found by the text of its first option (the placeholder), exactly as shown on the page.
export const SELECT_LABELS = {
  status: 'Website Status',
  address: 'Address',
  city: 'City',
  kind: 'Kind of Bussiness', // spelled this way on the portal
  state: 'State',
  companyProfile: 'Company Profile',
  nameOfProd: 'Name of Prod',
  imageOfProd: 'Image of Prod',
  descOfProd: 'Desc of Prod',
};

export const INPUT_PLACEHOLDERS = {
  email: 'Email',
  phone: 'Phone Number',
  country: 'Country',
};

const URL_BOX = 'input[type="url"]';

export class Portal {
  constructor(page, cfg, log = () => {}) {
    this.page = page;
    this.cfg = cfg;
    this.log = log;
    // Plain JavaScript alert()s from the portal are accepted so they cannot freeze the page.
    if (!page.__dialogHandlerAdded) {
      page.__dialogHandlerAdded = true;
      page.on('dialog', (d) => d.accept().catch(() => {}));
    }
  }

  async open() {
    await this.page.goto(this.cfg.portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  }

  // True when the data-entry form is on screen (so the person is logged in).
  async isLoggedIn() {
    if ((await this.page.locator(URL_BOX).count()) > 0) return true;
    return (await this.select(SELECT_LABELS.status).count()) > 0;
  }

  // Finds the website the portal shows, however it is drawn: a locked text box, a url box, or plain text.
  // Returns { value, how } or null.
  async findUrl() {
    return this.page
      .evaluate(() => {
        const looksLikeUrl = (t) => /^(https?:\/\/|www\.)\S+$/i.test(t);
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const found = [];
        for (const el of document.querySelectorAll('input, textarea')) {
          if (el.type === 'password' || el.type === 'hidden') continue;
          const v = (el.value || '').trim();
          if (looksLikeUrl(v) && visible(el)) {
            found.push({ value: v, how: `input type=${el.type}${el.disabled ? ' disabled' : ''}${el.readOnly ? ' readonly' : ''}`, rank: el.type === 'url' ? 0 : 1 });
          }
        }
        for (const el of document.querySelectorAll('span, div, p, label, td, b, strong, h1, h2, h3, h4')) {
          if (el.children.length) continue;
          const t = (el.textContent || '').trim();
          if (looksLikeUrl(t) && !el.closest('a') && visible(el)) found.push({ value: t, how: `text in <${el.tagName.toLowerCase()}>`, rank: 2 });
        }
        found.sort((a, b) => a.rank - b.rank);
        return found[0] || null;
      })
      .catch(() => null);
  }

  // The website the portal wants checked next. The portal can fill it a moment after the page
  // loads, so wait for it instead of reading once.
  async readUrl(waitMs = this.cfg.urlWaitMs ?? 15000) {
    const end = Date.now() + waitMs;
    for (;;) {
      const f = await this.findUrl();
      if (f) {
        this.lastUrlHow = f.how;
        return f.value;
      }
      if (Date.now() >= end) return '';
      await this.page.waitForTimeout(500);
    }
  }

  // Used when no website could be read: what is on screen, so the cause can be seen in the log.
  async describePage() {
    try {
      const info = await this.page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input, textarea')]
          .filter((e) => e.type !== 'password')
          .slice(0, 12)
          .map((e) => `${e.tagName.toLowerCase()}[type=${e.type}${e.placeholder ? ',ph=' + e.placeholder : ''}${e.disabled ? ',disabled' : ''}${e.readOnly ? ',readonly' : ''}]="${(e.value || '').slice(0, 60)}"`);
        return { inputs, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200) };
      });
      return `page: ${this.page.url()} | url box: ${info.inputs.join(' ; ') || '(no input fields)'} | text: ${info.text}`;
    } catch (e) {
      return `page: ${this.page.url()} | ${e.message}`;
    }
  }

  select(label) {
    return this.page.locator(`select:has(option:text-is("${label}"))`).first();
  }

  input(placeholder) {
    return this.page.locator(`input[placeholder="${placeholder}"]`).first();
  }

  async fill(entry) {
    for (const [key, label] of Object.entries(SELECT_LABELS)) {
      const value = entry[key];
      if (value === '' || value === undefined) continue;
      await this.select(label).selectOption({ label: String(value) }, { timeout: 5000 });
    }
    for (const [key, placeholder] of Object.entries(INPUT_PLACEHOLDERS)) {
      const box = this.input(placeholder);
      await box.fill('');
      if (entry[key]) await box.fill(String(entry[key]));
    }
  }

  // What the form really shows now, used to double-check the fill.
  async readBack() {
    const out = {};
    for (const [key, label] of Object.entries(SELECT_LABELS)) {
      out[key] = await this.select(label).evaluate(
        (el) => (el.selectedOptions[0]?.textContent ?? '').trim(),
      );
    }
    for (const [key, placeholder] of Object.entries(INPUT_PLACEHOLDERS)) {
      out[key] = await this.input(placeholder).inputValue();
    }
    return out;
  }

  // Returns a list of fields whose value on the form differs from what we meant to enter.
  async verify(entry) {
    const shown = await this.readBack();
    const bad = [];
    for (const key of [...Object.keys(SELECT_LABELS), ...Object.keys(INPUT_PLACEHOLDERS)]) {
      const want = entry[key] ?? '';
      if (want === '' && SELECT_LABELS[key]) continue; // empty select stays on its placeholder
      if (String(shown[key]) !== String(want)) bad.push(`${key}: wanted "${want}", form shows "${shown[key]}"`);
    }
    return bad;
  }

  async submit() {
    await this.page.getByRole('button', { name: /^submit$/i }).first().click({ timeout: 5000 });
  }

  // The portal shows a "Record Updated" popup after a successful submit.
  async isSubmitted() {
    return this.page
      .getByText('Record Updated')
      .first()
      .isVisible()
      .catch(() => false);
  }

  async dismissPopup() {
    await this.page
      .getByRole('button', { name: /^ok$/i })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  }
}
