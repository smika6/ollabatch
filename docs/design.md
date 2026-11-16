# rigpool design

## Intent

"Kubernetes for local AI" without the Kubernetes: one host, any number of
machines and GPUs on the home network, a queue of long batch AI jobs, and a
dashboard that shows and controls all of it. For people who want real control
over their own hardware with very little effort. Lending another card (an old
GPU downstairs, a partner's gaming PC overnight) is one command on that
machine.

## Roadmap

1. **Scheduler + dashboard** (shipped): job queue, card labels and selectors
   ("sub-pools"), machines inventory, ETAs, graphs.
2. **Machine agent**: a per-machine daemon that discovers its cards, starts one
   pinned inference server per card, pulls models, reports VRAM / use /
   temperature, sizes each card's concurrency by measurement, and pauses a
   card while its owner is using it.
3. **Job files + placement**: committed job manifests, model placement and
   swapping across cards.
4. **Pooled-memory models**: one model too big for any single card, run across
   several machines (llama.cpp RPC-style) and exposed to the scheduler as one
   virtual card with combined labels (`vram=<sum>`, `split=1`). Nothing in the
   card/selector model assumes one card = one GPU. Over home Ethernet this is
   far slower per token than a single card; it's for models that don't fit
   anywhere, not for speed.

## Goals (step 1)

- Ordered job queue on the host: add, reorder, pause, resume, cancel, re-run;
  N jobs running at once (default 1).
- A per-job model address, so the host knows which job every inference request
  belongs to.
- Card labels (automatic + user-set) and job selectors; a job's requests only
  go to cards that match and have the job's model.
- Machines view: each machine, its cards, online/paused/gone, models, labels,
  current job, speed.
- ETA per job and for the whole known queue; speed graphs per card and per job.
- State survives a host restart (queue, history, labels).
- Existing scripts that talk to Ollama run as jobs unchanged.

## Non-goals (step 1)

- Containers. GPU access inside containers is painful on Windows and Intel
  Arc, which is exactly the target hardware.
- Running job code on worker machines (approach C below).
- Splitting one model across cards or machines (step 4).
- Starting or managing inference servers on workers (step 2).
- Multi-user accounts, internet exposure, TLS. Home-network trust model only.

## Anti-goals (failure even if it "works")

- Heavy dependencies, a build step, or a framework. Node >= 20, zero runtime
  dependencies, readable code.
- Workers needing open ports, port forwards or firewall changes.
- Anyone with the pool password, or any web page, being able to run arbitrary
  commands on the host.
- Making someone else's PC unusable without an easy way to take it back.
- Config sprawl: from clone to a running job in a few minutes with defaults.

## Constraints

- Hosts and workers on Windows, macOS, Linux; NVIDIA, Intel Arc, Apple
  silicon: anything that runs an Ollama-compatible server.
- Workers only connect out to the host (long-poll pull).
- Inference protocol: the Ollama HTTP API (`/api/chat`, `/api/generate`,
  `/api/show`, `/api/embed`, `/api/embeddings`, `/api/tags`).
  OpenAI-compatible endpoints may come later.
- The worker protocol (`/pool/register|work|result|leave|pause|status`) stays
  backward compatible, so older join clients keep working.
- Many batch scripts must be the only writer of their output. The default of
  one running job keeps that true; running several at once is the user's
  explicit choice.

## Approaches considered

- **A. A pool embedded in one project.** Fastest to start, but ties a general
  tool to one codebase. Rejected.
- **B. The host runs jobs as local processes; GPUs only do inference.**
  (Chosen.) A job is a command on the host with its own model address; its
  requests are routed to matching cards. Workers need only Ollama and the join
  client, and a job keeps a single writer. Trade-off: every job's own code runs
  on the host CPU, which is fine for batch LLM work where the GPU is the
  bottleneck.
- **C. Whole jobs ship to worker machines.** Most Kubernetes-like, but every
  machine needs each job's code, environment and credentials, and a job's
  output would be written from several machines at once. Much bigger, and the
  power doesn't help batch AI work. Rejected.

## Design (step 1)

### Concepts

- **Host**: one process. Job queue, scheduler, request router, dashboard, state.
- **Machine**: a physical computer, grouped by the hostname workers report.
- **Card**: one worker = one inference server (usually one GPU). Reports
  machine, label, slots, and the models its server has.
- **Labels**: key/value strings on a card.
  - Automatic: `machine=<host>`, `model:<name>` for each installed model, plus
    whatever the worker reports (`gpu=nvidia|intel|apple`, `vram=16`).
  - User-set from the dashboard, e.g. `owner=sam`, `display=1`, `vision=1`.
    Persisted per card identity (machine + label), so they survive reconnects.
- **Selector**: on a job, a list of label requirements (`gpu=nvidia`,
  `owner!=sam`, `vram>=12`). Empty = any card with the model. A "sub-pool" is
  just a label several cards share.
- **Job**: `{ id, name, command, args, cwd, env, models, modelPolicy,
  selector, progress, status, createdAt, startedAt, finishedAt, exitCode }`.
  Status: `queued | running | paused | done | failed | cancelled`.
- **Models on a job**: an ordered preference list, e.g.
  `["gemma4:26b", "gemma4:12b"]`: "a smaller model is fine if it gets more
  cards working". `modelPolicy`:
  - `one` (default): one model for the whole job, chosen at start: the first
    that `minCards` matching online cards have; if none reaches `minCards`,
    the one with the most total slots. The job's `OLLAMA_MODEL` is set to it.
    Consistent output.
  - `any`: each request runs on the best listed model its card has; the host
    rewrites the request's `model` field. Maximum throughput, mixed output.

### Job lifecycle and scheduling

- The queue is an ordered list; the scheduler starts queued jobs in order
  while fewer than `maxRunning` (default 1) are running. A job whose cards
  aren't online waits ("waiting for cards", no timeout) without holding up the
  jobs behind it.
- Starting a job spawns its command with `OLLAMA_URL` and `OLLAMA_HOST` set to
  `http://127.0.0.1:<port>/j/<jobId>`, plus its env. Output goes to
  `<state>/logs/<jobId>.log`.
- Requests on `/j/<jobId>/api/*` are queued with that job id and only leased
  to cards matching the job's selector and model. Leases, re-queue on failure
  or lease expiry (both counted toward max attempts), and "prefer a card that
  hasn't failed it" apply per request. A request whose client went away leaves
  the queue.
- Bare `/api/*` is served as an anonymous job with no selector. All inference
  routes are loopback-only and refuse requests from web pages.
- Contention: a card takes from the job earliest in the queue order, so
  reordering sets priority; the anonymous job ranks last.
- Pause a job: stop leasing its requests (in-flight ones finish). Cancel: kill
  the process tree and drop its pending requests.
- Re-run: clone a finished job to the end of the queue. For resume-by-default
  scripts, re-run means "finish the rest".
- Card pause: a paused card takes no requests and unloads its models.

### Who may create jobs

- **Host CLI** (loopback): any command.
- **Dashboard / other devices** (pool password): only **templates** from
  `rigpool.jobs.json` on the host, with params limited to listed values; plus
  reorder / pause / resume / cancel / re-run and label edits.
- Loopback trust also requires a local `Host` header and no foreign `Origin`,
  so a web page in a browser on the host gets nothing.

### Progress and ETA

- Progress: a `done/total` line on the job's output (pattern overridable), or
  a `POST` to `RIGPOOL_PROGRESS_URL`.
- Per-job ETA from an EMA of the rate; queue ETA sums known parts and counts
  jobs with no total or estimate as unknown rather than guessing.

### Metrics, dashboard, state

- Per-minute counters per card and per job for 24 h, saved every minute;
  inline-SVG graphs.
- Dashboard sections: overview, queue, machines (a rack: one shelf per
  machine, one bay per card), graphs, add-a-machine. Light and dark, usable on
  a phone.
- State dir `./.rigpool/`: `state.json`, `metrics.json`, `logs/`, `token`;
  atomic writes. On restart, running jobs become `failed (host restarted)`;
  `restartable` ones are re-queued at their old place unless their process is
  still alive.
