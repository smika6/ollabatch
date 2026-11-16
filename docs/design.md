# rigpool — design (step 1: scheduler + dashboard)

Working name. Moves into its own public repo as the first commit; MapleCloset
consumes it as a git submodule at `tools/rigpool`.

## Intent

"Kubernetes for local AI" without the Kubernetes: one host, any number of
machines and GPUs on the home LAN, a queue of long batch AI jobs, and a
dashboard that shows and controls all of it. For normal tech people who want
real control over their own hardware with very little effort. Joining another
card (a 3080 downstairs, a partner's 3060 Ti) is one command on that machine.

It grows out of MapleCloset's tagging pool (`scripts/tag-pool.mjs`,
`scripts/lib/pool.mjs`), which already does pull-based workers, job leases,
pause-for-gaming and a status page. MapleCloset becomes one user of it.

## Roadmap (agreed order)

1. **Scheduler + dashboard** (this doc): job queue, card labels and selectors
   ("sub-pools"), machines inventory, ETAs, graphs.
2. **Machine agent**: per-machine daemon that discovers cards, starts one
   pinned inference server per card, pulls models, reports VRAM / util /
   temperature, and can auto-pause when the machine is in use. Replaces what
   `tag-desktop.ps1` does by hand.
3. **Job files + placement smarts**: committed job manifests, model placement
   and swapping across cards.
4. **Pooled-memory models**: run one model too big for any single card across
   several machines (llama.cpp RPC-style), exposed to the scheduler as one
   virtual card with combined labels (`vram=<sum>`, `split=1`). Step 1's only
   obligation: nothing in the card/selector model assumes one card = one GPU.
   Honest caveat for the docs: over home Ethernet this is far slower per token
   than a single card; it's for "doesn't fit anywhere", not for speed.

## Goals (step 1)

- Ordered job queue on the host: add, reorder, pause, resume, cancel, re-run;
  N jobs running at once (default 1).
- Per-job model address so the host knows which job every inference request
  belongs to.
- Card labels (automatic + user-set) and job selectors; a job's requests only
  go to cards that match and have the job's model.
- Machines view: each machine, its cards, online/paused/gone, models each card
  has, labels, current job, speed.
- ETA per job and for the whole known queue; speed graphs per card and per job.
- State survives a host restart (queue, history, labels).
- MapleCloset's existing tag scripts run as jobs unchanged.

## Non-goals (step 1)

- Containers. No Docker/Kubernetes underneath; GPU passthrough in containers is
  painful on Windows and Arc, which is exactly the target hardware.
- Running job code on worker machines (approach C, rejected below).
- Splitting one model across several cards/machines — roadmap step 4.
- Starting/managing inference servers on workers — step 2.
- Multi-user accounts, internet exposure, TLS. LAN trust model only.
- npm publishing / installers — step 2, with the agent.

## Anti-goals (failure even if it "works")

- Heavy dependencies, a build step, or a framework. Node >= 20, zero runtime
  dependencies, readable code (owner's bar: high-performance, lightweight,
  YAGNI, no filler comments).
- Workers needing open ports, port forwards or firewall changes.
- Anyone with the pool password being able to run arbitrary commands on the
  host from a browser.
- Making someone else's PC unusable without an easy way to take it back.
- Config sprawl: a new user should get from clone to a running job in a few
  minutes with defaults.

## Constraints

- Hosts and workers on Windows, macOS, Linux; NVIDIA, Intel Arc, Apple
  silicon — anything that runs an Ollama-compatible server.
- Workers only connect out to the host (long-poll pull), as today.
- Inference protocol: the Ollama HTTP API (`/api/chat`, `/api/generate`,
  `/api/show`, `/api/embed`, `/api/embeddings`, `/api/tags`). OpenAI-compatible
  endpoints are a later addition, not v1.
- Wire compatibility: MapleCloset's current `tag-pool.mjs join` workers and
  `tag-desktop.ps1 -JoinPool` must keep working against the new host, or be
  replaced in the same change that migrates MapleCloset.
- MapleCloset's tagging rules: one tag writer per axis set at a time. With the
  default of 1 running job this holds automatically; running several
  MapleCloset jobs at once is the user's explicit choice.

## Approaches considered

- **A. Grow the pool inside MapleCloset, extract later.** Fastest to a visible
  result, but tangles product and tool and makes the split real work. Works
  against the separate open-source repo the owner wants. Rejected.
- **B. New repo; the host runs jobs as local processes, GPUs only do
  inference.** (Chosen.) A job is a command on the host. It gets its own model
  address, and its requests are routed to matching cards. Matches today's pool,
  keeps MapleCloset's single tag writer, workers need only Ollama + the join
  client. Trade-off: every job's own code runs on the host CPU — fine for batch
  LLM work, where the GPU is the bottleneck.
- **C. New repo; whole jobs ship to worker machines.** Most Kubernetes-like,
  but every machine needs each job's code, environment and credentials, and
  MapleCloset would get tag writes from several PCs (forbidden by its rules).
  Much bigger, and the power doesn't help batch AI work. Rejected.

