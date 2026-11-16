# ollabatch

Batch AI jobs across every GPU in your house.

You have a gaming PC, an old card in the basement, a laptop, maybe a partner's
PC that sits idle at night. ollabatch turns them into one pool: queue long
jobs on one machine, let any computer running [Ollama](https://ollama.com)
join and take work, and watch and steer it all from one dashboard.

- **A real queue.** Add, reorder, pause, cancel and re-run jobs. ETAs per job
  and for the whole queue, speed graphs per card.
- **Cards join from anywhere on your LAN** with one command. They only connect
  out, so no ports to open on them. Faster cards automatically take more work.
- **Labels steer jobs.** Tag cards (`gpu=nvidia`, `vram=16`, `owner=sam`) and
  give a job a selector (`vram>=12, owner!=sam`); it only runs where it fits.
- **Model lists.** A job can say "26b if enough cards have it, else 12b" and
  ollabatch picks one model for the whole job, or per card if you allow it.
- **Your machine stays yours.** Each machine runs a small agent with its own
  page, where its owner pauses cards, sets when to lend (default: step aside
  while a fullscreen game or video runs) and caps the disk models may use.
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
  fullscreen program, off schedule), with Pause / Resume and lending on/off
  per card. The pool's dashboard can't override the owner.
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
temperature, power; "unknown" where a driver doesn't report it), slots and
playground.

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
jobs' environment variables never leave the host. One read-only endpoint,
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

`--trusted` lets the agent download models without asking (for your own
machines); otherwise downloads stay off until the machine's owner allows them
on its page.

`submit`, `ls` and the job commands talk to `--host` (default
`http://127.0.0.1:11500`); from another machine add `--password`.

## Roadmap

1. **Scheduler and dashboard** (shipped).
2. **Machine agent** (shipped): finds its GPUs, runs a pinned Ollama per card,
   tunes slots, manages a model playground, steps aside for fullscreen
   programs, one-command install and a Lend button.
3. **Job files and placement**: job manifests you commit, smarter model
   placement and swapping across cards.
4. **Pooled memory**: run one model too big for any single card across
   several machines. Over home Ethernet this is far slower per token than one
   card; it's for models that don't fit anywhere, not for speed.

## License

MIT
