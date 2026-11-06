import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cfg, { keyStatus } from './config.js';
import { Worker } from './worker.js';

const worker = new Worker(cfg);
const indexHtml = () => fs.readFileSync(path.join(cfg.root, 'public', 'index.html'));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, indexHtml(), 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, worker.getState());

  if (req.method === 'POST') {
    // The page always sends this header; other websites cannot add it, so they cannot control the bot.
    if (req.headers['x-requested-with'] !== 'data-entry-ui') return send(res, 403, { error: 'forbidden' });
    if (url.pathname === '/api/start') {
      const body = await readBody(req);
      await worker.start({ mode: body.mode, limit: Number(body.limit) || 0 });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop') {
      worker.stop();
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
});

// Only reachable from this computer.
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`\nData Entry Bot is ready.\nOpen this page in your browser:  http://localhost:${cfg.port}\n`);
  console.log(`Settings: ${keyStatus(cfg)}`);
  if (!cfg.groqKey && !cfg.anthropicKey) {
    console.log('No AI key found: review mode only. Put the key in the .env file, SAVE it (Cmd+S), then press Start again.\n');
  }
});
