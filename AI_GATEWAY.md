# AI gateway setup and operations

Paste `AiGateway.gs` into the main Apps Script project as a Script file named `AiGateway`, alongside `Code.gs`. Existing installs must add this file before deploying the updated Code. No npm packages or additional Apps Script services are required.

## Script Properties

Credentials and routing live in **Project Settings → Script Properties**, never in source, sheets, browser code, or logs.

- `GEMINI_KEY`: existing Google AI Studio key; unchanged.
- `ANTHROPIC_API_KEY`: optional Claude API key. Required only if an Anthropic model is selected.
- `GEMINI_MODEL`: optional override for the first legacy default model.
- `AI_CONFIG`: optional JSON object below. Omit it to keep Gemini (`gemini-2.5-flash`, then `gemini-2.5-flash-lite`). Model availability depends on your provider account; use an enabled model ID.

Example: replace `YOUR_ENABLED_CLAUDE_MODEL_ID` with your chosen Claude model ID before saving. Model IDs are configuration, not pinned assumptions about provider availability.

```json
{
  "default": [
    { "provider": "anthropic", "model": "YOUR_ENABLED_CLAUDE_MODEL_ID" },
    { "provider": "gemini", "model": "gemini-2.5-flash" },
    { "provider": "gemini", "model": "gemini-2.5-flash-lite" }
  ],
  "tasks": {
    "cv_parsing": [
      { "provider": "gemini", "model": "gemini-2.5-flash" },
      { "provider": "anthropic", "model": "YOUR_ENABLED_CLAUDE_MODEL_ID" }
    ],
    "cv_scoring": [
      { "provider": "anthropic", "model": "YOUR_ENABLED_CLAUDE_MODEL_ID" },
      { "provider": "gemini", "model": "gemini-2.5-flash" }
    ],
    "interview_questions": [
      { "provider": "anthropic", "model": "YOUR_ENABLED_CLAUDE_MODEL_ID" },
      { "provider": "gemini", "model": "gemini-2.5-flash-lite" }
    ],
    "audio_transcription": [
      { "provider": "gemini", "model": "gemini-2.5-flash" }
    ]
  },
  "maxAttempts": 4,
  "retriesPerModel": 1,
  "budgetMs": 60000,
  "executionBudgetMs": 180000,
  "executionMaxAttempts": 20,
  "baseDelayMs": 500,
  "maxDelayMs": 4000,
  "maxTokens": 4096,
  "fallbackOn": []
}
```

A task route replaces the default list. Entries run in order; one model may be retried before advancing. The total attempt cap can stop a request before it reaches every configured model. Routes have 1–8 unique provider/model entries. Invalid configuration fails closed before any API call. Removing `AI_CONFIG` restores legacy Gemini routing immediately.

## Task names

| Route | Existing operations |
|---|---|
| `cv_parsing` | Resume/document parsing, including JD extraction |
| `cv_scoring` | Sourced candidate scoring, listwise ranking, fit scoring, rubric scoring |
| `interview_questions` | Interview plan and benchmark/sample question generation |
| `audio_transcription` | Success-profile and calibration voice notes |
| `embedding` | Semantic relevance vectors; see restriction below |
| Other names | `processMessage`, `polishFeedback`, `generateDebrief`, `importFeedbackFromEmail`, `queryStatus`, `candidateStory`, `draftDecisionEmail`, `recommendJobArch`, `getSuccessProfile`, `inferSkills`, `reqBrief`, `setCalibrationFromText`, `classifyRubric`, `tuneCompanyByText`, `sendPrepPack`, `draftCandidateEmail` |

New server-side text tasks use `callAI_(task, prompt, jsonMode, validator)`; document tasks use `aiDocument_`. The optional validator returns exactly `true` for acceptable parsed JSON. Returning false triggers model fallback; throwing means an application bug and stops by default. Named JSON tasks require an object unless they supply a different contract (e.g. sourced scoring returns an array). Existing prompts and hiring rules are unchanged. `callGemini` and `geminiRequest_` remain compatibility adapters for the old simple text/inline-document payloads; these use the configured default route, despite their old names. They are not general adapters for every Gemini API feature.

