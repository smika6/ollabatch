# ollabatch

Batch AI jobs across every GPU in your house.

You have a gaming PC, an old card in the basement, a laptop, maybe a partner's
PC that sits idle at night. ollabatch turns them into one pool: queue long
jobs on one machine, let any computer running [Ollama](https://ollama.com)
join and take work, and watch and steer it all from one dashboard.

- **A real queue.** Add, reorder, pause, cancel and re-run jobs. ETAs per job
  and for the whole queue, in minutes and clock time ("around 03:40").
- **History you can search.** Every finished job keeps its stats, cards,
  tokens, model loads, errors, notes and log, with an optional AI summary
  written by your own GPUs. Export it as CSV or JSON.
- **Insights.** Tokens per second, prompt vs output, model loads (and a
  warning when a card keeps switching models), request and queue times, slot
  use and failures, by card, model or job, from the last hour to 30 days.
- **Cards join from anywhere on your LAN** with one command. They only connect
  out, so no ports to open on them. Faster cards automatically take more work.
- **Labels steer jobs.** Tag cards (`gpu=nvidia`, `vram=16`, `owner=sam`) and
  give a job a selector (`vram>=12, owner!=sam`); it only runs where it fits.
- **Model lists.** A job can say "26b if enough cards have it, else 12b" and
  ollabatch picks one model for the whole job, or per card if you allow it.
- **Your machine stays yours.** Each machine runs a small agent with its own
  page, where its owner pauses cards, sets when to lend (default: step aside
  while a fullscreen game or video runs) and caps the disk models may use.
- **Your own PCs, from one place.** For PCs whose owner allows it (yours),
  the dashboard changes lending rules, slots and models, and restarts or
  re-tunes cards, with temperature, memory and use graphed per card.
- **It sets each card up itself.** The agent finds every GPU, runs one pinned
  Ollama per card, finds how many requests each card handles best by
  measuring, and reuses models already on the machine instead of copying them.
- **No containers, no dependencies.** Node 20+ and Ollama. Windows, macOS,
  Linux; NVIDIA, Intel Arc, Apple silicon, anything Ollama runs on.

## Five minutes

On the machine that will host the queue (it can also have a GPU):

```bash
git clone https://github.com/smika6/ollabatch
cd ollabatch/examples
node ../bin/ollabatch.mjs host --password pick-something
```

It prints the dashboard address. Open `http://127.0.0.1:11500/` there, or
`http://<host-ip>:11500/` from any device. If Ollama runs on the host, its
GPU joins automatically.

To add a computer, open the dashboard **on that computer** and use **Add a
machine**: the first time, copy its one-line installer (it needs Node.js 20+
and Ollama; no admin rights, no git):

```powershell
irm http://<host-ip>:11500/install.ps1 | iex      # Windows
```

```bash
curl -fsSL http://<host-ip>:11500/install.sh | sh  # macOS / Linux
```

It puts `ollabatch` on that computer's PATH, starts its agent at login and
opens the agent's page, which asks you to confirm lending to your pool. After
that, **Lend this PC's GPUs** on the dashboard is one click on any computer
that has it.

Then queue work. From the dashboard, **Add job** runs the example template:
it answers the 20 prompts in `examples/example.jsonl`. From the host's
terminal, any command can be a job:

```bash
node ../bin/ollabatch.mjs submit --name "my batch" --model gemma4:12b -- node batch-prompts.mjs example.jsonl out.jsonl
node ../bin/ollabatch.mjs ls
```

On the host itself, `node bin/ollabatch.mjs install` puts `ollabatch` on
your PATH too.

**Step-by-step for a house of machines** (a Mac hosting, Windows PCs with one
or several GPUs joining, what the agent does on each):
[docs/home-setup.md](docs/home-setup.md).

## The agent

`ollabatch agent` (started at login by the installer) runs on every lending
machine. Its page, `http://127.0.0.1:11510/`, answers only that machine:

- **Cards**: each GPU's state and why (lending, paused, stepped aside for a
  fullscreen program, off schedule), with Pause / Resume, lending on/off,
  requests at once (measured, or fixed at 1 to 8), Restart and Re-tune per
  card, and which models it has in memory.
