// API fallback for Ask: used only when the Claude subscription (LearnHarness's Claude Code connection) reports its
// usage limit. Calls the Anthropic API with the user's key from the Keychain (wise-anthropic / api-key, plus the
// workspace id the key needs), runs the same two course tools, and counts spending against a monthly cap.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { lookupLabel } from './ask.mjs';

export const API_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
// USD per million tokens: [input, output]. Cache reads cost 0.1x input, cache writes 1.25x input.
export const PRICES = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };

export function costOf(model, u) {
  const [i, o] = PRICES[model] || PRICES['claude-sonnet-5-5'];
  return ((u.input_tokens || 0) * i + (u.cache_read_input_tokens || 0) * i * 0.1
    + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.output_tokens || 0) * o) / 1e6;
}

/** Month-to-date API spending, kept in the plugin's data folder: {month: "2026-11", usd}. */
export function makeLedger(dataDir, capUsd) {
  const file = path.join(dataDir, 'api-spend.json');
  const month = () => new Date().toISOString().slice(0, 7);
  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.month === month() ? j : { month: month(), usd: 0 }; }
    catch { return { month: month(), usd: 0 }; }
  };
  return {
    cap: capUsd,
    spent: () => read().usd,
    left: () => Math.max(0, capUsd - read().usd),
    add(usd) {
      const j = read(); j.usd = Math.round((j.usd + usd) * 1e6) / 1e6;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(j)); fs.renameSync(file + '.tmp', file);
      return j.usd;
    },
  };
}

/**
 * One answer through the API. history = [{q, answer}] of earlier turns; tools = courseTools(...).
 * Stops before starting if the ledger has no money left, and between rounds when the cap is reached.
 * Returns {answer, toolTexts, cost, model, searches}.
 */
export async function askViaApi({ apiKey, workspaceId, baseURL, model, system, history, question, tools, ledger, maxRounds = 8, signal }) {
  if (!apiKey) throw new Error('No Anthropic API key in the Keychain (wise-anthropic / api-key).');
  if (ledger.left() <= 0) throw new Error(`The API fallback has reached this month's $${ledger.cap} limit.`);
  const client = new Anthropic({ apiKey, baseURL, maxRetries: 2, timeout: 120000,
    defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages = [];
  for (const h of history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.answer || '(no answer)' });
  messages.push({ role: 'user', content: question });
  let cost = 0;
  const toolTexts = [];
  const searches = [];
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const r = await client.messages.create({
      model, max_tokens: 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: apiTools, messages,
    }, { signal });
    const c = costOf(model, r.usage || {});
    cost += c;
    ledger.add(c);
    if (r.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: r.content });
      const results = [];
      for (const b of r.content.filter((x) => x.type === 'tool_use')) {
        const t = byName.get(b.name);
        searches.push(lookupLabel(b.name, b.input));
        let text;
        try {
          text = t ? (await t.execute(b.id, b.input || {})).content.map((x) => x.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: x.mimeType, data: x.data } }
            : { type: 'text', text: x.text }) : `Unknown tool ${b.name}`;
        }
        catch (e) { text = `Tool error: ${e.message}`; }
        toolTexts.push(typeof text === 'string' ? text : text.filter((x) => x.type === 'text').map((x) => x.text).join('\n'));
        results.push({ type: 'tool_result', tool_use_id: b.id, content: text });
      }
      messages.push({ role: 'user', content: results });
      if (ledger.left() <= 0) throw new Error(`Stopped: the API fallback reached this month's $${ledger.cap} limit.`);
      continue;
    }
    const answer = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
    if (r.stop_reason === 'refusal') return { answer: answer || 'The model declined to answer this.', toolTexts, cost, model, searches };
    return { answer, toolTexts, cost, model, searches, cut: r.stop_reason === 'max_tokens' };
  }
  return { answer: 'Stopped after too many search rounds. Try a narrower question.', toolTexts, cost, model, searches };
}

/** Short, key-free message for an API error. */
export function describeApiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'the API key was refused';
  if (e instanceof Anthropic.RateLimitError) return 'the API is rate limited right now';
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}`.trim();
  return e?.message || String(e);
}
