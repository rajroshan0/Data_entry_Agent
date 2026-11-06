import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Reads settings from the ".env" file in the project folder. Written by hand (no Node version
// needed) and tolerant: quotes, "export ", spaces around "=", Windows line endings, a BOM.
export function parseEnv(text) {
  const out = {};
  for (let line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // "abc  # note" -> "abc"
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(dir = root) {
  const file = path.join(dir, '.env');
  try {
    return { file, found: true, values: parseEnv(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { file, found: false, values: {} };
  }
}

// Builds the settings. Values in the .env file win over computer-wide environment variables.
export function buildConfig(dir = root) {
  const dot = loadDotEnv(dir);
  const env = (key, fallback) => {
    const v = dot.values[key] || process.env[key];
    return v !== undefined && v !== '' ? v : fallback;
  };
  const groqKey = env('GROQ_API_KEY', '');

  return {
    root,
    envFile: dot.file,
    envFileFound: dot.found,

    // Portal
    portalUrl: env('PORTAL_URL', 'http://copypaste.onlineurls.com/'),

    // Local control page
    port: Number(env('PORT', 3000)),

    // AI used to read page text. Groq (free tier) is used when GROQ_API_KEY is set, otherwise Claude
    // when ANTHROPIC_API_KEY is set. Without any key the tool still runs, but only in review mode
    // and you choose Kind of Business yourself.
    groqKey,
    groqModel: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    groqBaseUrl: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    anthropicKey: env('ANTHROPIC_API_KEY', ''),
    model: env('CLAUDE_MODEL', 'claude-sonnet-5-5'),
    // Most page text sent to the AI per website (characters). Free tiers have small per-minute limits.
    aiMaxChars: Number(env('AI_MAX_CHARS', groqKey ? 18000 : 60000)),

    // Browser
    profileDir: path.join(root, 'browser-profile'), // your portal login is saved here
    useSystemChrome: env('USE_SYSTEM_CHROME', 'true') !== 'false',
    headless: env('HEADLESS', 'false') === 'true',

    // Site visiting
    maxPages: Number(env('MAX_PAGES', 5)), // home + up to N-1 contact/about/product pages
    navTimeoutMs: Number(env('NAV_TIMEOUT_MS', 30000)),
    pageTextLimit: 12000, // characters kept per page

    // Rules you can change without touching code
    parkedStatus: env('PARKED_STATUS', 'Not Working'), // status for parked / for-sale domains
    redirectAsStatus: env('REDIRECT_AS_STATUS', 'false') === 'true', // 'Redirect Site' when domain changes
    stripPhonePunctuation: env('STRIP_PHONE_PUNCTUATION', 'false') === 'true', // true: keep only + and digits

    // How long the bot waits for the portal to show the next website
    urlWaitMs: Number(env('URL_WAIT_MS', 15000)),

    // Output
    outDir: path.join(root, 'output'),

    // How long to wait for you to click submit in review mode
    reviewTimeoutMs: 15 * 60 * 1000,
  };
}

// The AI-related settings, re-read from .env each time you press Start (no restart needed).
export const AI_KEYS = ['groqKey', 'groqModel', 'groqBaseUrl', 'anthropicKey', 'model', 'aiMaxChars', 'envFile', 'envFileFound'];

export function aiSettingsNow() {
  const fresh = buildConfig();
  return Object.fromEntries(AI_KEYS.map((k) => [k, fresh[k]]));
}

// One line telling you what the bot found (never shows the key itself).
export function keyStatus(cfg) {
  const file = cfg.envFileFound ? `.env found (${cfg.envFile})` : `.env NOT found (looked for ${cfg.envFile})`;
  const g = cfg.groqKey ? `GROQ_API_KEY is set (${cfg.groqKey.length} characters)` : 'GROQ_API_KEY is empty';
  const a = cfg.anthropicKey ? ', ANTHROPIC_API_KEY is set' : '';
  return `${file}; ${g}${a}`;
}

export default buildConfig();
