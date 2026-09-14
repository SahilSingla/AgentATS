// Provider-neutral AI transport. All helpers are private to Apps Script clients.
// Configuration and credentials are read only from Script Properties; see AI_GATEWAY.md.
var AI_EXECUTION_ = null;
function aiError_(category) {
  var e = new Error('AI request failed (' + category + '). Check AI configuration or try again.');
  e.aiCategory = category; return e;
}
function aiConfig_() {
  var props = PropertiesService.getScriptProperties(), raw = props.getProperty('AI_CONFIG'), c;
  try { c = raw ? JSON.parse(raw) : {}; } catch (e) { throw aiError_('configuration'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw aiError_('configuration');
  var defaults = [{ provider: 'gemini', model: props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash' }, { provider: 'gemini', model: 'gemini-2.5-flash-lite' }];
  c.default = c.default === undefined ? defaults : c.default;
  c.tasks = c.tasks === undefined ? {} : c.tasks;
  if (!c.tasks || typeof c.tasks !== 'object' || Array.isArray(c.tasks)) throw aiError_('configuration');
  function route(r) {
    if (!Array.isArray(r) || !r.length || r.length > 8) throw aiError_('configuration');
    var seen = {};
    r.forEach(function (m) {
      if (!m || ['gemini', 'anthropic'].indexOf(m.provider) < 0 || typeof m.model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(m.model)) throw aiError_('configuration');
      var id = m.provider + ':' + m.model; if (seen[id]) throw aiError_('configuration'); seen[id] = true;
    });
  }
  route(c.default); Object.keys(c.tasks).forEach(function (k) { if (!/^[a-zA-Z0-9_]{1,60}$/.test(k)) throw aiError_('configuration'); route(c.tasks[k]); });
  function number(k, d, min, max) {
    var n = c[k] === undefined ? d : c[k];
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw aiError_('configuration'); c[k] = n;
  }
  number('maxAttempts', 4, 1, 8); number('retriesPerModel', 1, 0, 2);
  number('budgetMs', 60000, 1000, 120000); number('executionBudgetMs', 180000, 1000, 240000);
  number('executionMaxAttempts', 20, 1, 50); number('baseDelayMs', 500, 0, 5000);
  number('maxDelayMs', 4000, 0, 10000); number('maxTokens', 4096, 256, 16384);
  if (c.baseDelayMs > c.maxDelayMs) throw aiError_('configuration');
  c.fallbackOn = c.fallbackOn === undefined ? [] : c.fallbackOn;
  if (!Array.isArray(c.fallbackOn) || c.fallbackOn.some(function (x) { return ['input', 'authentication', 'model_unavailable', 'application'].indexOf(x) < 0; })) throw aiError_('configuration');
  return c;
}
function callAI_(task, prompt, jsonMode, validate) {
  return aiRequest_(task, { prompt: prompt, json: !!jsonMode, validate: validate || (jsonMode ? aiObject_ : undefined) });
}
function aiDocument_(task, prompt, data, mimeType, validate) {
  return aiRequest_(task, { prompt: prompt, json: true, temperature: task === 'cv_parsing' ? 0 : 0.1, attachments: [{ data: data, mimeType: mimeType }], validate: validate });
}
function aiRequest_(task, request) {
  var c = aiConfig_();
  if (!/^[a-zA-Z0-9_]{1,60}$/.test(task) || !request || typeof request.prompt !== 'string' || !request.prompt.trim()) throw aiError_('input');
  if (request.validate !== undefined && typeof request.validate !== 'function') throw aiError_('application');
  if (request.attachments !== undefined && !Array.isArray(request.attachments)) throw aiError_('input');
  (request.attachments || []).forEach(function (a) {
    if (!a || typeof a.data !== 'string' || !a.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data) || typeof a.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType)) throw aiError_('input');
  });
  var started = Date.now();
  if (!AI_EXECUTION_) AI_EXECUTION_ = { started: started, attempts: 0 };
  var deadline = Math.min(started + c.budgetMs, AI_EXECUTION_.started + c.executionBudgetMs);
  var route = Object.prototype.hasOwnProperty.call(c.tasks, task) ? c.tasks[task] : (task === 'embedding' ? [{ provider: 'gemini', model: 'text-embedding-004' }] : c.default);
  // A vector pair must stay in one model's coordinate space. Retry, but never mix embedding models.
  if (task === 'embedding' && (route.length !== 1 || route[0].provider !== 'gemini')) throw aiError_('configuration');
  var attempts = 0, last = aiError_('unsupported_capability');
  function available() { return attempts < c.maxAttempts && AI_EXECUTION_.attempts < c.executionMaxAttempts && Date.now() < deadline; }
  function log(m, event, category, latency, index) {
    Logger.log(JSON.stringify({ event: 'ai_' + event, task: task, provider: m.provider, model: m.model, latencyMs: latency,
      category: category, attempt: attempts, fallbackIndex: index, elapsedMs: Date.now() - started }));
  }
  for (var i = 0; i < route.length; i++) {
    var m = route[i];
    if (m.provider === 'anthropic' && (request.attachments || []).some(function (a) { return ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].indexOf(a.mimeType) < 0; })) {
      log(m, 'skip', 'unsupported_capability', 0, i); continue;
    }
    for (var retry = 0; retry <= c.retriesPerModel; retry++) {
      if (!available()) throw aiError_('attempt_budget');
      var t = Date.now(); attempts++; AI_EXECUTION_.attempts++;
      try {
        var result = aiFetch_(m, request, c);
        if (request.json) {
          var parsed;
          try { parsed = JSON.parse(result.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); } catch (e) { throw aiError_('invalid_response'); }
          if (!parsed || typeof parsed !== 'object') throw aiError_('invalid_response');
          if (request.validate) {
            var valid;
            try { valid = request.validate(parsed); } catch (e) { throw aiError_('application'); }
            if (valid !== true) throw aiError_('invalid_response');
          }
          result = JSON.stringify(parsed);
        }
        log(m, 'success', null, Date.now() - t, i); return result;
      } catch (e) {
        last = e.aiCategory ? e : aiError_('application');
        log(m, 'failure', last.aiCategory, Date.now() - t, i);
        var transient = ['rate_limit', 'timeout', 'outage', 'transport'].indexOf(last.aiCategory) >= 0;
        var fallback = transient || last.aiCategory === 'invalid_response' || c.fallbackOn.indexOf(last.aiCategory) >= 0;
        if (!fallback) throw last;
        // Try malformed output on the next model immediately, not on the same model.
        if (!transient || retry === c.retriesPerModel || !available()) break;
        var delay = Math.min(c.maxDelayMs, c.baseDelayMs * Math.pow(2, retry) * (0.75 + Math.random() * 0.5));
        if (last.retryAfterMs != null) {
          // Do not retry this model earlier than its server asks. Move to the next model instead.
          if (last.retryAfterMs > c.maxDelayMs) break;
          delay = Math.max(delay, last.retryAfterMs);
        }
        if (Date.now() + delay >= deadline) break;
        Utilities.sleep(Math.ceil(delay));
      }
    }
  }
  throw last;
}
function aiFetch_(m, r, c) {
  var props = PropertiesService.getScriptProperties(), key = props.getProperty(m.provider === 'gemini' ? 'GEMINI_KEY' : 'ANTHROPIC_API_KEY');
  if (!key) throw aiError_('authentication');
  var prompt = r.prompt + (r.json ? '\nReturn only valid JSON, without Markdown fences or explanatory text.' : '');
  var url, headers, payload, attachments = r.attachments || [];
  if (m.provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m.model + ':generateContent';
    headers = { 'x-goog-api-key': key };
    var cfg = { temperature: r.temperature === undefined ? 0.1 : r.temperature, maxOutputTokens: c.maxTokens }; if (r.json) cfg.responseMimeType = 'application/json';
    payload = { contents: [{ parts: [{ text: prompt }].concat(attachments.map(function (a) { return { inlineData: { mimeType: a.mimeType, data: a.data } }; })) }], generationConfig: cfg };
  } else {
    url = 'https://api.anthropic.com/v1/messages'; headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    payload = { model: m.model, max_tokens: c.maxTokens, messages: [{ role: 'user', content: attachments.map(function (a) {
      return { type: a.mimeType === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } };
    }).concat([{ type: 'text', text: prompt }]) }] };
  }
  if (r.embedding) {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m.model + ':embedContent';
    payload = { model: 'models/' + m.model, content: { parts: [{ text: r.prompt }] } };
  }
  var res;
  try { res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false }); }
  catch (e) {
    var message = String(e.message || '');
    if (/quota|too many times|limit exceeded|service invoked/i.test(message)) throw aiError_('local_quota');
    if (/timed?\s*out|timeout/i.test(message)) throw aiError_('timeout');
    if (/dns|address unavailable|connection|network|socket|temporarily unavailable/i.test(message)) throw aiError_('transport');
    throw aiError_('application');
  }
  var status = res.getResponseCode();
  if (status < 200 || status >= 300) {
    var category = status === 429 ? 'rate_limit' : status === 408 ? 'timeout' : status >= 500 ? 'outage' :
      (status === 401 || status === 403) ? 'authentication' : status === 404 ? 'model_unavailable' : 'input';
    var err = aiError_(category), h = res.getAllHeaders();
    Object.keys(h).forEach(function (k) { if (k.toLowerCase() === 'retry-after') {
      var v = String(h[k]), n = Number(v); err.retryAfterMs = Math.max(0, isFinite(n) ? n * 1000 : Date.parse(v) - Date.now());
      if (!isFinite(err.retryAfterMs)) delete err.retryAfterMs;
    } }); throw err;
  }
  var d; try { d = JSON.parse(res.getContentText()); } catch (e) { throw aiError_('invalid_response'); }
  if (!d || typeof d !== 'object') throw aiError_('invalid_response');
  if (r.embedding) {
    var v = d.embedding && d.embedding.values;
    if (!Array.isArray(v) || !v.length || v.some(function (n) { return typeof n !== 'number' || !isFinite(n); })) throw aiError_('invalid_response');
    return JSON.stringify(v);
  }
  var text;
  if (m.provider === 'gemini') {
    if (d.promptFeedback && d.promptFeedback.blockReason) throw aiError_('safety');
    var candidate = d.candidates && d.candidates[0];
    if (!candidate || typeof candidate !== 'object') throw aiError_('invalid_response');
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].indexOf(candidate.finishReason) >= 0) throw aiError_('safety');
    if (candidate.finishReason !== 'STOP') throw aiError_('invalid_response');
    if (!candidate.content || !Array.isArray(candidate.content.parts)) throw aiError_('invalid_response');
    text = candidate.content.parts.filter(function (p) { return p && !p.thought && typeof p.text === 'string'; }).map(function (p) { return p.text; }).join('');
  } else {
    if (d.stop_reason === 'refusal') throw aiError_('safety');
    if (d.stop_reason !== 'end_turn' || !Array.isArray(d.content)) throw aiError_('invalid_response');
    text = d.content.filter(function (p) { return p && p.type === 'text' && typeof p.text === 'string'; }).map(function (p) { return p.text; }).join('');
  }
  if (!text || !text.trim()) throw aiError_('invalid_response'); return text;
}
// Compatibility entry points for server-side extensions using the former Gemini helper.
function callGemini(prompt, jsonMode) { return aiRequest_('default', { prompt: prompt, json: !!jsonMode }); }
function geminiRequest_(payload) {
  if (!payload || !Array.isArray(payload.contents) || payload.contents.length !== 1 || !Array.isArray(payload.contents[0].parts)) throw aiError_('input');
  var parts = payload.contents[0].parts, cfg = payload.generationConfig || {};
  return aiRequest_('default', { prompt: parts.filter(function (p) { return typeof p.text === 'string'; }).map(function (p) { return p.text; }).join('\n'),
    json: cfg.responseMimeType === 'application/json', temperature: cfg.temperature, attachments: parts.filter(function (p) { return p.inlineData; }).map(function (p) { return p.inlineData; }) });
}
// Structural contracts validate output, never make hiring decisions.
function aiObject_(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function aiFields_(spec) { return function (x) { return aiObject_(x) && Object.keys(spec).every(function (k) {
  return spec[k] === 'array' ? Array.isArray(x[k]) : spec[k] === 'object' ? aiObject_(x[k]) : typeof x[k] === spec[k];
}); }; }
function aiDocumentValid_(x) { return aiObject_(x) && (x.doc_type === 'resume' ? typeof x.name === 'string' && typeof x.email === 'string' : x.doc_type === 'jd' && typeof x.title === 'string' && typeof x.role_description === 'string'); }
function aiFitValid_(x) { return aiFields_({ components: 'object', summary: 'string', strengths: 'array', gaps: 'array', interview_focus: 'array', must_have_coverage: 'array' })(x) &&
  ['skills', 'domain', 'problem_solving', 'pedigree', 'impact', 'certs', 'stability', 'logistics'].every(function (k) { return typeof x.components[k] === 'number' && isFinite(x.components[k]) && x.components[k] >= 0 && x.components[k] <= 100; }); }

function aiRankingValid_(count) {
  return function (x) {
    var seen = {};
    return aiFields_({ ranking: 'array' })(x) && x.ranking.length === count && x.ranking.every(function (r) {
      if (!r || typeof r.id !== 'string' || !/^C[0-9]+$/.test(r.id)) return false;
      var index = Number(r.id.slice(1));
      if (index >= count || seen[index] || typeof r.score !== 'number' || !isFinite(r.score) || r.score < 0 || r.score > 100 || typeof r.reason !== 'string') return false;
      seen[index] = true; return true;
    });
  };
}
function aiRubricValid_(count) {
  return function (x) {
    if (!aiFields_({ scores: 'object', gate: 'boolean', summary: 'string' })(x)) return false;
    for (var i = 0; i < count; i++) {
      var n = x.scores[i]; if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 5) return false;
    }
    return true;
  };
}
