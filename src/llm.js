import Anthropic from '@anthropic-ai/sdk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Groq (free tier). Talks to Groq's OpenAI-compatible chat endpoint. ------------------------
// Models tried in this order when the chosen one is not available to the account.
const MODEL_PREFERENCE = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'llama-3.1-8b-instant'];
const NOT_CHAT = /whisper|tts|guard|orpheus|playai|safeguard|embed|vision-preview|distil/i;

export function pickModel(available, current) {
  const ids = available.filter((m) => !NOT_CHAT.test(m) && m !== current);
  for (const want of MODEL_PREFERENCE) if (ids.includes(want)) return want;
  return ids.find((m) => /llama|gpt-oss|qwen|gemma|mixtral|kimi/i.test(m)) ?? ids[0] ?? '';
}

function makeGroq(cfg) {
  const base = cfg.groqBaseUrl.replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  let triedModelSwitch = false;
  let noReasoningParam = false;

  async function listModels() {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.groqKey}` } });
    if (!res.ok) throw new Error(`could not list models (${res.status})`);
    const data = await res.json();
    return (data.data ?? []).map((m) => m.id);
  }

  async function call(system, user, jsonMode) {
    const body = {
      model: cfg.groqModel,
      temperature: 0,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    // Reasoning models spend tokens thinking: keep it short so the JSON answer is not cut off.
    if (/gpt-oss/i.test(cfg.groqModel) && !noReasoningParam) body.reasoning_effort = 'low';
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.groqKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const why = e?.cause?.code || e?.cause?.message || e.message;
      throw new Error(`Could not reach Groq (${why}). Check the internet connection, VPN or firewall.`);
    }
  }

  return async function ask(system, user) {
    let jsonMode = true;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await call(system, user, jsonMode);
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
      }
      const detail = (await res.text()).slice(0, 300);
      // Rate limited: wait as long as Groq asks (up to 60 s), then try again.
      if (res.status === 429 && attempt < 4) {
        const wait = Math.min(60, Number(res.headers.get('retry-after')) || 10 * attempt);
        await sleep(wait * 1000);
        continue;
      }
      // Some models do not support JSON mode: try again without it.
      if (res.status === 400 && jsonMode && /response_format|json/i.test(detail)) {
        jsonMode = false;
        continue;
      }
      if (res.status === 400 && !noReasoningParam && /reasoning/i.test(detail)) {
        noReasoningParam = true;
        continue;
      }
      // The account has no access to this model: ask Groq which models it does have and switch.
      if ((res.status === 404 || res.status === 403) && /model/i.test(detail) && /does not exist|not have access|not found|decommission|deprecat/i.test(detail) && !triedModelSwitch) {
        triedModelSwitch = true;
        const models = await listModels();
        const next = pickModel(models, cfg.groqModel);
        if (!next) throw new Error(`Your Groq account has no usable chat model. It lists: ${models.join(', ') || 'nothing'}.`);
        cfg.groqModel = next;
        cfg.groqModelSwitched = true;
        continue;
      }
      if (res.status === 401) throw new Error('Groq says the API key is not valid (check GROQ_API_KEY in .env).');
      if (res.status === 403) {
        throw new Error(
          `Groq refused the request (403 Forbidden). The key may be fine, but Groq blocks some countries and networks. Try with a VPN switched on, or use another provider. Details: ${detail.slice(0, 120)}`,
        );
      }
      if (res.status === 413 || /too large|tokens per minute|TPM/i.test(detail)) {
        throw new Error('Too much text for the Groq free limit. Lower AI_MAX_CHARS in .env (for example 10000).');
      }
      throw new Error(`Groq error ${res.status}: ${detail}`);
    }
    throw new Error('Groq is rate limiting. Try again in a minute.');
  };
}

// ---- Claude (paid). -------------------------------------------------------------------------------
function makeClaudeApi(cfg) {
  const client = new Anthropic({ apiKey: cfg.anthropicKey });
  return async function ask(system, user) {
    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: 2000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };
}

// Returns an async function (system, user) => text, or null when there is no key at all.
export function makeLlm(cfg) {
  if (cfg.groqKey) return makeGroq(cfg);
  if (cfg.anthropicKey) return makeClaudeApi(cfg);
  return null;
}

export const providerName = (cfg) => (cfg.groqKey ? `Groq (${cfg.groqModel})` : cfg.anthropicKey ? `Claude (${cfg.model})` : 'none');