- **Let the pool manage this PC**: off unless the agent was installed as
  trusted. With it off, the pool's dashboard can't change anything here. With
  it on, the dashboard can change the settings on this page and restart,
  re-tune or download; a change made here later always wins over an older one
  from the pool.
- **When to lend**: when the GPU is free (Windows: a card steps aside while a
  fullscreen program uses it and comes back 3 minutes after), always, on a
  schedule, or never.
- **Model playground**: a size-limited folder for the models the pool needs.
  Models already on the machine are linked in at no extra space; others are
  downloaded only if the owner allows it; locked models stay; the least
  recently used unlocked ones make room.
- **Slots by measurement**: each card starts at one request at a time and
  climbs while it pays off, backing down if it runs short of memory or slows.

The dashboard's Machines view shows every agent's hardware (VRAM, free memory,
temperature, power; "unknown" where a driver doesn't report it), slots,
models in memory and playground, with sparklines for temperature, memory and
use; click one for that card's graphs over up to 30 days.

## History and AI summaries

**History** lists finished jobs (search by name, model, summary or notes;
filter by result, template and dates; export CSV or JSON). **Details** on any
job opens its record: result and exit code, how long it ran, items over
time, each card's share, tokens in and out, output speed, model loads,
retries and the last errors, your notes, and its log with search and
download. The host keeps up to 2,000 finished jobs for 90 days and trims each
log to its last 20 MB.

**AI summaries** (History settings: off, when I ask, after every job) are a
few plain sentences on what a job did and what went wrong, written by a model
on your cards. They wait behind real work, and they only run on cards you
control (the host's own machine, or PCs whose owner lets the pool manage
them), because the prompt includes the end of the job's log. Lines that look
like keys, tokens or passwords are removed first, and a job's environment is
never sent. A job can also write its own summary:
`POST {"summary": "..."}` to its `OLLABATCH_PROGRESS_URL`.

The page can also tell you when a job finishes or fails: alerts on the page
always, and browser notifications with **Notify me** on the host's own page
(browsers only allow them on `127.0.0.1` or https).

## Insights

Every answer from Ollama carries its own stats; the host records them per
minute for 24 hours and per hour for 30 days. The Insights section graphs
output tokens per second, prompt vs output tokens, model loads per card,
time per request and time waiting in the queue (median and slowest 10%), slot
use per card and failures, split by card, model or job, plus a per-model
table. A card loading models more than 6 times an hour gets a warning: give
its jobs one model, or a selector that keeps them on separate cards.

## Managing your own PCs

Install the agent on your own PCs as trusted: tick **This is one of my own
PCs** under **Add a machine** before copying the installer (it adds
`?trusted=1`), or run `ollabatch install --trusted`. For those PCs (and any
PC whose owner ticks **Let the pool manage this PC** on its page), each
machine on the dashboard gets **Manage**: lending rules and schedule, model
space, downloads, its models (lock, unlock, remove, download one by name),
and per card lending on/off, requests at once, Restart server and Re-tune.
Agents only ever connect out, so a change waits until the PC's next check
(about 10 seconds) and shows "waiting for the PC" until it lands, or
"changed back on the PC" if its owner changed it there since. Requests the PC
never picks up expire after 10 minutes. Two things stay the PC's: a policy set from the
dashboard still steps a card aside while a fullscreen program uses it, and a
download asked for from the dashboard keeps to the PC's own rules (downloads
allowed, fits a card, fits its model space and free disk). Joining a different
pool turns management off until the owner allows it again.

## How it works

A job is a command that runs **on the host**. ollabatch points it at its own
model address (`OLLAMA_URL=http://127.0.0.1:11500/j/<job>`), so every request
the job makes is queued and handed to a card that matches the job. Cards pull
requests over HTTP, run them on their own Ollama and send back the answer.
Your scripts don't change: anything that talks to Ollama works.

Each job also gets `OLLAMA_MODEL` (the model ollabatch chose) and
`OLLABATCH_PROGRESS_URL`. Progress comes from any `done/total` it prints
(`350/1200`), or from a `POST {"done": 350, "total": 1200}` to that URL.

## Labels and selectors

