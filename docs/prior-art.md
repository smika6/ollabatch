# Prior art

Projects near rigpool's step 2 machine agent, what they do, and what we take
from them. Reviewed November 2026 from each project's README and docs. Ideas
only: no code is copied. llama-paddock is AGPL-3.0, so its code must not be
copied into rigpool (MIT); the other two are MIT.

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
  publicly after asking. rigpool's agent keeps every Ollama on 127.0.0.1 and
  only connects out, so this never comes up.

Not taken: an agent that accepts inbound connections (their agent runs as
root and must be firewalled); rigpool's agent pulls work outward and its
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
app; rigpool's host keeps state in JSON files and the queue in memory.

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

## Earlier survey (before step 1)

Request routers in front of several Ollama servers (Ollama Herd, ollamaMQ,
SOLLOL), serving clusters (GPUStack), and splitting one model across machines
(exo). None combines a resumable batch-job queue with outbound-only workers,
mixed Windows/Mac/NVIDIA/Arc cards, and pausing for the owner.
