import fs from 'node:fs';
import path from 'node:path';

// ---- patterns used to decide the website status ---------------------------------------------
const EXPIRED = [/domain\s+(name\s+)?(has\s+)?expired/i, /this\s+domain\s+(has\s+)?expired/i];
const PARKED = [
  /domain\s+(name\s+)?(is|may be|might be)\s+for\s+sale/i,
  /this\s+domain\s+(is\s+parked|is\s+available|is\s+for\s+sale)/i,
  /buy\s+this\s+domain/i,
  /may be for sale,?\s+click to inquire/i,
  /parked\s+(free\s+)?(domain|page)/i,
];
const PARKED_HOSTS =
  /(^|\.)(sedo\.com|sedoparking\.com|hugedomains\.com|dan\.com|afternic\.com|go2net\.com|parkingcrew\.net|bodis\.com|domainsponsor\.com)$/i;
const CONSTRUCTION = [
  /under\s+construction/i,
  /coming\s+soon/i,
  /(website|site)\s+(is\s+)?(currently\s+)?(under|down\s+for)\s+maintenance/i,
];

// Words that make a link worth opening, with weights.
const LINK_HINTS = [
  [/contact|get[-_ ]?in[-_ ]?touch|reach[-_ ]?us|enquir|inquir|find[-_ ]?us|location|address/i, 10],
  [/product/i, 8],
  [/about/i, 6],
  [/service/i, 6],
  [/catalog|catalogue|range|solutions?|shop|store|portfolio|our[-_ ]?work|brochure/i, 4],
  [/company|profile|who[-_ ]we[-_ ]are|overview|history/i, 3],
];

export function normalizeUrl(raw) {
  let u = String(raw ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

function navError(e) {
  const m = String(e?.message ?? e);
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return 'domain does not resolve (DNS error)';
  if (/ERR_CONNECTION_REFUSED/.test(m)) return 'connection refused';
  if (/ERR_CONNECTION_TIMED_OUT|Timeout/i.test(m)) return 'site timed out';
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(m)) return 'connection closed by server';
  if (/ERR_CERT|SSL/i.test(m)) return 'certificate error';
  return m.split('\n')[0].slice(0, 120);
}

async function settle(page, ms = 6000) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(700);
}

// Runs inside the page: returns text, links, images and mailto/tel links.
async function collect(page, textLimit) {
  const data = await page.evaluate(() => {
    const abs = (h) => {
      try {
        return new URL(h, location.href).href;
      } catch {
        return null;
      }
    };
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => ({
        href: abs(a.getAttribute('href')),
        text: (a.innerText || a.title || '').trim().slice(0, 80),
      }))
      .filter((l) => l.href);
    // Contact details that sites hide in JSON-LD (schema.org) for search engines.
    const ld = [];
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const walk = (o) => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) return o.forEach(walk);
          for (const k of ['telephone', 'email', 'streetAddress', 'addressLocality', 'addressRegion', 'addressCountry']) {
            const v = typeof o[k] === 'object' ? o[k]?.name : o[k];
            if (v && typeof v === 'string') ld.push(`${k}: ${v}`);
          }
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(sc.textContent));
      } catch {
        /* not valid JSON */
      }
    }
    return {
      title: document.title || '',
      text: (document.body ? document.body.innerText : '') + (ld.length ? '\n\nSTRUCTURED DATA: ' + ld.join(' | ') : ''),
      links,
      imgs: [...document.images].slice(0, 60).map((i) => ({
        alt: i.alt || '',
        src: (i.currentSrc || i.src || '').split('/').pop().split('?')[0].slice(0, 80),
      })),
      hasFlash: !!document.querySelector(
        'embed[src*=".swf" i], object[data*=".swf" i], object[type*="flash" i]',
      ),
    };
  });
  return {
    url: page.url(),
    title: data.title,
    text: data.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, textLimit),
    links: data.links,
    mailtos: data.links.filter((l) => l.href.startsWith('mailto:')).map((l) => l.href),
    tels: data.links.filter((l) => l.href.startsWith('tel:')).map((l) => l.href),
    imgs: data.imgs,
    hasFlash: data.hasFlash,
  };
}

