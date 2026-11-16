# rigpool step 1 (scheduler + dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone, zero-dependency Node host that queues batch AI jobs, routes each job's Ollama requests to label-matched GPU workers, and serves a dashboard with queue control, machines inventory, ETAs and graphs.

**Architecture:** One host process (`rigpool host`) owns a job store, a request queue, a scheduler that spawns job commands locally, metrics, and an HTTP server (inference proxy on loopback, worker pull protocol, control API, static dashboard). Workers (`rigpool join`) pull requests over HTTP and run them on their own Ollama. Pure logic (labels, queue, jobs, models, progress, metrics, templates) lives in small modules unit-tested with `node:test`; `host.mjs` wires them.

**Tech Stack:** Node >= 20, ESM, `node:http`, `node:test`, `node:child_process`; dashboard is plain HTML/CSS/JS with inline SVG charts. No runtime or dev dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-rigpool-design.md` (moved into the rigpool repo in Task 1).

## Global Constraints

- Repo: `smika6/rigpool`, public, MIT license, local checkout at `C:\Users\Jacob\AI Projects\rigpool`.
- Node >= 20 (`"engines": { "node": ">=20" }`), `"type": "module"`, zero dependencies (none in `dependencies` or `devDependencies`).
- Tests: `node --test` (`npm test` runs `node --test test/`).
- No containers, no build step. Windows, macOS and Linux hosts and workers.
- Inference routes (`/api/*`, `/j/:job/api/*`) are loopback-only.
- Creating a job with a free-form command is loopback-only; LAN (password) may only instantiate templates.
- Default port 11500; default `maxRunning` 1; default lease 10 min; default max attempts 4.
- State dir default `./.rigpool/` (files: `state.json`, `metrics.json`, `token`, `logs/<jobId>.log`); atomic writes.
- Env set on every job: `OLLAMA_URL` and `OLLAMA_HOST` = `http://127.0.0.1:<port>/j/<jobId>`, `RIGPOOL_JOB_ID`, `RIGPOOL_PROGRESS_URL` = `http://127.0.0.1:<port>/rp/jobs/<jobId>/progress`; plus `OLLAMA_MODEL` when `modelPolicy` is `one`.
- Existing MapleCloset worker protocol stays compatible: `POST /pool/register {id,label,slots,models}`, `GET /pool/work?worker=` (200 job / 204 + `x-pool-paused` / 409 re-register), `POST /pool/result?worker=&job=`, `POST /pool/leave {id}`, `POST /pool/pause {id,paused}`, `GET /pool/status`, auth header `x-pool-token` or `?token=`, loopback always authed.
- Code style: terse, why-only comments, small modules; no filler.

## Review Focus

1. A worker disappears mid-request (leave or lease expiry): the request is re-queued and only ever re-leased to another card matching that job's selector and models (Task 3 test `requeues only to eligible cards`).
2. A job's process exits or is cancelled while its requests are pending or in flight: pending ones resolve with an error, late worker results get 410 and nothing crashes (Task 3 `dropJob` test, Task 9 `cancel mid-flight` test).
3. Host killed mid-save or restarted with a running job: `state.json` is never half-written, running jobs come back `failed` with reason `host restarted`, restartable ones re-queued at their old position (Task 4 and Task 2 tests).
4. Ollama's default streaming responses (`stream` omitted → NDJSON): bodies pass through byte-for-byte with their content type (Task 9 `ndjson passthrough` test).
5. Windows: job `cwd` with spaces (`C:\Users\...\AI Projects\...`) works, and cancel kills the whole process tree (`npm` → `node` child) (Task 6 tests, run on Windows).

---

### Task 1: Repo scaffold + labels and selectors

**Files:**
- Create: `package.json`, `LICENSE` (MIT, "Copyright (c) 2026 smika6"), `README.md` (one-paragraph stub), `.gitignore` (`node_modules/`, `.rigpool/`), `docs/design.md` (spec moved from MapleCloset), `docs/plan-step1.md` (this plan)
- Create: `src/labels.mjs`
- Test: `test/labels.test.mjs`

**Interfaces:**
- Produces: `parseSelector(text: string): Req[]` where `Req = { key: string, op: '=' | '!=' | '>=' | '<=' | 'has', value?: string }`; `matchesSelector(labels: Record<string,string>, reqs: Req[]): boolean`; `formatSelector(reqs: Req[]): string`; `parseLabels(text: string): Record<string,string>` (`"owner=gf,display=1"`).

- [ ] **Step 1:** `gh repo create smika6/rigpool --public --description "Batch AI jobs across every GPU on your LAN" --clone=false`, then `git init` in `C:\Users\Jacob\AI Projects\rigpool`, add `origin`.
- [ ] **Step 2: Write failing tests** in `test/labels.test.mjs`:
  - `parseSelector('gpu=nvidia, vram>=12, owner!=gf, vision')` deep-equals `[{key:'gpu',op:'=',value:'nvidia'},{key:'vram',op:'>=',value:'12'},{key:'owner',op:'!=',value:'gf'},{key:'vision',op:'has'}]`.
  - `parseSelector('')` and `parseSelector('  ')` → `[]`; `parseSelector('vram>=abc')` throws `/vram/`.
  - `matchesSelector({gpu:'nvidia',vram:'16'}, parseSelector('gpu=nvidia,vram>=12'))` → true; `vram:'8'` → false.
  - Missing key: fails `=`, `>=`, `<=`, `has`; passes `!=`.
  - Numeric ops compare as numbers (`vram:'9'` vs `>=12` is false, not string compare).
  - `formatSelector(parseSelector(s))` round-trips `'gpu=nvidia,vram>=12'`.
  - `parseLabels('owner=gf, display=1')` → `{owner:'gf',display:'1'}`; `parseLabels('bad')` throws.
- [ ] **Step 3:** Run `node --test test/labels.test.mjs` → FAIL (module missing).
- [ ] **Step 4:** Implement `src/labels.mjs` and `package.json` (`name: rigpool`, `bin: { rigpool: "bin/rigpool.mjs" }`, `scripts.test: "node --test test/"`, engines, `type: module`, `license: MIT`).
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit "Scaffold rigpool: labels and selectors, design + plan" and `git push -u origin main`.

### Task 2: Atomic state files

**Files:**
- Create: `src/state.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Produces: `readJson(file: string): any | null` (null when missing; throws on corrupt JSON with the path in the message); `writeJsonAtomic(file: string, value: any): void` (write `<file>.tmp`, `fsync`, rename); `createSaver(write: () => void, ms = 500): { schedule(): void, flush(): void }` (debounce; `flush` writes now if pending).

- [ ] **Step 1: Write failing tests:** write then read returns the value; a leftover `<file>.tmp` with garbage does not affect `readJson(file)`; `writeJsonAtomic` over an existing file replaces it (run on Windows too); saver: three `schedule()` calls within 500 ms produce one write; `flush()` writes immediately and only if scheduled.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Atomic state files".

### Task 3: Request queue with job-aware routing

Port of MapleCloset `scripts/lib/pool.mjs` (`JobQueue`) generalized: every request belongs to a job, eligibility and priority come from the host.

**Files:**
- Create: `src/queue.mjs` (port + extend; keep its reliability rules and comments' intent)
- Test: `test/queue.test.mjs` (port all cases from MapleCloset `scripts/lib/pool.test.js`, then add the new ones)

**Interfaces:**
- Consumes: nothing (pure; callbacks injected).
- Produces: `class RequestQueue({ leaseMs = 600000, maxAttempts = 4, now = Date.now, canServe = (worker, jobId) => true, rankOf = (jobId) => 0 })` with:
  - `enqueue({ jobId: string, path: string, body: string }): Promise<{ status: number, body: string, contentType?: string }>`
  - `register(id, { label, slots, models, host, machine, labels })`, `leave(id)`, `setPaused(id, paused): boolean`, `isPaused(id)`
  - `take(workerId, { waitMs = 25000 }): Promise<{ id, path, body } | null>` — picks, among pending requests this worker `canServe`, the lowest `rankOf(jobId)`, FIFO within a job; prefers requests it hasn't failed.
  - `complete(reqId, workerId, result: { status, body, contentType?, error? }): boolean` (same retry rules as today; `contentType` passed through to the client).
  - `dropJob(jobId, reason): number` — resolves all pending + leased requests of that job with `{ status: 499, body: JSON.stringify({ error: reason }) }`, returns count; later `complete` for those returns false.
  - `reoffer(): void` — re-match pending requests to idle waiters (call after a job resumes, a label changes, a card unpauses).
  - `expireLeases()`, `activeWorkers(windowMs = 90000)`, `models()`, `status(windowMs = 60000)` (today's shape, each worker also carries `machine`, `labels`, `jobId` of its latest lease).

- [ ] **Step 1: Write failing tests** (new ones, besides the ported suite):
  - `routes only to eligible cards`: `canServe` allows `a` for job `x` only; `take('b')` with only `x` pending resolves null after waitMs; `take('a')` gets it.
  - `requeues only to eligible cards`: `a` and `c` eligible, `b` not; lease to `a`, `leave('a')`; `b` never receives it, `c` does.
  - `priority follows rankOf`: requests from job `late` (rank 5) enqueued before job `early` (rank 1); next `take` returns `early`'s.
  - `anonymous ranks last`: `rankOf` returns `Infinity` for `'_'`; a real job's request wins over an older anonymous one.
  - `dropJob`: pending request promise resolves 499 with the reason; a leased one too; `complete` afterwards returns false.
  - `contentType passthrough`: `complete(..., { status: 200, body: 'a\nb\n', contentType: 'application/x-ndjson' })` → client gets same `body` and `contentType`.
  - `reoffer`: a waiter idle on `take('a')` while `canServe` returns false; flip it to true, call `reoffer()`; the waiter resolves with the request.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Request queue with job-aware routing".

### Task 4: Job store and lifecycle

**Files:**
- Create: `src/jobs.mjs`
- Test: `test/jobs.test.mjs`

**Interfaces:**
- Produces: `class JobStore({ now = Date.now })`:
  - `add(spec: { name, command, args = [], cwd, env = {}, models = [], modelPolicy = 'one', minCards = 1, selector = '', progressPattern?, estimate?, restartable = false, shell = false, template? }): Job` — `Job` = spec + `{ id, status: 'queued', progress: { done: 0, total: null, rate: 0 }, model: null, reason: null, createdAt, startedAt: null, finishedAt: null, exitCode: null }`. Ids `j1`, `j2`, … (monotonic, survive reload).
  - `get(id)`, `list(): Job[]` (queue order), `rankOf(id): number` (index in list; `'_'` → `Infinity`).
  - `move(id, index)` (only `queued` jobs; clamps index), `pause(id)`, `resume(id)`, `cancel(id)`, `rerun(id): Job` (new job, same spec, appended).
  - `markStarted(id, { model })`, `markWaiting(id, reason)`, `markFinished(id, exitCode)` (0 → `done`, else `failed`), `markCancelled(id)`.
  - `startable(maxRunning): Job[]` — queued jobs, in order, to fill free running slots (`running` + `paused` count as occupying).
  - `toJSON()`, `static fromJSON(obj, { now })` — jobs that were `running`/`paused` become `failed` with `reason: 'host restarted'`; those with `restartable: true` also get a clone inserted at their old index as `queued`.
  - Invalid transitions throw `JobStateError` (exported) with the job id and both states in the message.
  - Waiting is not a status: a started job whose cards are missing stays `running` with `reason: 'waiting for cards'` (cleared by `markStarted`/progress).

- [ ] **Step 1: Write failing tests:** ids monotonic across `toJSON`/`fromJSON`; `move` reorders and `rankOf` follows; moving a running job throws `JobStateError`; `pause` → `resume` → `running`; `cancel` a queued job → `cancelled` without starting; `rerun` of `failed` appends a `queued` clone with a new id and same `command`/`args`; `startable(1)` returns `[]` while one is running; restart rule (running → failed `host restarted`; restartable clone at the same index).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Job store and lifecycle".

### Task 5: Model choice, progress and ETA

**Files:**
- Create: `src/models.mjs`, `src/progress.mjs`
- Test: `test/models.test.mjs`, `test/progress.test.mjs`

**Interfaces:**
- Produces (`models.mjs`):
  - `chooseModel(models: string[], cards: { models: string[], slots: number }[], minCards = 1): string | null` — first model that `>= minCards` cards have; if none reaches `minCards`, the model with the most total slots among models some card has (ties → earlier in list); `null` if no card has any.
  - `modelForCard(models: string[], cardModels: string[]): string | null` — first of `models` the card has.
  - `rewriteModel(body: string, model: string): string` — replaces top-level `model` in a JSON body; returns `body` unchanged if not JSON or no `model` key.
- Produces (`progress.mjs`):
  - `DEFAULT_PROGRESS = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/` and `parseProgress(line: string, pattern = DEFAULT_PROGRESS): { done: number, total: number } | null` (commas stripped).
  - `advance(progress: { done, total, rate, at? }, sample: { done, total? }, now: number): progress` — rate is items/sec EMA (alpha 0.3) over samples at least 5 s apart; a `done` that goes down resets the rate (new pass in the same job).
  - `etaSeconds(progress): number | null` — `(total - done) / rate`; null when total unknown or rate 0.
  - `queueEta(jobs: Job[]): { seconds: number, unknown: number }` — sums running + queued jobs: known ETA for running, `(total ?? estimate) / referenceRate` for queued where `referenceRate` = the most recent running job's rate (0 → counted unknown); jobs with neither total nor estimate add to `unknown`.

- [ ] **Step 1: Write failing tests:** `chooseModel(['26b','12b'], [{models:['12b'],slots:4},{models:['12b','26b'],slots:2}], 2)` → `'12b'`; with `minCards = 1` → `'26b'`; no matches → null. `modelForCard`. `rewriteModel('{"model":"a","x":1}','b')` → JSON with `model:'b'` and `x:1`; non-JSON unchanged. `parseProgress('  650/5,394 · 0.5/s')` → `{done:650,total:5394}`; `parseProgress('no numbers')` → null; custom pattern works. `advance` EMA math with a fixed `now`; `done` decreasing resets rate to 0. `etaSeconds({done:100,total:200,rate:2})` → 50. `queueEta` counts `unknown` for a queued job without total/estimate.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Model choice, progress and ETA".

### Task 6: Job runner (spawn, logs, cancel)

**Files:**
- Create: `src/runner.mjs`
- Test: `test/runner.test.mjs` (fixtures: `test/fixtures/print-progress.mjs` prints `1/3`, `2/3`, `3/3` then exits 0; `test/fixtures/spawn-child.mjs` spawns a long-lived grandchild and prints its pid)

**Interfaces:**
- Consumes: `parseProgress` (Task 5).
- Produces: `startJob(job: Job, { port: number, logDir: string, onProgress: ({done,total}) => void, onExit: (code: number) => void }): { pid: number, kill(): Promise<void> }`.
  - Env: `process.env` + `job.env` + the Global Constraints job vars (`OLLAMA_MODEL` = `job.model` when set).
  - `spawn(job.command, job.args, { cwd: job.cwd, shell: job.shell, windowsHide: true, detached: process.platform !== 'win32' })`.
  - stdout+stderr appended to `<logDir>/<id>.log`; lines split on `\r`, `\n` (progress bars use `\r`); each line through `parseProgress(line, job.progressPattern && new RegExp(job.progressPattern))`.
  - `kill()`: Windows `taskkill /pid <pid> /T /F`; POSIX `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after 5 s if still alive. Resolves when the child has exited.

- [ ] **Step 1: Write failing tests:** progress fixture → `onProgress` called with `{done:3,total:3}` last and `onExit(0)`; log file contains the three lines; env contains `RIGPOOL_JOB_ID` and `OLLAMA_URL` with the job id; `cwd` = a temp dir whose name contains a space works; `kill()` on `spawn-child.mjs` → both the child and the grandchild pid are gone (`process.kill(pid, 0)` throws `ESRCH`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS (on Windows and, if available, macOS).
- [ ] **Step 5:** Commit "Job runner: spawn, logs, progress, tree kill".

### Task 7: Templates

**Files:**
- Create: `src/templates.mjs`
- Test: `test/templates.test.mjs`

**Interfaces:**
- Produces: `loadTemplates(file: string | null): Template[]` (missing file → `[]`; invalid → throws with the file path). File shape: `{ "templates": [{ "id", "name", "command", "args": [], "cwd"?, "env"?: {}, "models": [], "modelPolicy"?, "minCards"?, "selector"?, "progressPattern"?, "estimate"?, "restartable"?, "shell"?, "params"?: [{ "name", "values": [] , "default"? }] }] }`. Relative `cwd` resolves against the templates file's directory.
  - `instantiate(template: Template, params: Record<string,string>): JobSpec` — `${name}` substituted in `name`, `args`, `env` values only; a param value not in `values` throws; missing param uses `default` or throws.

- [ ] **Step 1: Write failing tests:** load a fixture file; `instantiate` substitutes `${catalog}` in args and env; `catalog: 'evil; rm -rf'` throws; missing param without default throws; relative cwd resolved; `command` is never taken from params.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Job templates".

### Task 8: Metrics

**Files:**
- Create: `src/metrics.mjs`
- Test: `test/metrics.test.mjs`

**Interfaces:**
- Produces: `class Metrics({ now = Date.now, minutes = 1440 })`: `record({ cardId, jobId, ok: boolean, ms: number })`; `series({ by: 'card' | 'job', minutes = 60 }): { t0: number, step: 60000, rows: Record<string, { done: number[], failed: number[], avgMs: number[] }> }` (arrays length `minutes`, oldest first, zero-filled); `toJSON()`, `static fromJSON(obj, opts)`; buckets older than `minutes` dropped.

- [ ] **Step 1: Write failing tests:** records in two different minutes land in two buckets; `series` zero-fills gaps; `avgMs` is the bucket mean; data older than 1440 min is dropped on record; JSON round-trip preserves series.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Per-minute metrics".

### Task 9: Host (HTTP + scheduler)

**Files:**
- Create: `src/host.mjs`
- Test: `test/host.test.mjs` (fixtures: `test/fixtures/fake-ollama.mjs` exports `startFakeOllama({ models, delayMs, stream })` → `{ url, close, calls }`; answers `/api/tags`, `/api/chat` (JSON or NDJSON when body `stream` is not `false`))

**Interfaces:**
- Consumes: everything above.
- Produces: `startHost({ port = 11500, password?, stateDir = '.rigpool', jobsFile = null, maxRunning = 1, local = null /* { url, slots, label } */, now }): Promise<{ port, close(): Promise<void>, store, queue }>`.
- Routes (`authed` = loopback, or `x-pool-token`/`?token=` equal to the token; token = `password` or saved `<stateDir>/token` or random, as MapleCloset's host does):
  - Inference, loopback only (403 otherwise): `POST /api/{chat,generate,show,embed,embeddings}` → job `'_'`; `POST /j/:job/api/...` → that job (404 unknown job, 409 job not running); `GET /api/tags` and `/j/:job/api/tags` → models servable (for a job: models some eligible card has); `GET /api/version`.
  - For `modelPolicy: 'any'` jobs the host rewrites the body's model with `modelForCard` at lease time (do it in `canServe`-paired lease hook or when handing the request to the worker — builder's call).
  - Worker protocol (authed): the compatible `/pool/*` routes from Global Constraints; `register` also accepts `machine` (default: worker id's prefix before the first `-`, or remote address) and `labels` (object). Effective card labels = automatic (`machine`, `model:<name>` per model) + reported + user-set (persisted in state by card key `machine|label`).
  - Control (authed): `GET /rp/status` (jobs with ETA, queue ETA, workers grouped by machine, templates list), `GET /rp/metrics?by=card|job&minutes=`, `POST /rp/jobs` (body `{ template, params }` from anyone authed; body with `command` only from loopback, else 403), `POST /rp/jobs/:id/{move,pause,resume,cancel,rerun}` (`move` body `{ index }`), `GET /rp/jobs/:id/log?tail=200`, `POST /rp/cards/labels` `{ card, labels }`, `POST /rp/jobs/:id/progress` `{ done, total? }` (loopback). `GET /pool/status` keeps today's shape plus `jobs`.
  - Dashboard: `GET /` and `/pool` → `src/dashboard/index.html` with the token embedded for loopback viewers (as today); `/app.js`, `/style.css` static.
- Scheduler (`tick()` every 1 s and on every change): for each `store.startable(maxRunning)` job choose its model (`modelPolicy: 'one'` → `chooseModel` over active eligible cards; null → leave queued, set reason `waiting for cards`), `markStarted`, `startJob`; on progress `advance` + save; on exit `markFinished` + `queue.dropJob(id, 'job exited')`. Cancel: `kill()`, `dropJob`, `markCancelled`. Pause/resume a job: queue stops/starts leasing its requests (`canServe` returns false for paused jobs) then `reoffer()`.
- `canServe(worker, jobId)`: job `'_'` → any card; else job running and not paused, card has one of `job.models` (`'one'`: exactly `job.model`), and `matchesSelector(card.labels, parseSelector(job.selector))`.
- Saves state via `createSaver` on every store change and metrics every 60 s; `close()` flushes.

- [ ] **Step 1: Write failing tests** (each starts a host on port 0 with a temp state dir and fake Ollamas joined via the HTTP worker protocol, using a small in-test `pullLoop` helper):
  - `routes job requests by selector`: cards `nv` (labels `gpu=nvidia`) and `arc` (`gpu=intel`); a loopback-submitted job (command `node test/fixtures/call-ollama.mjs 5`, selector `gpu=nvidia`) completes; fake `nv` saw 5 calls, `arc` 0.
  - `ndjson passthrough`: anonymous `POST /api/chat` with no `stream` field returns the fake's NDJSON bytes and `content-type: application/x-ndjson`.
  - `inference is loopback-only`: request from a non-loopback address (bind host to `0.0.0.0`, call via the machine's LAN IPv4 if present, else skip) → 403.
  - `LAN can only use templates`: `POST /rp/jobs` with a `command` and the token, from a non-loopback address → 403; with `{ template, params }` → 200.
  - `waiting for cards`: job with selector `gpu=amd` stays queued with reason `waiting for cards`; adding a card with `gpu=amd` via `/rp/cards/labels` starts it.
  - `cancel mid-flight`: cancel while the fake delays 2 s; job `cancelled`, the late result POST gets 410, host keeps serving.
  - `old worker protocol`: a worker registering with only `{id,label,slots,models}` (no machine/labels) receives anonymous requests.
  - `restart`: `close()` with a running job, start a new host on the same state dir → job `failed`, reason `host restarted`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Host: scheduler, routing, control API".

### Task 10: Join client and CLI

**Files:**
- Create: `src/join.mjs` (port of MapleCloset `join()` + `workerLoop` + `makeUnloader` from `scripts/tag-pool.mjs`), `bin/rigpool.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `startHost` (Task 9), `parseLabels` (Task 1).
- Produces: `join({ hostUrl, password, ollama = 'http://127.0.0.1:11434', slots = 2, label?, labels = {} }): Promise<{ leave(): Promise<void> }>` — registers with `machine: os.hostname()`, sends `contentType` from the Ollama response in results.
- CLI (`bin/rigpool.mjs`, argument parsing by hand, `--help` per command):
  - `rigpool host [--port 11500] [--password pw] [--jobs rigpool.jobs.json] [--max-running 1] [--state .rigpool] [--local http://127.0.0.1:11434] [--local-slots 2] [--no-local]` — `rigpool.jobs.json` in the cwd is used when present.
  - `rigpool join <url> --password pw [--ollama url] [--slots n] [--label name] [--labels k=v,...]`
  - `rigpool submit [--host http://127.0.0.1:11500] --name n [--model m]... [--any-model] [--select sel] [--cwd dir] [--shell] -- <command> [args...]` → prints the job id.
  - `rigpool ls`, `rigpool move <id> <index>`, `rigpool pause|resume|cancel|rerun <id>`, `rigpool log <id>`.
  - Exit codes: 0 ok, 1 error with a one-line `rigpool: <message>` on stderr.

- [ ] **Step 1: Write failing tests:** spawn `node bin/rigpool.mjs host --port 0 ...` (host prints `listening on :<port>` first line), a fake Ollama, `rigpool join` against it with `--labels gpu=nvidia`; `rigpool submit --name t --model fake --select gpu=nvidia -- node test/fixtures/call-ollama.mjs 3` prints an id; `rigpool ls` shows it `done` within 10 s; `rigpool move` of an unknown id exits 1 with `rigpool:` prefix.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit "Join client and CLI".

### Task 11: Dashboard

**Files:**
- Create: `src/dashboard/index.html`, `src/dashboard/app.js`, `src/dashboard/style.css`
- Test: `test/dashboard.test.mjs` (structural only: host serves the three files; `index.html` references `app.js`/`style.css`; for a loopback request the token placeholder is replaced, for LAN it is empty)

**Interfaces:**
- Consumes: `GET /rp/status`, `GET /rp/metrics`, control routes (Task 9).
- Produces: the page. Sections, in order: **Overview** (items/min now, queue ETA with "+ N jobs without an estimate", running jobs with progress bar + ETA, cards online/paused/gone counts), **Queue** (ordered rows: name, status/reason, progress, rate, ETA, model, selector; up/down reorder for queued jobs; pause/resume/cancel/re-run; log viewer drawer; "Add job" form built from templates and their params), **Machines** (one panel per machine; per card: online state, labels as editable chips, models, slots busy/total, current job, speed, last error, pause/resume), **Graphs** (inline SVG: pool items/min over the last 60/360/1440 min stacked by card; per-card average latency lines), **Add a machine** (join command with host URL + password, copy button using the clipboard fallback from MapleCloset's page).
- Polls `/rp/status` every 2 s and `/rp/metrics` every 30 s. Light + dark via CSS variables and `prefers-color-scheme`; usable at 375 px width (tables scroll horizontally inside their card, no page-level horizontal scroll). Password gate + `localStorage` like MapleCloset's page (all storage access in try/catch).

- [ ] **Step 1:** Write the structural tests → FAIL. **Step 2:** Build the page. **Step 3:** Tests PASS.
- [ ] **Step 4:** Manual check: start a host with two fake Ollamas and a template file (`examples/rigpool.jobs.json` with a fake-call template), open `http://127.0.0.1:<port>/` in light and dark at desktop and 375 px; reorder, pause, cancel, add from template, edit a label; screenshot each section.
- [ ] **Step 5:** Commit "Dashboard".

### Task 12: README, example, release check

**Files:**
- Create: `README.md` (what it is, 5-minute quick start: host → join → submit → dashboard; labels/selectors; templates; model lists; security model; roadmap steps 2–4 incl. the pooled-memory caveat), `examples/rigpool.jobs.json`
- Modify: `package.json` (`files`, `keywords`, `repository`)

- [ ] **Step 1:** `npm test` → all PASS on Windows.
- [ ] **Step 2:** Follow the README quick start from a fresh clone in a temp dir, with this PC's real Ollama (`http://127.0.0.1:11434`, `gemma4:12b`) as the worker and a template that runs 20 chat calls; job finishes, dashboard shows it.
- [ ] **Step 3:** Commit "README and example jobs"; `git push`.
