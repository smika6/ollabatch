# rigpool step 2: the machine agent

## Intent

Today a machine lends its GPUs by hand: quit Ollama's tray app, start one
pinned `ollama serve` per card with the right environment variables, guess a
slot count, type labels, and run one `rigpool join` per card. Step 2 replaces
all of that with one program, `rigpool agent`, installed once per machine. It
finds its cards, runs and tunes their inference servers, manages a model
cache, finds the host, and steps aside when the machine's owner wants the GPU.
The owner controls it from a local page on that machine; the pool owner sees
every machine's hardware from the dashboard.

Audience: people who want their spare GPUs working without babysitting them,
including GPUs in other people's PCs (a partner's gaming PC, a basement box).
Those owners must stay in charge of their own machine.

## Goals

1. **Install once, runs at login.** `rigpool agent install` registers the agent
   to start at login for the current user, no admin rights.
2. **Finds the host.** The host announces itself on the local network; an
   agent shows what it found and joins once given the pool password. A typed
   host URL still works.
3. **Knows its hardware.** Each card's vendor, name, VRAM total/free, use,
   temperature and power where the platform exposes them; reported to the host
   and turned into automatic labels (`gpu=nvidia`, `vram=16`, `display=1`).
4. **Runs one pinned Ollama per card**, on its own port, so cards never share
   a server and the user's own Ollama is left alone.
5. **Sizes each card's concurrency by measurement**, not by guessing memory.
6. **Steps aside for the owner.** Per-machine lending policy, default "pause a
   card while another program is using that GPU".
7. **Local control page** on each machine (loopback only): per-card pause and
   resume, leave/rejoin the pool, lending policy, model cache settings.
8. **Manages a model playground** per machine: a size-limited folder, locked
   models, downloads and evictions driven by what the pool wants and what the
   owner allows; reuses models already on the machine instead of copying them.
9. **Dashboard inventory**: every machine running an agent, including cards it
   isn't lending, with hardware, live VRAM / use / temperature, slots, cache.

## Non-goals (step 2)

- A tray icon or native app (later; it would only open the local page).
- Running before anyone logs in (Windows services, launchd daemons).
- Auto-update of the agent.
- llama.cpp servers or splitting models across machines (step 4).
- Job manifests and host-side model placement (step 3). In step 2 the host only
  says which models are wanted; agents decide.
- Managing the user's own Ollama install or its models.

## Anti-goals

- Touching, counting or deleting models the owner pulled themselves.
- Killing or reconfiguring the user's own Ollama (the tray app keeps working).
- Making a lent PC worse to use: a game starting must free its card quickly.
- Anything on a lent machine that the host can make it run, other than
  inference on models its owner's rules allow.
- New dependencies or a build step. Node >= 20, zero dependencies, as step 1.

## Approaches considered

- **A. An agent that runs the machine's Ollama servers itself.** (Chosen.)
  Needed for pinning, slot tuning (changing slots means restarting a server)
  and model management. Cost: the agent must know how to start Ollama on each
  kind of GPU; that knowledge exists today only in a hand-run script.
- **B. An agent that only watches and reports.** Can't pin, tune or manage
  models. Rejected.
- **C. llama.cpp servers instead of Ollama.** More control and the base for
  step 4, but every machine would need the right llama.cpp build per GPU and
  would lose Ollama's model library. Rejected for step 2; revisit in step 4.

Model reuse: hard links from the user's Ollama store into the playground
(chosen) versus pointing the agent's servers at the user's store with
bookkeeping only. Links keep the playground physically separate (the owner's
words) at no extra disk cost on the same drive.

## Design

### Pieces

```
machine                                  host
┌──────────────────────────────────┐    ┌──────────────────────────┐
│ rigpool agent                    │    │ rigpool host             │
│  ├ discovery listener ◄──────────┼────┤  beacon (UDP broadcast)  │
│  ├ hardware probes               │    │                          │
│  ├ card supervisor ×N            │    │                          │
│  │   ├ ollama serve (pinned)     │    │                          │
│  │   ├ join loop (step 1 code) ──┼───►│  /pool/* (pull work)     │
│  │   └ slot tuner                │    │                          │
│  ├ GPU-in-use watcher            │    │                          │
│  ├ model playground manager ◄────┼────┤  /pool/wants             │
│  ├ machine report (every 10 s) ──┼───►│  /pool/machine           │
│  └ local page 127.0.0.1:11510    │    │  dashboard: inventory    │
└──────────────────────────────────┘    └──────────────────────────┘
```

