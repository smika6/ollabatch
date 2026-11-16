# Prior art

Projects near ollabatch's step 2 machine agent, what they do, and what we take
from them. Reviewed November 2026 from each project's README and docs. Ideas
only: no code is copied. llama-paddock is AGPL-3.0, so its code must not be
copied into ollabatch (MIT); the other two are MIT.

## llama-paddock (AGPL-3.0)

<https://github.com/SplendidChip758/llama-paddock>

A dashboard plus an optional single-file Node agent (no npm dependencies) per
Ollama host. The agent edits Ollama's environment and restarts it, tails its
logs, and reports host stats; GPU stats are NVIDIA-only via `nvidia-smi`.
Model management (pull with progress, load, unload, delete) goes through
Ollama's own HTTP API. The agent serves HTTPS with a self-signed key that the
dashboard pins, plus a bearer token.

Taken:
- **Start at login on Windows, not as a service.** They chose a logon task
  because Ollama reads per-user settings and runs in the user's session; the
  same holds for us, and it's also what lets the agent see fullscreen windows.
  Our design already uses the Startup folder; a per-user logon task is an
  equally valid option if the Startup folder proves flaky.
- **Ollama's API can't report GPU stats or change its own settings**, which is
  why an agent has to exist at all. Confirms approach A.
- **Never open Ollama to the network.** Their installer only binds Ollama
  publicly after asking. ollabatch's agent keeps every Ollama on 127.0.0.1 and
  only connects out, so this never comes up.

Not taken: an agent that accepts inbound connections (their agent runs as
root and must be firewalled); ollabatch's agent pulls work outward and its
local page is loopback-only.

## Ollama Admin (MIT)

<https://github.com/ollama-admin/ollama-admin>

A Next.js app with a database and logins that proxies chat traffic to Ollama
servers and logs usage. An optional Python GPU sidecar reports name, memory,
temperature, use and power from `nvidia-smi`, `rocm-smi`, `xpu-smi` (Intel)
or `system_profiler` (Apple). Shows whether a model fits before pulling.

Taken:
- **`xpu-smi` for Intel GPUs** as a probe source, alongside the Windows
  adapter counters, for live Arc stats where it's installed.
- **Fit check before pull**, which the design already requires (model size +
  1 GB margin against VRAM, size read from the registry before downloading).

Not taken: a database, user accounts, or proxying all traffic through a web
app; ollabatch's host keeps state in JSON files and the queue in memory.

## HomeLab Monitor (MIT)

<https://github.com/SikamikanikoBG/homelab-monitor>

Agentless: a hub reaches each machine over SSH, runs a small probe and stores
nothing there. Reads NVIDIA via `nvidia-smi`, AMD via the kernel's sysfs, and
AMD/Intel on Windows via the built-in GPU performance counters. Its benchmark
lab finds the largest context that fits fully in VRAM by measuring.

Taken:
- **Unknown is shown as unknown.** If a driver doesn't report a value, the
  dashboard and local page show "unknown", never a confident 0.
- **Measure, don't estimate**: the same principle as slot tuning.
- **Windows GPU counters for non-NVIDIA cards**, matching the design's choice
  for Arc.
- **Policy checked twice** for anything the host asks a machine to do
  (downloads, evictions): once when asked, again right before acting, against
  the owner's current rules.

Not taken: SSH access from the host into machines. Lent machines (a partner's
PC) shouldn't have to grant the host a shell.

## Ollama Batch Cluster (no license file)

<https://github.com/robert-mcdermott/ollama-batch-cluster>

Python scripts (last pushed November 2024, 36 stars) that batch-process a
JSONL file of prompts across many Ollama servers and collect the answers.
The author found one Ollama with `OLLAMA_NUM_PARALLEL` and
`OLLAMA_SCHED_SPREAD` spread across four GPUs left each at about 25% use, so
he ran one Ollama per GPU pinned with `CUDA_VISIBLE_DEVICES` and
load-balanced prompts across them: 28 GPUs on 7 servers kept above 90% use
for over 24 hours. Servers are listed by hand in a TOML file
(`"host:port" = gpu index`); the client pushes prompts to them; each answer
lands as its own JSON file. No license file, so it is all-rights-reserved by
default: nothing may be copied, only learned from.

Taken:
- **Independent confirmation of one pinned Ollama per GPU.** Their measured
  result (one server spread over several GPUs leaves them mostly idle) is
  the reason the agent runs a server per card.
- **JSONL prompts in, answers out** as the simplest job shape; our
  `examples/batch-prompts.mjs` already works this way.

Not taken: a static, hand-edited server list and a client that pushes to
servers. ollabatch's cards join and leave at any time and pull work, so a
machine going to sleep or a game starting never fails a batch. No queue of
jobs, no resume, no pausing for the owner.

## ollama-batch-processor (MIT)

<https://github.com/hclivess/ollama-batch-processor>

A desktop app (Python, prebuilt binaries, 36 stars, active in 2026) that runs
whole books through one Ollama server: translate, prepare for audiobook
narration, strip book formatting, paraphrase, chunk by chunk with a queue of
files and live progress.

Taken:
- **Write to a temp name and rename into place**, so a stopped or failed run
  never leaves a half-written result. ollabatch's state files already work this
  way; the example job and the docs should recommend it for job output too.
- **Kill every process you spawned on quit, never one the user started
  themself.** Matches the agent's rule of leaving the user's own Ollama alone.
- **Size the context window from the input** so nothing is silently
  truncated: a good practice for job scripts, noted for the examples.

Not taken: one-server, single-machine design; it's an application for one
workload (books), where ollabatch runs any batch job across many machines.

## Earlier survey (before step 1)

Request routers in front of several Ollama servers (Ollama Herd, ollamaMQ,
SOLLOL), serving clusters (GPUStack), and splitting one model across machines
(exo). None combines a resumable batch-job queue with outbound-only workers,
mixed Windows/Mac/NVIDIA/Arc cards, and pausing for the owner.

## Name

The project was renamed from rigpool to **ollabatch** (decided 2026-11-16).
"rigpool" read as crypto mining or render farms and said nothing about Ollama or
batches. Candidates checked against npm and GitHub: `caravan` and `corral`
are heavily taken; `llamanetes` promised Kubernetes complexity, the opposite
of the goal; `homellama` collides with an existing repo and drowns in "home
llama" search results. `ollabatch` is unused on both npm and GitHub, reads
as "Ollama batch" at first glance without using the Ollama trademark as a
word, and names the core of the project: batch jobs. The rename covers the
repository, the command, the `RIGPOOL_*` environment variables (now
`OLLABATCH_*`), the `.rigpool` folder (now `.ollabatch`; an existing one is
moved over on the next start) and the docs, before the first public
announcement.
