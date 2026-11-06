// A fake Online Data Portal and two fake websites, used by the end-to-end test.
// The portal form copies the real portal's structure (same dropdown options and placeholders).
import http from 'node:http';

const OPTS = {
  'Website Status': ['Working', 'Not Working', 'Domain Expired', 'Non English', 'Under Construction', 'Flash Site', 'Redirect Site'],
  Address: ['Y', 'N'],
  City: ['Y', 'N'],
  'Kind of Bussiness': ['Manufacturer', 'Industrial Services', 'Exporter', 'Trader', 'Distributer', 'Supplier', 'Wholesaler', 'Service Provider', 'Online Shopping', 'Restricted Site', 'Other'],
  State: ['Y', 'N'],
  'Company Profile': ['Y', 'N'],
  'Name of Prod': ['0', '1', '2', '3'],
  'Image of Prod': ['0', '1', '2', '3'],
  'Desc of Prod': ['0', '1', '2', '3'],
};

const sel = (label) =>
  `<select name="${label}"><option selected>${label}</option>${OPTS[label].map((o) => `<option>${o}</option>`).join('')}</select>`;

function portalHtml(url, loggedIn, delayMs = 0, urlKind = 'url') {
  if (!loggedIn) return '<html><body><h1>Log in</h1><input type="password"></body></html>';
  return `<!doctype html><html><body>
  <nav>Online Data Portal</nav>
  ${urlKind === 'text-disabled'
    ? `<input type="text" id="u" value="${delayMs ? '' : url}" disabled>`
    : urlKind === 'plain'
      ? `<div id="u" class="shown">${delayMs ? '' : url}</div>`
      : `<input type="url" id="u" value="${delayMs ? '' : url}" readonly>`}
  ${sel('Website Status')}${sel('Address')}${sel('City')}${sel('Kind of Bussiness')}
  <input type="text" placeholder="Email"><input type="text" placeholder="Phone Number"><input type="text" placeholder="Country">
  ${sel('State')}${sel('Company Profile')}${sel('Name of Prod')}${sel('Image of Prod')}${sel('Desc of Prod')}
  <button type="button" id="s">submit</button><input type="reset" value="Reset">
  <div id="pop" style="display:none"><p>Record Updated</p><button type="button" id="ok">Ok</button></div>
  <script>
    if (${delayMs}) setTimeout(() => { const u = document.getElementById('u'); if ('value' in u) u.value = '${url}'; else u.textContent = '${url}'; }, ${delayMs});
    document.getElementById('s').onclick = async () => {
      const data = {};
      document.querySelectorAll('select').forEach((s) => (data[s.name] = s.selectedOptions[0].textContent));
      document.querySelectorAll('input[placeholder]').forEach((i) => (data[i.placeholder] = i.value));
      const u = document.getElementById('u'); data.url = 'value' in u ? u.value : u.textContent;
      await fetch('/submit', { method: 'POST', body: JSON.stringify(data) });
      document.getElementById('pop').style.display = 'block';
    };
    document.getElementById('ok').onclick = () => (document.getElementById('pop').style.display = 'none');
  </script></body></html>`;
}

const SITES = {
  '/contact': `<html><head><title>Contact</title></head><body>
    <h1>Contact Acme Valves</h1>
    <p>Email: <a href="mailto:info@acmevalves.test">info@acmevalves.test</a></p>
    <p>Tel: +44 1554 779090. 12 High Street, Llanelli, Wales, United Kingdom. Open Monday to Friday.</p></body></html>`,
  '/site/nolinks': `<html><head><title>Welcome</title></head><body>
    <h1>Welcome</h1><p>We make industrial valves for oil and gas customers around the world.</p></body></html>`,
  '/site/good': `<html><head><title>Acme Valves</title></head><body>
    <h1>Acme Valves Ltd</h1>
    <p>Acme Valves Ltd is a manufacturer of industrial valves.</p>
    <p>Products: Ball Valve BV-100, Gate Valve GV-200, Check Valve CV-300.</p>
    <p>Ball Valve BV-100 is a high pressure stainless steel valve for oil and gas lines.</p>
    <img src="/img/bv-100.jpg" alt="Ball Valve BV-100">
    <a href="/site/contact">Contact us</a></body></html>`,
  '/site/contact': `<html><head><title>Contact</title></head><body>
    <h1>Contact Acme Valves</h1>
    <p>Email: <a href="mailto:info@acmevalves.test">info@acmevalves.test</a></p>
    <p>Tel: +44 1554 779090. 12 High Street, Llanelli, Wales, United Kingdom</p></body></html>`,
  '/site/parked': `<html><head><title>sunsolarenergy.test</title></head><body>
    <div>sunsolarenergy.test may be for sale, click to inquire</div>
    <h2>Looking for Power and energy industry?</h2></body></html>`,
  '/site/services': `<html><head><title>Nist Training</title></head><body>
    <h1>Nist Safety Training</h1>
    <p>We provide health and safety consultancy, HSE training and fire safety audits for companies across India.</p>
    <p>Email: info@nist-training.test Phone: +91 44 4564 3333. Chennai, Tamil Nadu, India. About our company: we are a training institute.</p></body></html>`,
};

/**
 * Starts the mock portal + sites on a random port.
 * queue: paths such as '/site/good'. The portal shows the next one after each submit.
 */
export async function startMocks(queue, { delayUrlMs = 0, urlKind = 'url' } = {}) {
  const submissions = [];
  let index = 0;
  let loggedIn = true;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/submit') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        submissions.push(JSON.parse(body));
        index += 1;
        res.end('ok');
      });
      return;
    }
    if (u.pathname === '/') {
      const next = queue[index] ? `http://127.0.0.1:${server.address().port}${queue[index]}` : '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(portalHtml(next, loggedIn, delayUrlMs, urlKind));
    }
    if (SITES[u.pathname]) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(SITES[u.pathname]);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    submissions,
    setLoggedIn: (v) => (loggedIn = v),
    close: () => new Promise((r) => server.close(r)),
  };
}
