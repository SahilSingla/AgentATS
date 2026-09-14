const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('AiGateway.gs', 'utf8');
const g = (text = '{"ok":true}', finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
const a = (text = '{"ok":true}', stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }] });
const models = [{ provider: 'anthropic', model: 'claude-test' }, { provider: 'gemini', model: 'gemini-test' }];
function harness(config = {}, replies = [], properties = {}) {
  let now = 0; const calls = [], logs = [], sleeps = [];
  const props = { AI_CONFIG: JSON.stringify({ default: models, ...config }), ANTHROPIC_API_KEY: 'test-anthropic-key', GEMINI_KEY: 'test-gemini-key', ...properties };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
    Logger: { log: s => logs.push(JSON.parse(s)) }, Utilities: { sleep: ms => { sleeps.push(ms); now += ms; } },
    Date: class extends Date { static now() { return now; } }, Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    UrlFetchApp: { fetch: (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.payload) });
      const next = replies.shift(); if (!next) throw Error('Unexpected fetch');
      now += next.elapsed || 10; if (next.error) throw Error(next.error);
      return { getResponseCode: () => next.status || 200, getAllHeaders: () => next.headers || {}, getContentText: () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
    } }
  });
  vm.runInContext(source, context);
  return { context, calls, logs, sleeps, run: (task = 'cv_scoring', request = { prompt: 'Synthetic input', json: true }) => context.aiRequest_(task, request) };
}
test('priority: rate limit retries with backoff then Gemini succeeds; sanitized logs', () => {
  const h = harness({}, [{ status: 429, body: 'PII in provider error' }, { status: 503 }, { body: g() }]);
  assert.equal(h.run(), '{"ok":true}'); assert.equal(h.calls.length, 3); assert.deepEqual(h.sleeps, [500]);
  assert.match(h.calls[0].url, /anthropic/); assert.match(h.calls[2].url, /googleapis/);
  assert.equal(h.logs[2].fallbackIndex, 1); assert.equal(h.logs[2].latencyMs, 10);
  assert.doesNotMatch(JSON.stringify(h.logs), /Synthetic|PII|test-anthropic-key|test-gemini-key/);
});
test('default remains Gemini-compatible and old wrapper works', () => {
  const h = harness({}, [{ body: g() }], { AI_CONFIG: '' });
  assert.equal(h.context.callGemini('Synthetic', true), '{"ok":true}'); assert.match(h.calls[0].url, /gemini-2.5-flash:generateContent/);
  assert.equal(h.calls[0].body.generationConfig.responseMimeType, 'application/json');
});
test('per-task override replaces global route', () => {
  const h = harness({ tasks: { cv_parsing: [models[1]] } }, [{ body: g() }]);
  h.run('cv_parsing'); assert.match(h.calls[0].url, /gemini-test/);
});
for (const status of [400, 401, 403, 404, 413, 422]) test('permanent HTTP ' + status + ' stops without fallback', () => {
  const h = harness({}, [{ status, body: 'sensitive' }]); assert.throws(() => h.run(), /AI request failed/); assert.equal(h.calls.length, 1);
});
test('explicit deterministic fallback opt-in', () => {
  const h = harness({ fallbackOn: ['input'] }, [{ status: 400 }, { body: g() }]); h.run(); assert.equal(h.calls.length, 2); assert.deepEqual(h.sleeps, []);
});
for (const body of ['{', a('not json'), a('null'), a('42'), a('{}', 'max_tokens'), a('')]) test('invalid/truncated response advances models', () => {
  const h = harness({}, [{ body }, { body: g() }]); assert.equal(h.run(), '{"ok":true}'); assert.equal(h.calls.length, 2); assert.equal(h.logs[0].category, 'invalid_response');
});
test('schema failure advances; valid fenced JSON normalized', () => {
  const h = harness({}, [{ body: a('{}') }, { body: g('```json\n{"score":55}\n```') }]);
  assert.equal(h.run('cv_scoring', { prompt: 'Synthetic', json: true, validate: x => typeof x.score === 'number' }), '{"score":55}');
});
test('validator exception is an application error, not bad model output', () => {
  const h = harness({}, [{ body: a() }]); assert.throws(() => h.run('cv_scoring', { prompt: 'Synthetic', json: true, validate: () => { throw Error('private'); } }), /application/); assert.equal(h.calls.length, 1);
});
for (const error of ['Request timed out', 'DNS error', 'Connection reset']) test('retryable transport: ' + error, () => {
  const h = harness({}, [{ error }, { body: a() }]); h.run(); assert.equal(h.calls.length, 2);
});
test('Apps Script quota errors do not consume fallback calls', () => {
  const h = harness({}, [{ error: 'Service invoked too many times for one day: urlfetch' }]); assert.throws(() => h.run(), /local_quota/); assert.equal(h.calls.length, 1);
});
test('unknown transport/application exception stops safely', () => {
  const h = harness({}, [{ error: 'Invalid argument with sensitive details' }]); assert.throws(() => h.run(), /application/); assert.equal(h.calls.length, 1);
});
test('long Retry-After advances without hammering the same model', () => {
  const h = harness({}, [{ status: 429, headers: { 'Retry-After': '60' } }, { body: g() }]); h.run(); assert.deepEqual(h.sleeps, []); assert.equal(h.calls.length, 2);
});
test('short Retry-After is honored', () => {
  const h = harness({}, [{ status: 429, headers: { 'retry-after': '2' } }, { body: a() }]); h.run(); assert.deepEqual(h.sleeps, [2000]);
});
test('attempt cap includes retries and fallback', () => {
  const h = harness({ maxAttempts: 2 }, [{ status: 500 }, { status: 503 }]); assert.throws(() => h.run(), /attempt_budget/); assert.equal(h.calls.length, 2);
});
test('execution cap spans multiple tasks', () => {
  const h = harness({ executionMaxAttempts: 1 }, [{ body: a() }]); h.run(); assert.throws(() => h.run('other'), /attempt_budget/); assert.equal(h.calls.length, 1);
});
test('soft deadline prevents starting more requests', () => {
  const h = harness({ budgetMs: 1000 }, [{ status: 503, elapsed: 1200 }]); assert.throws(() => h.run(), /attempt_budget/); assert.equal(h.calls.length, 1);
});
test('safety refusals do not fail over', () => {
  const h = harness({}, [{ body: a('', 'refusal') }]); assert.throws(() => h.run(), /safety/); assert.equal(h.calls.length, 1);
  const j = harness({ default: [models[1], models[0]] }, [{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]); assert.throws(() => j.run(), /safety/); assert.equal(j.calls.length, 1);
});
test('Claude PDF and images translated correctly', () => {
  const h = harness({}, [{ body: a() }]); h.run('cv_parsing', { prompt: 'Synthetic', json: true, attachments: [{ mimeType: 'application/pdf', data: 'YWJj' }, { mimeType: 'image/png', data: 'YWJj' }] });
  assert.equal(h.calls[0].body.messages[0].content[0].type, 'document'); assert.equal(h.calls[0].body.messages[0].content[1].type, 'image'); assert.equal(h.calls[0].opts.headers['anthropic-version'], '2023-06-01');
});
test('Claude audio capability skipped without HTTP call', () => {
  const h = harness({}, [{ body: g() }]); h.run('audio_transcription', { prompt: 'Synthetic', json: true, attachments: [{ mimeType: 'audio/mpeg', data: 'YWJj' }] });
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /googleapis/); assert.equal(h.logs[0].category, 'unsupported_capability');
});
test('embedding route stays in one coordinate space', () => {
  const h = harness({}, [{ body: { embedding: { values: [0.1, 0.2] } } }]); assert.equal(h.run('embedding', { prompt: 'Synthetic', embedding: true }), '[0.1,0.2]'); assert.match(h.calls[0].url, /text-embedding-004:embedContent/);
  const j = harness({ tasks: { embedding: models } }); assert.throws(() => j.run('embedding', { prompt: 'Synthetic', embedding: true }), /configuration/); assert.equal(j.calls.length, 0);
});
for (const config of [{ default: [] }, { maxAttempts: 100 }, { default: [{ provider: 'unknown', model: 'foo' }] }, { tasks: null }, { retriesPerModel: -1 }, { fallbackOn: ['safety'] }, { default: [models[0], models[0]] }]) test('bad configuration fails before fetch ' + JSON.stringify(config), () => {
  const h = harness(config); assert.throws(() => h.run(), /configuration/); assert.equal(h.calls.length, 0);
});
test('invalid local input fails before fetch', () => {
  const h = harness(); assert.throws(() => h.run('cv_parsing', { prompt: '' }), /input/); assert.equal(h.calls.length, 0);
});
test('all Apps Script source parses and Code uses named gateway routes', () => {
  for (const file of ['Code.gs', 'AiGateway.gs', 'TalentRubric.gs', 'CvForwarder.gs']) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  const code = fs.readFileSync('Code.gs', 'utf8'); assert.doesNotMatch(code, /callGemini\(|geminiRequest_\(|generativelanguage.googleapis.com/);
  for (const task of ['cv_parsing', 'cv_scoring', 'interview_questions', 'audio_transcription']) assert.ok(code.includes("'" + task + "'"));
});
test('legacy callGemini JSON arrays remain compatible', () => {
  const h = harness({}, [{ body: a('[1,2]') }]); assert.equal(h.context.callGemini('Synthetic', true), '[1,2]');
});
test('actual document and sourced-scoring call sites fall back on invalid structures', () => {
  const h = harness({}, [{ body: a('{"doc_type":"resume"}') }, { body: g('{"doc_type":"resume","name":"Synthetic","email":""}') }]);
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), h.context);
  const parsed = JSON.parse(h.context.parseDocument_('YWJj', 'application/pdf'));
  assert.equal(parsed.name, 'Synthetic'); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].body.generationConfig.temperature, 0);
  const j = harness({}, [{ body: a('[200]') }, { body: g('[55]') }]);
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), j.context);
  const items = [{ title: 'Synthetic', text: 'Sample' }]; j.context.scoreSourced_(items, 'Synthetic job'); assert.equal(items[0].score, 55); assert.equal(j.calls.length, 2);
});
test('critical validators reject malformed and duplicate scoring records', () => {
  const h = harness(); const rank = h.context.aiRankingValid_(2);
  assert.equal(rank({ ranking: [{ id: 'C0', score: 20, reason: '' }, { id: 'C00', score: 30, reason: '' }] }), false);
  assert.equal(rank({ ranking: [{ id: 'C0', score: 20, reason: '' }, { id: 'C1', score: 30, reason: '' }] }), true);
  assert.equal(h.context.aiRubricValid_(2)({ scores: { 0: 2 }, gate: true, summary: '' }), false);
});
test('Gemini joins visible parts but excludes thoughts', () => {
  const body = g(); body.candidates[0].content.parts = [{ thought: true, text: 'private reasoning' }, { text: '{"ok":' }, { text: 'true}' }];
  const h = harness({ default: [models[1]] }, [{ body }]); assert.equal(h.run(), '{"ok":true}');
});
test('deadline across calls and HTTP-date Retry-After', () => {
  const h = harness({ executionBudgetMs: 1000 }, [{ body: a(), elapsed: 1100 }]); h.run(); assert.throws(() => h.run(), /attempt_budget/);
  const j = harness({}, [{ status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:02 GMT' } }, { body: a() }]); j.run(); assert.deepEqual(j.sleeps, [1990]);
});
