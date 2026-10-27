// OpenRouter tags + summary. On any failure the user is told and tags/description stay
// EMPTY: no heuristic fallback, by design.
import type { Config } from './config.js';
import { isVerbose, startTask } from './status.js';
import { normalizeTag, warn } from './util.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const prompt = (title: string, content: string) =>
  'You are given a web article. Return STRICT JSON only, no markdown fences, with exactly these keys:\n' +
  '{"tags": ["word1", "word2", "word3"], "summary": "one short paragraph"}\n' +
  "Rules for tags: exactly 3 tags, each a SINGLE lowercase word (letters a-z only, no spaces, no hyphens), describing the article's topic.\n" +
  "Rules for summary: 2-3 sentences, plain text, no quotes escapes issues, capturing the article's main points.\n\n" +
  `Article title: ${title}\n\nArticle content:\n${content}`;

export async function openrouterComplete(cfg: Config, text: string): Promise<string> {
  const orc = cfg.openrouter;
  const key = process.env.OPENROUTER_API_KEY || orc.api_key;
  if (!key) throw new Error('no OpenRouter API key (set openrouter.api_key in config or OPENROUTER_API_KEY env)');
  let r: Response;
  try {
    r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      redirect: 'error', // never forward an authenticated request through a redirect
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: orc.model || 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: text }], temperature: 0.3 }),
      signal: AbortSignal.timeout((Number(orc.timeout) || 60) * 1000),
    });
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    throw new Error(`OpenRouter request failed: ${err.cause?.message ?? err.message}`);
  }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`OpenRouter HTTP ${r.status}`); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!r.body) throw new Error('OpenRouter returned no body');
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('OpenRouter response exceeds 2 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { choices?: { message?: { content?: string } }[] };
  const out = data.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error('unexpected OpenRouter response shape');
  return out;
}

export function parseTagsSummary(raw: string): { tags: string[]; summary: string } {
  raw = raw.trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
  const data = JSON.parse(raw) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('response is not a JSON object');
  const { tags: rawTags, summary: rawSummary } = data as { tags?: unknown; summary?: unknown };
  if (!Array.isArray(rawTags) || !rawTags.every(t => typeof t === 'string')) throw new Error('tags must be a list of strings');
  if (typeof rawSummary !== 'string') throw new Error('summary must be a string');
  // Strip control characters (tab allowed), cap length.
  const summary = rawSummary.replace(/[\u0000-\u0008\u000a-\u001f]/g, '').trim().slice(0, 1000);
  const tags = [...new Set((rawTags as string[]).map(normalizeTag).filter(Boolean))].slice(0, 3);
  if (!tags.length || !summary) throw new Error('empty tags or summary in LLM response');
  return { tags, summary };
}

export async function llmTagsSummary(title: string, content: string, cfg: Config): Promise<{ tags: string[]; summary: string } | null> {
  if (!cfg.openrouter.enabled) return null;
  const task = startTask(`tags + summary via OpenRouter/${cfg.openrouter.model}`);
  let raw: string;
  try {
    raw = await openrouterComplete(cfg, prompt(title.slice(0, 1000), content.slice(0, 15000))); // cap: keep it cheap
  } catch (e) {
    task.fail();
    warn(`OpenRouter call failed — tags and description left empty. (${(e as Error).message})`);
    return null;
  }
  try {
    const out = parseTagsSummary(raw);
    task.done(`${out.tags.join(', ')}${isVerbose() ? ` + ${out.summary.length}-char summary` : ''}`);
    return out;
  } catch (e) {
    task.fail();
    warn(`could not parse OpenRouter response — tags and description left empty. (${(e as Error).message})`);
    return null;
  }
}