### Agent state and config

`~/.rigpool/agent/` (overridable with `--dir`):
- `config.json`: host URL, pool password, lending policy, playground path and
  limit, locked models, whether downloads are allowed, per-card overrides
  (disabled, label, extra labels).
- `tuning.json`: best slot count per (card id, model) with the measurement.
- `playground/`: the agent servers' `OLLAMA_MODELS`.
- `logs/ollama-<card>.log`, `logs/agent.log`.

Card id = stable string from vendor + PCI bus id (or index where no bus id).

### Install and startup

`rigpool agent install` / `uninstall`, per user, no admin:
- Windows: a hidden launcher in the user's Startup folder.
- macOS: `~/Library/LaunchAgents/dev.rigpool.agent.plist`, loaded with
  `launchctl bootstrap gui/<uid>`.
- Linux: `~/.config/systemd/user/rigpool-agent.service`, `systemctl --user enable --now`.
`rigpool agent` runs it in the foreground (what the launchers call).

### Discovery

- The host broadcasts a beacon every 5 s on UDP port 11501:
  `{"rigpool":1,"name":"<host machine>","url":"http://<ip>:<port>"}`. It
  carries no password.
- The agent listens on 11501; the local page lists hosts found and asks for
  the pool password to join. Joining saves host URL and password to config.
- Networks that block broadcast (guest Wi-Fi, some mesh systems) fall back to
  typing the URL on the local page or `rigpool agent --host <url>`.

### Hardware probes

Each probe is a function that returns cards or `[]`, never throws, and is
injectable for tests (fixture outputs checked in under `testdata/`).

| Source | When | Gives |
|---|---|---|
| `nvidia-smi --query-gpu=index,pci.bus_id,name,memory.total,memory.free,utilization.gpu,temperature.gpu,power.draw,display_active --format=csv,noheader,nounits` | NVIDIA, any OS | full live stats, `display=1` from `display_active` |
| Windows adapter list (PowerShell `Get-CimInstance Win32_VideoController`) + registry `HardwareInformation.qwMemorySize` | Windows, every GPU | name, vendor, real VRAM (the CIM value caps at 4 GB) |
| Windows `\GPU Adapter Memory(*)\Dedicated Usage` counters | Windows, non-NVIDIA | VRAM used per adapter |
| `system_profiler SPDisplaysDataType -json` + `sysctl hw.memsize` | macOS | chip name, unified memory |
| `rocm-smi --showproductname --showmeminfo vram --showuse --showtemp --json`, else `lspci` | Linux AMD | name, VRAM, use, temp |

Probes run at start and every 10 s for live values (VRAM free, use, temp).
Integrated GPUs below 4 GB of dedicated memory are listed but not lent by
default.

### Card supervisor: one pinned Ollama per card

- Port: `11440 + n` on 127.0.0.1, so it never collides with the user's Ollama
  on 11434.
- Environment per backend (the values the hand-run script uses today):
  - NVIDIA: `CUDA_VISIBLE_DEVICES=<index>`, `OLLAMA_VULKAN=0`.
  - Intel Arc / other Vulkan: `CUDA_VISIBLE_DEVICES=-1`, `OLLAMA_VULKAN=1`,
    `GGML_VK_VISIBLE_DEVICES=<vulkan index>`. The Vulkan index is found by
    starting the server and reading the "inference compute" line in its log;
    if the named device is wrong, the next index is tried.
  - Apple: no pinning (one GPU).
  - All: `OLLAMA_HOST=127.0.0.1:<port>`, `OLLAMA_MODELS=<playground>`,
    `OLLAMA_NUM_PARALLEL=<slots>`, `OLLAMA_KEEP_ALIVE=24h`,
    `OLLAMA_MAX_LOADED_MODELS=1`.
- After start, the supervisor confirms from the log that the server picked the
  intended GPU; a mismatch marks the card "misconfigured" on the local page
  and it is not lent.
