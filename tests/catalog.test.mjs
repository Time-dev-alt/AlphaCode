/**
 * Model discovery and the user's model pool.
 *
 * The rules under test are the ones the product depends on:
 *   • a catalog that cannot be fetched never breaks the picker;
 *   • a keyless router retries through the same-origin relay, exactly like chat;
 *   • a model the user stars in Settings is attempted before anything ranked;
 *   • merging keeps curated entries the live catalog forgot about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchModels,
  mergeCatalog,
  normalizeModels,
  rankModel,
  bestModels,
  attemptModels,
  poolModels,
  modelsUrl,
  relayModelsUrl,
  FALLBACK_CATALOG,
} from '../web/engine/agent/catalog.js';

const kiloPayload = {
  data: [
    { id: 'kilo-auto/free', name: 'Kilo Auto', context_length: 256000 },
    { id: 'cohere/north-mini-code:free', name: 'North Mini Code' },
    { id: 'some/embedding-model:free', name: 'embedding' },
  ],
};

test('normalise handles the shapes providers actually return', () => {
  assert.equal(normalizeModels(kiloPayload, 'kilo').length, 3);
  assert.equal(normalizeModels([{ id: 'a' }, { id: 'b' }], 'openai').length, 2);
  assert.equal(normalizeModels({ models: [{ id: 'x' }] }, 'opencode')[0].id, 'x');
  assert.deepEqual(normalizeModels({ data: [{ name: '' }, { id: '' }] }, 'kilo'), []);
});

test('duplicate ids collapse', () => {
  const models = normalizeModels({ data: [{ id: 'a' }, { id: 'a' }] }, 'kilo');
  assert.equal(models.length, 1);
});

test('free models are recognised across the router naming schemes', () => {
  const models = normalizeModels({ data: [{ id: 'x:free' }, { id: 'big-pickle' }, { id: 'gpt-4o' }] }, 'kilo');
  assert.equal(models.find((m) => m.id === 'x:free').free, true);
  assert.equal(models.find((m) => m.id === 'big-pickle').free, true);
  assert.equal(models.find((m) => m.id === 'gpt-4o').free, false);
});

test('ranking prefers the router, then coding models, and buries embeddings', () => {
  const router = rankModel({ id: 'kilo-auto/free', context: 256000 });
  const coder = rankModel({ id: 'cohere/north-mini-code:free', context: 256000 });
  const embed = rankModel({ id: 'some/embedding-model:free', context: 8000 });
  assert.ok(router > coder, `${router} > ${coder}`);
  assert.ok(coder > embed);
  const best = bestModels(mergeCatalog('kilo', kiloPayload.data), { limit: 2 });
  assert.equal(best[0].id, 'kilo-auto/free');
  assert.ok(!best.some((m) => /embedding/.test(m.id)));
});

test('the curated catalog survives a live list that forgot entries', () => {
  const merged = mergeCatalog('kilo', kiloPayload.data);
  const ids = merged.map((m) => m.id);
  assert.ok(ids.includes('nvidia/nemotron-3-ultra-550b-a55b:free'), 'curated entry kept');
  assert.ok(ids.every((id, index) => ids.indexOf(id) === index), 'no duplicates');
  // Live data wins on the same id.
  assert.equal(merged.find((m) => m.id === 'kilo-auto/free').name, 'Kilo Auto');
});

test('a bare id in the pool only attaches to the provider that publishes it', () => {
  const kilo = poolModels('kilo', ['big-pickle', 'kilo-auto/free']).map((m) => m.id);
  assert.deepEqual(kilo, ['kilo-auto/free']);
  const opencode = poolModels('opencode', ['big-pickle', 'kilo-auto/free']).map((m) => m.id);
  assert.deepEqual(opencode, ['big-pickle']);
  // An id nobody curates belongs to the relay routers, which is where it came from.
  assert.deepEqual(poolModels('kilo', ['brand-new/model:free']).map((m) => m.id), ['brand-new/model:free']);
  assert.deepEqual(poolModels('openai', ['brand-new/model:free']), []);
});

test('a pool entry with an explicit provider is scoped to it', () => {
  const pool = [{ provider: 'kilo', id: 'stepfun/step-3.7-flash:free' }, { provider: 'opencode', id: 'big-pickle' }];
  assert.deepEqual(poolModels('kilo', pool).map((m) => m.id), ['stepfun/step-3.7-flash:free']);
  assert.deepEqual(poolModels('opencode', pool).map((m) => m.id), ['big-pickle']);
});

test('the pool is attempted before the ranked guesses', () => {
  const models = attemptModels('kilo', { pool: [{ provider: 'kilo', id: 'cohere/north-mini-code:free' }], limit: 2 });
  assert.equal(models[0].id, 'cohere/north-mini-code:free');
  assert.ok(models.length >= 2);
});

test('the chosen model outranks the pool', () => {
  const models = attemptModels('kilo', {
    preferred: 'stepfun/step-3.7-flash:free',
    pool: [{ provider: 'kilo', id: 'cohere/north-mini-code:free' }],
  });
  assert.equal(models[0].id, 'stepfun/step-3.7-flash:free');
  assert.equal(models[1].id, 'cohere/north-mini-code:free');
});

test('the router URL is used for a keyless relay provider', () => {
  assert.equal(modelsUrl('kilo', { baseUrl: 'https://api.kilo.ai/api/gateway', relay: true }), '/api/llm/kilo/models');
  assert.equal(relayModelsUrl('kilo'), '/api/llm/kilo/models');
  assert.equal(relayModelsUrl('openai'), '');
  // A key means BYOK: it goes direct, never through the relay.
  assert.equal(modelsUrl('kilo', { baseUrl: 'https://api.kilo.ai/api/gateway', key: 'sk', relay: true }), 'https://api.kilo.ai/api/gateway/models');
});

test('a successful direct fetch reports live models', async () => {
  const result = await fetchModels({
    provider: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    fetchImpl: async () => new Response(JSON.stringify(kiloPayload), { status: 200 }),
  });
  assert.equal(result.source, 'live');
  assert.equal(result.models.length, 3);
  assert.equal(result.relayed, false);
});

test('a transport failure on a keyless router retries through the relay', async () => {
  const seen = [];
  const result = await fetchModels({
    provider: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).includes('kilo.ai')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(kiloPayload), { status: 200 });
    },
  });
  assert.deepEqual(seen, ['https://api.kilo.ai/api/gateway/models', '/api/llm/kilo/models']);
  assert.equal(result.relayed, true);
  assert.equal(result.models.length, 3);
});

test('a 403 on a keyless router is treated as a transport symptom and retried through the relay', async () => {
  const seen = [];
  const result = await fetchModels({
    provider: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).includes('kilo.ai')) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify(kiloPayload), { status: 200 });
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(result.relayed, true);
  assert.equal(result.models.length, 3);
});

test('a real answer (401/404/429) is reported, not retried', async () => {
  for (const status of [401, 404, 429]) {
    const seen = [];
    const result = await fetchModels({
      provider: 'kilo',
      baseUrl: 'https://api.kilo.ai/api/gateway',
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response('{}', { status });
      },
    });
    assert.equal(seen.length, 1, `${status} must not be retried`);
    assert.match(result.error, new RegExp(String(status)));
  }
});

test('a BYOK provider never retries through the relay', async () => {
  const seen = [];
  const result = await fetchModels({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    key: 'sk-user',
    fetchImpl: async (url) => {
      seen.push(String(url));
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(seen, ['https://api.openai.com/v1/models']);
  assert.equal(result.source, 'error');
  assert.equal(result.models.length, 0);
});

test('fetchModels never throws and reports something usable', async () => {
  const result = await fetchModels({
    provider: 'kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    fetchImpl: async () => {
      throw new TypeError('offline');
    },
  });
  assert.equal(result.source, 'error');
  assert.match(result.error, /could not reach/);
});

test('an HTTP error still counts as a reached endpoint', async () => {
  const result = await fetchModels({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    key: 'sk',
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });
  assert.equal(result.source, 'error');
  assert.match(result.error, /401/);
});

test('every curated catalog has unique ids and a name', () => {
  for (const [provider, list] of Object.entries(FALLBACK_CATALOG)) {
    const ids = list.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${provider} has duplicate ids`);
    for (const model of list) assert.ok(model.name && model.name.length > 1, `${provider}/${model.id} needs a name`);
  }
});
