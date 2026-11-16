# ollabatch: job history, AI summaries, inference insights, remote controls

## Intent

The pool works; now the owner wants to **see everything and steer everything**
from the dashboard, verbosely: every job that ever ran and what it did, how
the GPUs actually perform (tokens, speed, model loads), and the machines'
settings and controls, without walking to each PC. Optional AI summaries turn
a finished job into a few readable lines.

The owner asked for it verbose: more detail and more controls are welcome, as
long as the page stays organised and the owner's-final-say promise holds on
other people's machines.

## Goals

1. **Job history**: every finished job, searchable and filterable, with a full
   detail view.
2. **Job details**: status, timings, template and params, model(s), selector,
   per-card contribution, tokens, retries and errors, progress-over-time
   graph, model loads during the job, log viewer (search, download), re-run,
   notes, delete.
3. **AI summaries (optional)**: a short summary of a finished job, written by
   the pool itself; manual per job, or automatic per template or globally.
4. **Inference insights**: tokens per second, prompt vs output tokens, model
   load-ups (count and seconds), queue wait, request latency, slot use, errors;
   per card, per model, per job, over time; live "now" numbers.
5. **Machine insights**: temperature, VRAM used, GPU use and slots over time
   per card, from the agents' reports.
6. **Remote controls**: from the dashboard, for machines whose owner allows
   it: pause/resume and lending on/off per card, lending policy and schedule,
   playground limit and downloads, lock/unlock/remove/pull models, slots
   (auto or fixed), re-tune, restart a card's server, card labels.
7. **Extras**: finished/failed notifications in the browser, history export
   (JSON/CSV), "finishes around 03:40" clock-time ETAs, a warning when a card
   keeps reloading models.

## Non-goals

- Changing how jobs run or how cards are scheduled.
- Accounts or per-user permissions (the pool password stays the only key).
- Summaries by an outside AI service: summaries run on the pool's own GPUs.
- Fixing the checkpoint "sawtooth" in throughput: it's caused by the tag
  scripts pausing to save; that fix belongs to those scripts. The new graphs
  will show it clearly.

## Anti-goals

- Any machine accepting dashboard changes its owner didn't allow.
- Any new inbound port on a lending machine (agents stay outbound-only).
- A dashboard so dense it's unusable on a phone: sections fold, detail lives
  in drill-downs.
- Unbounded disk growth from history, logs or metrics.
- New dependencies or a build step.

## Approaches considered

**Inference numbers**
- **A. Read them from Ollama's answers as they pass through the host.**
  (Chosen.) Every chat/generate answer ends with `prompt_eval_count`,
  `prompt_eval_duration`, `eval_count`, `eval_duration`, `load_duration`,
  `total_duration` (nanoseconds) and `model`; embed answers carry
  `prompt_eval_count`, `load_duration`, `total_duration`. Streamed answers
  carry them on the final `"done": true` line. No code on the machines.
- B. Have agents read Ollama's logs. Agent-only (joiners without the agent
  would report nothing) and fragile. Rejected.

**Remote controls**
- **A. Desired settings + command queue, pulled by the agent.** (Chosen.)
  The host stores the settings the dashboard wants for each machine; the agent
  fetches them on its tick and applies them only if the owner allows remote
  control. One-off actions (restart a server, pull a model now, re-tune) are
  queued commands the agent fetches, runs and acknowledges. Keeps agents
  outbound-only; idempotent; survives restarts.
- B. Host connects into each agent. Needs an inbound port on every lending
  machine. Rejected (anti-goal).
- C. Commands only. Fragile for settings (a lost command = drift). Rejected.

**AI summaries**
- **A. The host asks the pool**: after a job finishes, a short request built
  from the job's facts, stats and log tail goes through the queue at the
  lowest priority. (Chosen.) A job may also hand in its own summary
  (`POST $OLLABATCH_PROGRESS_URL` with `{ "summary": "..." }`), which is used
  instead.
- B. An outside AI API. Needs keys and sends logs off the network. Rejected.

## Design

### 1. Job history and details