function pickSubpages(home, max) {
  const homeHost = hostOf(home.url);
  const seen = new Set([new URL(home.url).pathname.replace(/\/$/, '') || '/']);
  const scored = [];
  for (const l of home.links) {
    let u;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.href) !== homeHost) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|mp4)$/i.test(u.pathname)) continue;
    const key = u.pathname.replace(/\/$/, '') || '/';
    if (seen.has(key)) continue;
    const hay = `${u.pathname} ${l.text}`;
    let score = 0;
    for (const [re, w] of LINK_HINTS) if (re.test(hay)) score += w;
    if (score > 0) {
      seen.add(key);
      scored.push({ href: u.href.split('#')[0], score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.href);
}

/**
 * Opens a website in a new tab and reads the home page plus a few contact/about/product pages.
 * Returns { inputUrl, finalUrl, siteStatus, reason, pages, flags, screenshot }
 * siteStatus is one of the portal's Website Status labels.
 */
export async function visitSite(context, rawUrl, cfg, log = () => {}) {
  const inputUrl = normalizeUrl(rawUrl);
  const result = {
    inputUrl,
    finalUrl: inputUrl,
    siteStatus: 'Working',
    reason: '',
    pages: [],
    flags: [],
    screenshot: null,
  };
  const page = await context.newPage();
  try {
    let resp;
    try {
      resp = await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    } catch (e) {
      result.siteStatus = 'Not Working';
      result.reason = navError(e);
      return result;
    }
    await settle(page);

    const httpStatus = resp?.status() ?? 0;
    const home = await collect(page, cfg.pageTextLimit);
    result.finalUrl = page.url();
    result.pages.push(home);

    // Evidence screenshot of the home page
    try {
      fs.mkdirSync(path.join(cfg.outDir, 'screens'), { recursive: true });
      const file = path.join(cfg.outDir, 'screens', `${Date.now()}-${hostOf(result.finalUrl) || 'site'}.png`);
      await page.screenshot({ path: file });
      result.screenshot = file;
    } catch {
      /* screenshot is optional */
    }

    const finalHost = hostOf(result.finalUrl);
    const text = home.text;

    if (httpStatus >= 400) {
      result.siteStatus = 'Not Working';
      result.reason = `HTTP ${httpStatus}`;
      return result;
    }
    if (EXPIRED.some((re) => re.test(text))) {
      result.siteStatus = 'Domain Expired';
      result.reason = 'page says the domain has expired';
      return result;
    }
    if (PARKED_HOSTS.test(finalHost) || PARKED.some((re) => re.test(text))) {
      result.siteStatus = cfg.parkedStatus;
      result.reason = 'parked / for-sale domain';
      return result;
    }
    if (text.length < 30 && home.links.length < 2) {
      result.siteStatus = 'Not Working';
      result.reason = 'page is blank';
      result.flags.push('blank-page');
      return result;
    }
    if (text.length < 800 && CONSTRUCTION.some((re) => re.test(text))) {
      result.siteStatus = 'Under Construction';
      result.reason = 'page says under construction / coming soon';
      return result;
    }
    if (home.hasFlash && text.length < 400) {
      result.siteStatus = 'Flash Site';
      result.reason = 'Flash content';
      return result;
    }
    const letters = text.match(/\p{L}/gu) ?? [];
    if (letters.length >= 80) {
      const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
      if (latin / letters.length < 0.5) {
        result.siteStatus = 'Non English';
        result.reason = 'page is not in English';
        return result;
      }
    }
    if (cfg.redirectAsStatus && finalHost && finalHost !== hostOf(inputUrl)) {
      result.siteStatus = 'Redirect Site';
      result.reason = `redirects to ${finalHost}`;
      return result;
    }
    if (finalHost && finalHost !== hostOf(inputUrl)) {
      result.flags.push('redirected-to-other-domain');
      result.reason = `redirected to ${finalHost}`;
    }

    // Working site: read contact / about / product pages too
    const subs = pickSubpages(home, Math.max(0, cfg.maxPages - 1));
    for (const href of subs) {
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await settle(page, 4000);
        result.pages.push(await collect(page, cfg.pageTextLimit));
      } catch (e) {
        log(`  could not open ${href}: ${navError(e)}`);
      }
    }
    // Many sites do not link their Contact page from the home page text. Try the usual addresses.
    if (!result.pages.some((p) => /contact/i.test(p.url))) {
      const origin = new URL(home.url).origin;
      for (const path of ['/contact', '/contact-us', '/contactus', '/contact.html', '/contact-us.html', '/contact.php', '/about-us/contact']) {
        try {
          const resp = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 10000 });
          if (!resp || resp.status() >= 400) continue;
          await settle(page, 3000);
          const got = await collect(page, cfg.pageTextLimit);
          const sameAsHome = new URL(got.url).pathname.replace(/\/$/, '') === (new URL(home.url).pathname.replace(/\/$/, '') || '');
          if (!sameAsHome && got.text.length > 80 && !result.pages.some((p) => p.url === got.url)) {
            result.pages.push(got);
            log(`  opened ${path} (not linked on the home page)`);
            break;
          }
        } catch {
          /* try the next address */
        }
      }
    }
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}