## Design

### Concepts

- **Host**: one process. Job queue, scheduler, request router, dashboard, state.
- **Machine**: a physical computer, grouped by the hostname workers report.
- **Card**: one worker = one inference server (usually one GPU). Reports
  machine, label, slots, and the models its server has.
- **Labels**: key/value strings on a card.
  - Automatic: `machine=<host>`, `model:<name>` for each installed model,
    plus whatever the worker reports (`gpu=nvidia|intel|apple`, `vram=16`) when
    known — step 1 accepts them if sent; step 2's agent fills them reliably.
  - User-set from the dashboard or CLI, e.g. `owner=gf`, `display=1`,
    `vision=1`. Persisted per card identity (machine + server URL), so they
    survive reconnects.
- **Selector**: on a job, a list of label requirements (`gpu=nvidia`,
  `owner!=gf`, `vram>=12`). Empty selector = any card with the model.
  A "sub-pool" is just a label several cards share.
- **Job**: `{ id, name, command, args, cwd, env, models, modelPolicy,
  selector, progress, status, createdAt, startedAt, finishedAt, exitCode }`.
  Status: `queued | running | paused | done | failed | cancelled`.
- **Models on a job**: an ordered preference list, e.g.
  `["gemma4:26b", "gemma4:12b"]` — "I'll take a smaller model to get more
  cards". `modelPolicy`:
  - `one` (default): the host picks ONE model from the list for the whole job
    at start — the first that enough matching online cards can serve
    (`minCards`, default 1; "enough" = the choice that maximizes total slots
    when the preferred model has fewer than `minCards` cards) — and the job's
    env `OLLAMA_MODEL` is set to it. Consistent output; this is what
    MapleCloset needs (its runner already insists on one model per run).
  - `any`: each request may run on any listed model a matching card has; the
    host rewrites the request's `model` field to what that card runs. Maximum
    throughput, mixed output — for jobs where that's fine.
  A card matches a job only if it has at least one of the job's models.

### Job lifecycle and scheduling

- Queue is an ordered list; the scheduler starts the first `queued` jobs until
  `maxRunning` (default 1) are running.
- Starting a job: spawn its command with `OLLAMA_URL` (and `OLLAMA_HOST`) set to
  `http://127.0.0.1:<port>/j/<jobId>` plus its env. stdout/stderr go to
  `<state>/logs/<jobId>.log`; the dashboard tails it.
- Requests arriving on `/j/<jobId>/api/*` are queued with that job id and only
  leased to cards matching the job's selector and having its model. The
  existing JobQueue rules (leases, re-queue on failure/lease expiry, prefer a
  different card after a failure, max attempts) apply per request.
- Requests on the bare `/api/*` (no job prefix) are served too, as an anonymous
  job with an empty selector — this keeps today's
  `OLLAMA_URL=http://localhost:11500` usage on the host working. Like today, all
  inference routes (bare and `/j/*`) are **loopback-only**: jobs run on the
  host, and opening them to the LAN would be an unauthenticated path to every
  GPU. *(call)*
- **Contention between jobs** *(call)*: when several jobs (or the anonymous
  one) have pending requests a card can serve, the card takes from the job
  that is earliest in the queue order; the anonymous job ranks last. Simple,
  and it makes "reorder" mean "priority". Fair share is a later option.
- **`one` policy without cards** *(call)*: at start, if no listed model has
  `minCards` matching online cards, the job waits in state `waiting for cards`
  (shown in the dashboard, no timeout — an overnight run shouldn't die because
  a PC was asleep). Mid-run, if every card with the chosen model leaves, its
  requests wait the same way; the model is never re-picked mid-job (it's in the
  process env).
- Pause a job: stop leasing its requests (in-flight ones finish); the process
  keeps running and simply waits. Resume re-opens it. Cancel: kill the process
  tree, mark `cancelled`, drop its pending requests with an error.
- Re-run: clone a finished/failed/cancelled job to the end of the queue.
  MapleCloset's scripts are resume-by-default, so re-run = "finish the rest".
- Reorder: move a `queued` job anywhere in the list (dashboard drag or
  up/down; CLI `rigpool move <id> <pos>`).