Cards get labels automatically (`machine=<hostname>`, `model:<name>` for each
installed model), from `--labels` when they join, and from **Edit labels** on
the dashboard (saved on the host).

A job's selector is a comma list; every term must hold:

| Term | Meaning |
|---|---|
| `gpu=nvidia` | label equals |
| `owner!=sam` | label differs, or is missing |
| `vram>=12`, `vram<=8` | numeric compare |
| `vision` | label is present |

A "sub-pool" is just a label several cards share. A job whose cards aren't
online waits ("waiting for cards") instead of failing, and doesn't hold up
the jobs behind it.

## Job templates

Free-form commands can only be submitted on the host itself. From other
devices, the dashboard can only start **templates** defined in
`ollabatch.jobs.json` next to where the host runs (or `--jobs <file>`):

```json
{
  "templates": [{
    "id": "prompts",
    "name": "Answer prompts in ${file}.jsonl",
    "command": "node",
    "args": ["batch-prompts.mjs", "${file}.jsonl", "${file}.answers.jsonl"],
    "models": ["gemma4:26b", "gemma4:12b"],
    "minCards": 2,
    "selector": "",
    "params": [{ "name": "file", "values": ["example"], "default": "example" }],
    "estimate": 20,
    "restartable": true
  }]
}
```

Params can only take the listed values. `models` is a preference list:
with the default `"modelPolicy": "one"` ollabatch picks the first model at
least `minCards` matching cards have, and the whole job uses it.
`"modelPolicy": "any"` lets each card use the best listed model it has
(more throughput, mixed output). `estimate` (items) lets the queue ETA include
a job before it starts. `restartable` re-queues the job if the host restarts
while it runs. On Windows, set `"shell": true` for `npm`/`npx` commands.

## Security

ollabatch is for your home network. The pool password (`--password`, or a
random one saved in `.ollabatch/token`) is required to join a card or use the
dashboard from another device. The model API is only reachable from the host
itself (and only to programs, not to web pages open in a browser there), and
jobs' environment variables never leave the host. Job logs are only sent to
cards for AI summaries when those cards are on the host or on PCs whose owner
lets the pool manage them, and with secret-looking lines removed. The
dashboard can change a PC's settings only if its owner allows it on that PC. One read-only endpoint,
`/pool/status`, stays open for older join clients: it shows card names, their
IPs, models and job names to anyone on your network. Don't expose the port to
the internet.

## CLI

```text
ollabatch host   [--port 11500] [--password pw] [--jobs ollabatch.jobs.json] [--max-running 1]
               [--state .ollabatch] [--local http://127.0.0.1:11434] [--local-slots 2] [--no-local]
ollabatch join   <host-url> --password pw [--ollama url] [--slots 2] [--label name] [--labels k=v,...]
ollabatch submit [--host url] --name n [--model m]... [--any-model] [--select selector] [--cwd dir] [--shell] -- <command> [args...]
ollabatch ls | move <job> <index> | pause | resume | cancel | rerun <job> | log <job> [--tail 200]
ollabatch install [--trusted]      # put ollabatch on the PATH, start the agent at login (and now)
ollabatch uninstall
ollabatch agent [--host url] [--password pw] [--trusted]   |   ollabatch agent status
```

`--trusted` is for your own machines: the agent may download models without
asking, and the pool may manage the PC from its dashboard. Otherwise both stay
off until the machine's owner turns them on on its page.

`submit`, `ls` and the job commands talk to `--host` (default
`http://127.0.0.1:11500`); from another machine add `--password`.

## Roadmap

1. **Scheduler and dashboard** (shipped).
2. **Machine agent** (shipped): finds its GPUs, runs a pinned Ollama per card,
   tunes slots, manages a model playground, steps aside for fullscreen
   programs, one-command install and a Lend button.
   Then **insights and controls** (shipped): job history and AI summaries,
   inference and hardware graphs, and managing your own PCs from the dashboard.
3. **Job files and placement**: job manifests you commit, smarter model
   placement and swapping across cards.
4. **Pooled memory**: run one model too big for any single card across
   several machines. Over home Ethernet this is far slower per token than one
   card; it's for models that don't fit anywhere, not for speed.

## License

MIT