- Restarts: on crash (backoff 5 s → 5 min), on slot change, on pause-to-free-VRAM
  is not a restart (it unloads the model, as step 1's pause does).
- Each card runs a step-1 join loop with `slots` = the server's parallel count,
  and registers with its card id, machine, labels and hardware.

### Slot tuning by measurement

Per (card, model), when a card starts serving a model with no saved tuning:
1. Start at 1 slot. Measure items/s over a window of at least 20 completed
   requests or 3 minutes.
2. Step up by 1 (restart the server with the new `OLLAMA_NUM_PARALLEL`) while
   the last step raised items/s by >= 10%, free VRAM after load stays
   >= 1 GB (or 10% of total), and no request failed with an out-of-memory
   error. Cap at 8.
3. Keep the best count; save it to `tuning.json` with the numbers.

While serving (always, not only during tuning), step down one slot when:
- items/s drops below 50% of the tuned rate for 3 consecutive minutes while
  the card has queued work, or
- free VRAM falls under the margin (another program took memory), or
- an out-of-memory error appears.
After a step down, try stepping back up no sooner than 15 minutes later.
Saved tunings are reused on the next start; a tuning older than 7 days or from
a different Ollama version is re-measured.

### Stepping aside: lending policy

Per machine, set on the local page:
- `when-free` (default): pause a card while a fullscreen program is using it
  (a game, a fullscreen video player); resume 3 minutes after it leaves
  fullscreen or exits. Browsers, Discord, video in a window and the desktop
  itself never pause a card, so a card that drives the monitors keeps lending
  while its owner works normally. (Owner's choice: fullscreen-only, accepting
  that a windowed game or a heavy editor doesn't trigger it; Pause on the local
  page covers those.)
- `always`: lend regardless.
- `schedule`: lend only inside time windows (e.g. 01:00–08:00 daily).
- `never`: don't lend; the agent still reports hardware.
Pause = step 1 card pause (no new work, model unloaded, VRAM freed).

*(call)* **The owner has the final say, and pausing is enforced on the
machine.** When the agent pauses a card (owner pressed Pause, or the GPU is
in use), it stops pulling work itself, so it works even while the host is
unreachable, and it reports the reason to the host (`paused-by-owner`,
`paused-in-use`). The dashboard shows the reason; its Resume button can't
override an owner or in-use pause. The dashboard's own Pause still works and
the agent respects it.

*(call)* **Pausing frees the card fast.** In-flight requests are aborted at
once and released back to the host as free retries: a new `/pool/release`
call (`{ worker, ids, reason }`) re-queues them without counting toward
`maxAttempts`, so a few game launches can never fail a job. Then the model is
unloaded. Target: VRAM freed within 15 s of the game starting.

Fullscreen detection (Windows, step 2):
- A program is fullscreen when its foreground window covers its whole monitor
  (exclusive fullscreen and borderless-windowed both count), and it isn't the
  desktop, the taskbar or the lock screen. Checked every 5 s from the
  foreground window's rectangle against its monitor's rectangle.
- Which card it is using: the card(s) where that process shows GPU work in the
  `\GPU Engine(*)\Utilization Percentage` counters (instance names carry
  `pid_<n>` and the adapter's LUID; the agent learns each card's LUID from
  where its own server's process shows up). If the process shows no GPU work,
  the card driving that monitor.
- Starts counting after the program has been fullscreen for 10 s, so alt-tab
  and video players opening briefly don't flap.
- macOS and Linux: not available in step 2; `when-free` acts like `always`
  there and the local page says so.
A check costs well under 1% of a core.

### Model playground

- Folder: `~/.rigpool/agent/playground` by default; owner sets path and size
  limit (default 50 GB).
- The host answers `GET /pool/wants?machine=<name>` with, per card of that
  machine, the models it would be used for *(call)*: the host evaluates
  selectors itself, because dashboard-set and `model:` labels live there.
  "Wanted" means *(call)*: a running job's actual model (`one`) or its list
  (`any`); a queued job's first-choice model only. So a job that settled on
  12b never makes agents fetch the 26b it skipped.
- The owner's rules are the downloads toggle, the size limit and locks
  *(call; no per-model allow-list in step 2)*.
- An agent pulls a wanted model for a card when all hold: downloads allowed on
  this machine; the host listed it for that card; the model's size
  (from the registry manifest, before downloading) fits in the limit after
  evicting unlocked, least-recently-used models; it fits in the card's VRAM
  (model size + 1 GB margin <= VRAM total).
- Reuse: if the model already exists in the user's Ollama store (default
  `~/.ollama/models`, or `OLLAMA_MODELS`), the agent hard-links its blobs and
  manifest into the playground instead of downloading. Linked models count 0
  toward the limit and removing them only removes the links. If the stores are
  on different drives, the model is copied and counts toward the limit.
  Linking is allowed even with downloads off *(call)*: it reads the owner's
  files without changing, moving or counting them, and the local page lists
  which models are linked.
- Pulls go through one of the agent's own servers (`/api/pull`, streamed
  progress), one pull per machine at a time. Evictions use `/api/delete`.
