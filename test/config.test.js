import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, buildConfig, keyStatus } from '../src/config.js';

test('parseEnv: handles the ways people really write .env files', () => {
  const text = [
    '﻿# comment',
    'GROQ_API_KEY=gsk_abc123',
    'ANTHROPIC_API_KEY = "sk-ant-xyz"',
    "export CLAUDE_MODEL='some-model'",
    'PORT=3001  # my port',
    'EMPTY=',
    'no equals sign here',
    '',
  ].join('\r\n');
  const v = parseEnv(text);
  assert.equal(v.GROQ_API_KEY, 'gsk_abc123');
  assert.equal(v.ANTHROPIC_API_KEY, 'sk-ant-xyz');
  assert.equal(v.CLAUDE_MODEL, 'some-model');
  assert.equal(v.PORT, '3001');
  assert.equal(v.EMPTY, '');
  assert.equal(Object.keys(v).length, 5);
});

test('buildConfig: reads the key from the .env file in the given folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, '.env'), 'GROQ_API_KEY=gsk_secret_value_1234\n');
  const cfg = buildConfig(dir);
  assert.equal(cfg.groqKey, 'gsk_secret_value_1234');
  assert.equal(cfg.aiMaxChars, 18000); // smaller default when Groq is used
  const status = keyStatus(cfg);
  assert.match(status, /GROQ_API_KEY is set \(21 characters\)/);
  assert.ok(!status.includes('gsk_secret'), 'the key itself must never be printed');
});

test('buildConfig: empty key and missing file are reported clearly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const noFile = buildConfig(dir);
  assert.equal(noFile.envFileFound, false);
  assert.match(keyStatus(noFile), /\.env NOT found/);
  fs.writeFileSync(path.join(dir, '.env'), 'GROQ_API_KEY=\n');
  const empty = buildConfig(dir);
  assert.equal(empty.groqKey, '');
  assert.match(keyStatus(empty), /GROQ_API_KEY is empty/);
});