- Card pause (today's feature) stays: a paused card takes no requests and
  unloads its models.

### Who may create jobs (security)

Creating a job runs a command on the host, so:

- **Host CLI** (loopback): may submit any command —
  `rigpool submit --name "..." --model gemma4:12b --select gpu=nvidia -- node scripts/foo.js`.
- **Dashboard / LAN** (pool password): may enqueue **templates** only, plus
  reorder / pause / resume / cancel / re-run existing jobs and edit card labels.
  Templates are defined in a file on the host (`rigpool.jobs.json` in the
  project the host is started from, or `--jobs <file>`): name, command, args,
  cwd, env, default model/selector, and optional user-fillable params with an
  allowed-values list (e.g. `catalog: royals|global|classic`). No free-text
  command field ever reaches the browser.
- Joining as a worker requires the pool password, as today.

### Progress and ETA

- Jobs report progress either way:
  - stdout line matching the job's `progress` regex (template/CLI option;
    default matches `<done>/<total>` like MapleCloset's taggers print), or
  - `POST $RIGPOOL_PROGRESS_URL` with `{ done, total, note? }` (env var set
    on every job).
- Per-job ETA = remaining / recent rate (EMA over the last few minutes).
- Queue ETA = sum over running + queued jobs that have a known total. A job
  whose total is unknown until it starts may carry an `estimate` (items) from
  its template; otherwise the queue ETA says "+ N jobs without an estimate"
  instead of guessing.
- Optional: a template can declare `sizeCommand`, run before the job starts
  (and on demand from the dashboard) to fill in `total` early. Left to the
  builder whether v1 ships it.

### Metrics and graphs

- Host keeps per-card and per-job counters in 1-minute buckets (requests done,
  failed, total latency) for 24 h, ring buffers in memory, snapshotted to the
  state dir every minute.
- Dashboard graphs, hand-drawn inline SVG (no chart library): pool items/min
  over time stacked by card; per-job progress over time; per-card latency.

### Dashboard (single page served by the host)

Sections:

1. **Overview**: items/min now, queue ETA, running jobs with progress bars and
   ETAs, cards online / paused / gone.
2. **Queue**: ordered list of jobs with status, progress, rate, ETA, model,
   selector; drag or up/down to reorder; pause / resume / cancel / re-run /
   view log; "Add job" from templates.
3. **Machines**: one card per machine; inside, its cards with online state,
   labels (editable), models, slots busy/total, current job, speed, last error,
   pause/resume.
4. **Graphs**: throughput over time (stacked by card), latency per card.
5. **Add a machine**: the join commands (today's panel, generalized; the
   Windows one-click launcher stays a MapleCloset/desktop-script concern until
   step 2).

Light and dark themes via CSS variables, mobile-usable (phone on the couch
checking the run), polls a status endpoint (or SSE — builder's call).

### State

- State dir: `./.rigpool/` next to where the host runs (overridable). Holds
  `state.json` (jobs, labels, settings), `metrics.json`, `logs/`, `token`.
- Atomic writes (temp file + rename). On host restart: `running` jobs are
  marked `failed (host restarted)` and, if the template says
  `restartable: true`, re-queued at their old position.

### HTTP surface (shape, names left to the builder)

- Inference: `POST /j/:job/api/*`, `GET /j/:job/api/tags`, bare `/api/*`.
- Workers: register / work (long-poll) / result / leave — today's protocol,
  extended with machine + reported labels.
- Control (password or loopback): jobs list/get/create(template or loopback
  command)/move/pause/resume/cancel/rerun, job log tail, card label edit, card
  pause, templates list.
- Status: one snapshot endpoint for the dashboard; metrics endpoint for graphs.

### CLI

`rigpool host [--port 11500] [--password ...] [--jobs file]`,
`rigpool join <url> --password ... [--ollama url] [--slots n] [--label name] [--labels k=v,...]`,
`rigpool submit ...`, `rigpool ls`, `rigpool move|pause|resume|cancel|rerun <id>`.

### MapleCloset migration — a separate, later plan *(call)*

Step 1 ships standalone first. To keep today's joiners (`tag-pool.mjs join`,
`tag-desktop.ps1 -JoinPool`) working until then, the new host speaks the
existing `/pool/register|work|result|leave|pause|status` worker protocol,
extended rather than replaced. When the migration happens:

- Add the submodule at `tools/rigpool`.
- Ship `rigpool.jobs.json` with one template per tag pass
  (catalog x pass, as `buildSteps` in `scripts/tag-overnight.mjs` builds today).
- `tag:overnight --pool` stays the orchestrator *(call)*: it still does the KV
  backup, dry-run mode, picks ONE model for the whole run (as `pickModel()`
  does today, so every pass tags with the same model) and passes it as a
  single-entry model list, then submits each pass as a job and **waits** for
  it (host needs a "get job / wait for job" call and the job's exit code and
  log), runs the end-of-run error sweep from the job logs, and sets its exit
  code. Sequential behaviour is preserved with `maxRunning = 1`.
- `scripts/tag-pool.mjs` and `scripts/lib/pool.mjs` are replaced by the
  submodule (tests move with them). `tag-desktop.ps1 -JoinPool` calls the
  submodule's join client.
- Docs: `docs/SCRIPTS.md`, `docs/OPERATIONS.md` updated in the same change.

## Left to the builder

File layout, exact route and field names, SSE vs polling, chart styling,
whether `sizeCommand` ships in v1, test structure (`node:test` or vitest —
pick one and keep it dependency-free if possible), how the bare `/api/*`
anonymous job appears in the UI.