## Failures and limits

| Category | Default behavior |
|---|---|
| HTTP 429, 408, 5xx; recognized timeout/network failures | Retry with capped exponential jitter, then next model |
| Malformed envelope, empty output, truncated completion, invalid JSON or failed structural contract | Next model immediately |
| HTTP 400/413/422 and other permanent request errors (`input`) | Stop |
| Missing key, HTTP 401/403 (`authentication`); HTTP 404 (`model_unavailable`) | Stop |
| Validator bug or unrecognized local exception (`application`) | Stop |
| Provider refusal/safety block; Apps Script quota exception | Stop; no automatic override |
| Unsupported Claude attachment type, including audio | Skip Claude without sending data; try the next configured model |

`fallbackOn` can explicitly permit `input`, `authentication`, `model_unavailable`, or `application`. These categories move directly to the next model without retrying. Local input validation and configuration errors always stop. Server error bodies, exception messages, prompts, filenames, candidate identifiers, response content, credentials, and attachments are never included in gateway logs or gateway errors.

`Retry-After` (seconds or HTTP date) is honored for same-model retries. A wait longer than `maxDelayMs` advances to the next model instead. Attempts are sequential. Caps: 1–8 attempts per request, 0–2 retries per model, 1–50 attempts per execution, request budget 1–120 seconds, execution budget 1–240 seconds, backoff up to 10 seconds, output cap 256–16384 tokens. The execution budget starts at the first gateway invocation, not the beginning of the Apps Script runtime. For bulk jobs, tune batch sizes to fit these limits; existing callers retain their existing error/optional-result handling.

**Time budgets are soft:** Apps Script `UrlFetchApp.fetch` has no supported per-request timeout/cancellation option. The gateway checks deadlines before starting another attempt or waiting. A blocking request may overrun the deadline, and Apps Script can terminate an execution without a catchable error. No background retries are created.

Gemini uses JSON MIME mode; Claude is instructed to return JSON. Both are parsed and validated locally before returning. Structured output is not guaranteed by prompting alone: malformed outputs exhaust the configured route and then return a sanitized error. Text parts are joined; Gemini thought parts are excluded; truncated completions are rejected. Critical parsing/scoring operations validate field types and score ranges without changing scoring formulas or approval decisions.

Claude supports PDF and PNG/JPEG/GIF/WebP attachments in this adapter; Gemini retains existing document/audio handling. Word and other documents still pass through the existing Drive-to-PDF conversion. Provider/model-specific content limits still apply. Adding Claude to a route permits sending that task's content to Anthropic, including on fallback.

Embeddings default to the existing `text-embedding-004`. `tasks.embedding`, if set, must contain exactly one Gemini model. Transport retries, limits, and logging apply, but model fallback is deliberately disabled: vectors from different models cannot be safely compared. Both sides of a relevance comparison use the same configured model; failures preserve the existing optional `null`/score-based fallback. The separate opt-in external reranker remains unchanged.

## Logs and validation

Each attempt emits a JSON event with task, provider, model, latency, category, attempt number, fallback index, and elapsed time. A capability skip emits a separate event without consuming an HTTP attempt. Only use static task/model identifiers in configuration. Existing application audit logs are outside this transport change.

Run deterministic tests (no keys, external requests, or candidate data):

```sh
node --test tests/ai-gateway.test.cjs
```

Before deploying, perform a fresh install in a disposable Google account/project using SETUP.md, run `firstRun()`, and check a synthetic resume, a synthetic score request, and a synthetic interview-plan request with your enabled models. Test a Claude-first route and a Gemini-only route. Verify execution logs and unchanged permissions/stages. A real Apps Script install and live provider smoke test require your project authorization and credentials; local tests cannot validate those services or account-specific model availability.

References: [Claude errors](https://platform.claude.com/docs/en/api/errors), [Claude stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), [Gemini generateContent](https://ai.google.dev/api/generate-content), [Apps Script URL Fetch](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app).
