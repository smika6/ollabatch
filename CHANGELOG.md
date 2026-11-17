# Changelog

Each release names what changed for someone running a pool. Every machine
shows its version: `ollabatch --version`, the dashboard header (the host's),
each machine on the dashboard (its agent's) and the agent's own page. To
update a lending PC, run the installer from **Add a machine** on it again; to
update the host, `git pull` and restart it.

## Unreleased

- Mac GPU power and thermal pressure from `powermetrics`, once its owner
  allows that one command to run without a password (see the README); the
  dashboard shows "thermal nominal" where a temperature would be.

## 0.2.0 (2026-11-17)

**Watching and steering a running pool.**

- **History:** every finished job, searchable and filterable, with CSV/JSON
  export. **Details** on any job: summary, progress over time, each card's
  share, tokens, output speed, model loads, retries and errors, notes, and its
  log with search and download.
- **AI summaries** of finished jobs (off, when asked, or after every job),
  written by your own idle cards, only on cards you control, with
  secret-looking log lines removed first.
- **Insights:** tokens per second, prompt vs output, model loads, request and
  queue times, slot use and failures, by card, model or job, from 1 hour to
  30 days, plus a per-model table. A warning when a card keeps switching
  models; reloading the same model (a restart, a slot change) doesn't count,
  and one reload counts once however many requests waited for it.
- **Hardware per card:** temperature, memory, use and power, as sparklines
  and graphs; the backend each card really runs (CUDA, Vulkan, Metal, MLX);
  Intel Arc temperature, power and use from Intel's control library; Apple
  GPU use and memory; Windows counters for other cards. Unknown stays unknown.
- **Manage your own PCs from the dashboard** when their owner allows it
  ("This is one of my own PCs" at install, or "Let the pool manage this PC"
  on the PC): lending rules, model space, downloads, models, requests at once
  per card, restart and re-tune. A change made on the PC later wins; a game
  still takes its GPU back; downloads keep to the PC's own limits.
- **Lending cleans up:** a card with no work for 5 minutes, or whose host went
  away, frees its GPU memory, says "waiting for the host", and carries on when
  the host is back.
- **The host's own GPU** steps aside for an agent started on its machine, so
  a Mac host gets tuning and hardware reports like every other machine.
- Clock-time ETAs, finish/fail alerts and opt-in browser notifications.
- Versions: this changelog, `ollabatch --version`, and the dashboard flags a
  machine whose agent is on another version than the host.
- A running job's progress graph survives a host restart.
- Fixes: `ollabatch install --host` saved the pool address only after starting
  the agent, which could leave it unjoined; report fields from agents are
  stored typed (no markup from another machine reaches the dashboard).

## 0.1.0 (2026-11-16)

**A batch queue across every GPU in the house.**

- The host: a queue you reorder, pause, cancel and re-run, ETAs, per-card
  throughput, labels and selectors, model preference lists, job templates.
- The machine agent: finds every GPU, runs one pinned Ollama per card, tunes
  requests per card by measuring, lends by the owner's rules (steps aside for
  fullscreen programs), keeps a size-limited model playground that reuses the
  PC's own models, and a local page for its owner.
- One-command install with no admin rights, `ollabatch` on the PATH, a
  **Lend this PC's GPUs** button, and discovery of hosts on the LAN.
