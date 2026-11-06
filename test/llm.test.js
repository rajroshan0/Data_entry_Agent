import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import cfgBase from '../src/config.js';
import { makeLlm, providerName, pickModel } from '../src/llm.js';
import { runExtraction, buildPrompt } from '../src/extractor.js';

// Tiny fake Groq server. `script` is a list of responses given in order.
async function fakeGroq(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      res.writeHead(step.status, { 'Content-Type': 'application/json', ...(step.headers ?? {}) });
      res.end(JSON.stringify(step.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    baseUrl: `http://127.0.0.1:${server.address().port}/openai/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const ok = (content) => ({ status: 200, json: { choices: [{ message: { content } }] } });

test('groq: sends the right request and returns the answer', async () => {
  const g = await fakeGroq([ok('{"kind":"Trader"}')]);
  const cfg = { ...cfgBase, groqKey: 'gsk_test', anthropicKey: '', groqBaseUrl: g.baseUrl };
  const llm = makeLlm(cfg);
  assert.equal(await llm('SYS', 'USER'), '{"kind":"Trader"}');
  const req = g.seen[0];
  assert.equal(req.url, '/openai/v1/chat/completions');
  assert.equal(req.auth, 'Bearer gsk_test');
  assert.equal(req.body.model, 'llama-3.3-70b-versatile');
  assert.equal(req.body.temperature, 0);
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(providerName(cfg), /Groq/);
  await g.close();
});

test('groq: waits and retries when rate limited (429)', { timeout: 15000 }, async () => {
  const g = await fakeGroq([{ status: 429, headers: { 'retry-after': '1' }, json: { error: 'slow down' } }, ok('{"a":1}')]);
  const llm = makeLlm({ ...cfgBase, groqKey: 'k', anthropicKey: '', groqBaseUrl: g.baseUrl });
  assert.equal(await llm('s', 'u'), '{"a":1}');
  assert.equal(g.seen.length, 2);
  await g.close();
});

test('groq: retries without JSON mode when the model does not support it', async () => {
  const g = await fakeGroq([{ status: 400, json: { error: { message: 'response_format is not supported' } } }, ok('{"a":2}')]);
  const llm = makeLlm({ ...cfgBase, groqKey: 'k', anthropicKey: '', groqBaseUrl: g.baseUrl });
  assert.equal(await llm('s', 'u'), '{"a":2}');
  assert.equal(g.seen[1].body.response_format, undefined);
  await g.close();
});

test('groq: bad key and too-much-text give clear messages', async () => {
  const bad = await fakeGroq([{ status: 401, json: { error: 'invalid' } }]);
  await assert.rejects(makeLlm({ ...cfgBase, groqKey: 'k', anthropicKey: '', groqBaseUrl: bad.baseUrl })('s', 'u'), /GROQ_API_KEY/);
  await bad.close();
  const big = await fakeGroq([{ status: 413, json: { error: 'Request too large' } }]);
  await assert.rejects(makeLlm({ ...cfgBase, groqKey: 'k', anthropicKey: '', groqBaseUrl: big.baseUrl })('s', 'u'), /AI_MAX_CHARS/);
  await big.close();
});

test('no keys -> no AI; Groq wins when both keys are set', () => {
  assert.equal(makeLlm({ ...cfgBase, groqKey: '', anthropicKey: '' }), null);
  assert.match(providerName({ ...cfgBase, groqKey: 'g', anthropicKey: 'a' }), /Groq/);
});

test('runExtraction: an AI failure is flagged, does not crash, and falls back to keyword rules', async () => {
  const visit = {
    inputUrl: 'http://a.test',
    finalUrl: 'http://a.test/',
    pages: [{ url: 'http://a.test/', title: 'A', text: 'Mail info@a.test Tel +44 1554 779090', links: [], mailtos: [], tels: [], imgs: [] }],
  };
  const r = await runExtraction({
    visit,
    llm: async () => {
      throw new Error('Groq is rate limiting.');
    },
  });
  assert.equal(r.extraction.kind, 'Other'); // page has no business words; the person checks it
  assert.equal(r.extraction.email, 'info@a.test');
  assert.ok(r.flags.includes('ai-error'));
  assert.ok(r.flags.includes('kind-guessed-by-keywords'));
  assert.match(r.aiError, /rate limiting/);
});

test('buildPrompt: page text is capped to the character budget', () => {
  const long = 'x'.repeat(20000);
  const mk = (u) => ({ url: u, title: 't', text: long, links: [], mailtos: [], tels: [], imgs: [] });
  const visit = { inputUrl: 'http://a.test', finalUrl: 'http://a.test/', pages: [mk('http://a.test/'), mk('http://a.test/contact'), mk('http://a.test/about')] };
  const prompt = buildPrompt(visit, { emails: [], phones: [] }, 9000);
  assert.ok(prompt.length < 9000 + 3000, `prompt too long: ${prompt.length}`);
  // contact page comes first
  assert.ok(prompt.indexOf('/contact') < prompt.indexOf('/about'));
});

test('llm: 403 gives a clear region/VPN message', async () => {
  const srv = http.createServer((_q, res) => { res.writeHead(403); res.end('Access denied'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const llm = makeLlm({ groqKey: 'k', groqModel: 'm', groqBaseUrl: `http://127.0.0.1:${srv.address().port}/v1` });
  await assert.rejects(llm('s', 'u'), /403 Forbidden.*VPN/s);
  srv.close();
});

test('llm: unreachable server gives a readable message', async () => {
  const llm = makeLlm({ groqKey: 'k', groqModel: 'm', groqBaseUrl: 'http://127.0.0.1:1/v1' });
  await assert.rejects(llm('s', 'u'), /Could not reach Groq/);
});

test('groq: model not available to the account -> asks which models exist, switches, and works', async () => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/models')) {
        calls.push('models');
        return res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }, { id: 'meta-llama/llama-guard-4-12b' }] }));
      }
      const b = JSON.parse(body);
      calls.push(b.model);
      if (b.model === 'llama-3.3-70b-versatile') {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', code: 'model_not_found' } }));
      }
      assert.equal(b.reasoning_effort, 'low'); // gpt-oss thinks less so the JSON is not cut off
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { ...cfgBase, groqKey: 'gsk_test', anthropicKey: '', groqBaseUrl: `http://127.0.0.1:${srv.address().port}/openai/v1` };
  const llm = makeLlm(cfg);
  assert.equal(await llm('s', 'u'), '{"ok":true}');
  assert.deepEqual(calls, ['llama-3.3-70b-versatile', 'models', 'openai/gpt-oss-120b']);
  assert.equal(cfg.groqModel, 'openai/gpt-oss-120b');
  // the second request goes straight to the new model
  await llm('s', 'u');
  assert.equal(calls.at(-1), 'openai/gpt-oss-120b');
  assert.equal(calls.filter((c) => c === 'models').length, 1);
  srv.close();
});

test('pickModel: ignores speech / guard models and follows the preference list', () => {
  assert.equal(pickModel(['whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], 'x'), 'llama-3.3-70b-versatile');
  assert.equal(pickModel(['whisper-large-v3', 'meta-llama/llama-guard-4-12b', 'some-llama-model'], 'x'), 'some-llama-model');
  assert.equal(pickModel(['whisper-large-v3'], 'x'), '');
});