**Storage.** Finished jobs already stay in `state.json`. Add per job:
`stats` (totals: requests ok/failed/retried, prompt tokens, output tokens,
generation seconds, load count and seconds, per-card breakdown), `timeline`
(per-minute done counts for the job's life, capped at 1440 points by merging),
`modelsUsed`, `notes`, `summary` (`{ text, model, at, source: 'pool'|'job' }`).
History retention (host settings, *(call)* defaults): keep finished jobs and
their logs for 90 days or the last 2,000 jobs, whichever is smaller; logs over
20 MB are trimmed to the last 20 MB; older entries are pruned daily.
`state.json` stays small: per-job stats are compact; timelines move to
`history/<jobId>.json` when the job finishes.

**API (password).** `GET /ob/history?q=&status=&template=&from=&to=&limit=&before=`
(newest first, cursor paging), `GET /ob/jobs/:id` (full detail incl. stats,
timeline, summary), `PATCH /ob/jobs/:id` (`{ notes }`), `DELETE /ob/jobs/:id`
(finished jobs only; removes log and history file), `GET /ob/jobs/:id/log`
(existing, plus `?download=1` for the whole file and `?q=` to filter lines),
`GET /ob/history/export?format=json|csv`.

**Dashboard.** A **History** section under the Queue: a searchable table
(name, status, finished, duration, items, model, cards, tokens, summary
first line) with filters (status, template, date range) and Export. Clicking a
job opens a **detail view** (a full-width drawer on desktop, a page on a
phone):

```
Royals · enhance                                    done · exit 0
Finished 03:41 · ran 2 h 14 m · 2,515 items · gemma4:12b · selector none
[ Re-run ] [ Summarize ] [ Download log ] [ Delete ]

Summary (pool, gemma4:12b)                                   [Regenerate]
  Tagged 2,515 Royals items with silhouette and kind; 3 items failed twice...

Progress over time        ▁▂▅▇▇▆▇▇▅▇▇▆  (items/min, stacked by card)
Cards     RTX 5080 61% · Arc A770 21% · MacBook 18%
Tokens    1.9 M in · 0.4 M out · 38 tok/s average output speed
Loads     4 model loads, 52 s total (3 on the Arc)
Retries   7 retried, 0 failed · last error: HTTP 500 (Arc, 02:12)
Notes     [ editable text ]
Log       [ search ] ... last 400 lines ...
```

### 2. AI summaries

- Host setting `summaries: 'off' | 'manual' | 'auto'` (default `manual`
  *(call)*); templates may set `"summary": true` to auto-summarize their jobs
  even in manual mode.
- Prompt (fixed, in the host): job name, template and params, status and exit
  code, duration, item counts, stats, last errors, and the last 8 KB of the
  log (or the job's own summary input, below). Ask for 3–6 plain sentences:
  what was done, what failed and why, anything unusual. Temperature 0.2.
- Model: the job's own model if any card still has it, else the host setting
  `summaryModel` (default: the most common model among online cards).
- Runs as a request on a hidden internal job id `_summary` ranked after every
  real job, so it never delays work. Times out after 2 minutes; failure leaves
  the "Summarize" button available.
- Jobs can supply their own summary text through the progress URL; then the
  pool isn't asked.

### 3. Inference insights

**Collection (host).** When a request completes, parse the stats from the
answer body (JSON, or the last NDJSON line), and record into per-minute
buckets per card, per job and per model: requests ok/failed/retried,
prompt tokens, output tokens, prompt seconds, generation seconds, load count
(`load_duration` > 50 ms counts as a load) and load seconds, request seconds,
queue-wait seconds (enqueue → lease). Also per card per minute: average slots
busy / slots. 24 h at 1-minute resolution, 30 days at 1-hour resolution
(rolled up), persisted like today's metrics.

**Dashboard: an Insights section** with a range picker (1 h / 6 h / 24 h /
7 d / 30 d) and a "by card / by model / by job" switch:
- output tokens per second over time (stacked)
- prompt vs output tokens (bars per bucket)
- model loads: markers on a timeline per card, with total load time; a
  warning when a card loads models more than 6 times an hour ("this card keeps
  switching models; give its jobs one model or a selector")
- queue wait and request latency (median and 90th percentile lines)
- slot use per card (busy / total)
- failures and retries over time
- a table per model: requests, tokens in/out, average output tok/s, loads.
Live tiles at the top: output tok/s now, items/min now, models loaded per card.

### 4. Machine insights

Agents' reports (every 10 s) are sampled into per-minute buckets per card:
temperature, VRAM used/total, GPU use, power, slots, state. Per machine
section in **Machines**: small sparklines per card (temp, VRAM, use) with a
detail graph on click (same ranges as Insights). "unknown" values aren't
plotted, never as 0.

### 5. Remote controls

**Owner's switch.** Agent config gains `remote: boolean` ("Let the pool
manage this PC"), shown on the local page. Default `true` for `--trusted`
installs, `false` otherwise. The agent reports it; the dashboard shows
controls only for machines with it on, and says "managed by its owner" for the
rest.

**Desired settings (host → agent).** Host stores per machine
`desired = { version, policy?, schedule?, playground?: { limitGB?, downloads? },
locked?: [], cards?: { [cardId]: { paused?, disabled?, slots?: 'auto' | n,
labels? } } }`. `PUT /ob/machines/:machine/settings` (password; merges,
bumps `version`). The agent fetches `GET /pool/settings?machine=` each tick;
if `remote` is on and `version` is newer than what it applied, it applies
each field through the same `act()` paths the local page uses, saves its
config, and reports `appliedVersion`. Local edits by the owner win: a local
change after a remote one is kept, and the agent reports the conflict
(`localOverride: [...]`) so the dashboard shows "changed on the PC".

**Commands (host → agent).** `POST /ob/machines/:machine/commands`
(`{ type: 'restart-card' | 'retune' | 'pull' | 'remove-model', card?, model? }`)
queues a command with an id; the agent fetches `GET /pool/commands?machine=`
each tick, runs them in order if `remote` is on (else rejects them), and
`POST /pool/commands/:id` acks `{ ok, error? }`. Commands expire after 10
minutes. The dashboard shows each command's state (queued, running, done,
failed, rejected).

**Fixed slots.** `slots: n` pins a card's slot count (the tuner stops);
`'auto'` hands it back to the tuner.

**Dashboard: machine panel.** Under each machine (when `remote` is on): a
settings form (policy, schedule, playground limit, downloads), its model list
with lock/unlock/remove and "Pull a model" (name input + size check), and per
card: Pause/Resume, Lending on/off, Slots (auto / 1–8), Re-tune, Restart
server, Labels. Each control shows its pending state until the agent confirms.

### 6. Extras

- Browser notifications for jobs finishing or failing (opt-in toggle,
  remembered per device), plus an in-page toast.
- Clock-time ETAs ("finishes around 03:40") next to every ETA.
- History export as JSON or CSV.
- A "model thrash" warning (above).

### Constraints carried over

Zero dependencies; Node >= 20; `node:test`; owner's final say; agents
outbound-only; loopback/Host/Origin rules; unknown is shown as unknown; works
on a phone; Windows PowerShell 5.1 files stay ASCII-only.

## Settled after review *(calls)*

1. **Owner vs dashboard: per field, latest change wins, and only while
   "let the pool manage this PC" is on.** Each setting field carries the time
   it was set, both in the host's desired settings and in the agent's config;
   the agent applies a remote field only if it's newer than its local one, so
   an unrelated remote edit can never undo an owner's change. With `remote`
   on, the dashboard may lift a pause the owner set (the owner allowed
   management); it can never lift a *fullscreen* or *schedule* pause, which
   aren't settings. With `remote` off, `ownerHolds` stays exactly as today.
2. **Summaries wait for spare capacity.** The `_summary` request is only
   leased to a card that has nothing queued for it and already has the chosen
   model loaded (or has no model loaded at all), so it never forces a model
   swap on a busy card. The 2-minute timeout runs from the lease; an unleased
   summary gives up after 1 hour and the button comes back.
3. **Summaries only run on trusted cards**: the host's own machine or machines
   with `remote` on, because the prompt contains the job's log. Before
   sending, the host strips lines that look like secrets (`key=`, `token=`,
   `password=`, `Bearer ...`, long base64/hex strings).
4. **Per-card share is by requests served**, labelled "requests"; the
   progress-over-time graph uses the job's own done counts, not stacked by
   card. Per-card request counts get their own small bar.
5. **Labels stay pool-side**: "Edit labels" keeps editing the host's labels
   (they tag cards for job selectors and change nothing on the machine), so
   it needs no owner consent and isn't part of remote control.
6. **Remote actions respect the owner's limits**: a remote pull obeys the
   size limit, locks, the VRAM check and `downloads` (a remote change may turn
   `downloads` on if the owner allowed management); fixed slots are capped at
   8. The local page gets the same new controls (slots auto/fixed, re-tune,
   restart, pull a model).
7. **Notifications**: in-page toasts everywhere; browser notifications only
   where the browser allows them (the host machine's own `127.0.0.1` page);
   the toggle says so on plain-http devices.
8. **`remote` defaults**: `ollabatch install --trusted` saves `trusted: true`
   and turns `remote` on; any config without the field (agents installed
   earlier, untrusted installs) starts with `remote` off. The owner can switch
   it on from the local page.

## Left to the builder

Exact field names in stats and timelines; chart styling; the drawer vs page
breakpoint; the summary prompt's wording; how rollups are stored; how the
settings form batches changes.