- Locked models are never evicted. A model in use by a running job is never
  evicted.
- Download allowed defaults: on for a machine whose agent was installed with
  `--trusted` (your own), off otherwise until its owner enables it.

### Host additions

- Beacon broadcaster (UDP 11501, on by default, `--no-beacon` to disable).
- *(call)* On a machine that also runs an agent, the host's built-in local
  card (`--local`) switches off: at startup the host checks
  `http://127.0.0.1:11510/status`, and if an agent answers, the agent lends
  that machine's GPUs instead. This avoids two servers on one GPU, which matters
  most on a Mac's shared memory. `--local` still forces it on.
- `POST /pool/release` (authed): re-queue the listed leased requests without
  counting an attempt (owner pause).
- `POST /pool/machine` (authed): machine report every 10 s — agent version,
  OS, cards (id, name, vendor, VRAM total/free, use, temp, power, display,
  state: lending / paused-by-owner / paused-in-use / misconfigured / disabled,
  slots, tuning state), playground (path, limit, used, models with size,
  locked, linked, last used), current download with progress, policy.
- `GET /pool/wants` (authed).
- Dashboard Machines view: shows every reported machine, including cards not
  lending, with a hardware line, VRAM bar, temperature, slots ("2, tuned" /
  "tuning: trying 3"), state reason ("paused: a game is using this GPU"),
  playground usage and download progress. Lending policy and cache settings
  are shown read-only: the machine's owner decides.
- Cards registered by agents carry hardware labels automatically.

### Local page (http://127.0.0.1:11510)

Loopback only, same Host/Origin checks as the host. No password.
- This machine's cards: state, reason, slots, speed, VRAM, temperature;
  Pause / Resume per card; enable/disable lending per card.
- Pool: host found or typed, join with password, Leave pool.
- Lending policy (when-free / always / schedule / never, with schedule editor).
- Playground: path, limit, used, model list with lock toggles and remove;
  downloads allowed toggle.
Same visual language as the dashboard.

### CLI

`rigpool agent [--host url] [--password pw] [--dir path] [--trusted]`,
`rigpool agent install [--trusted] | uninstall`,
`rigpool agent status` (prints what the local page shows).

## Testing

- Probes: parse checked-in sample outputs (nvidia-smi CSV, CIM JSON, counters,
  system_profiler JSON, rocm-smi JSON).
- Supervisor and tuner: run against a fake `ollama` (a Node script on PATH in
  tests) that honours `OLLAMA_HOST` / `OLLAMA_NUM_PARALLEL`, serves `/api/*`,
  and can simulate slowdowns, OOM errors and slow loads.
- Playground: temp-dir stores; link vs copy; eviction order; locks.
- Discovery: beacon send/receive on loopback.
- Acceptance on real hardware (this RTX 5080 + Arc A770 PC, a Mac host):
  both cards pinned and confirmed, slot tuning converges, starting a
  fullscreen game pauses the card it uses within 15 s and resumes 3 minutes
  after it closes, a browser playing video never pauses it, a model is reused
  by link, the dashboard shows the inventory. Development must not disturb
  servers already running on 11434/11435.

## Left to the builder

File layout, exact field names, the fake-ollama design, counter parsing,
schedule editor UI, backoff details, how the Vulkan index search is ordered.
