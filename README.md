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
- **Your machine stays yours.** Pause any card from the dashboard and its
  models are unloaded, VRAM freed.
- **No containers, no dependencies.** Node 20+ and Ollama. Windows, macOS,
  Linux; NVIDIA, Intel Arc, Apple silicon, anything Ollama runs on.

## Five minutes

On the machine that will host the queue (it can also have a GPU):

```bash
git clone https://github.com/smika6/ollabatch
cd ollabatch/examples
node ../bin/ollabatch.mjs host --password pick-something
```

It prints the dashboard address and a join command. Open
`http://127.0.0.1:11500/` there, or `http://<host-ip>:11500/` from a phone.
If Ollama runs on the host, its GPU joins automatically.

On every other machine with Ollama and a model pulled
(`ollama pull gemma4:12b`):

```bash
git clone https://github.com/smika6/ollabatch
node ollabatch/bin/ollabatch.mjs join http://<host-ip>:11500 --password pick-something --labels vram=8
```

Then queue work. From the dashboard, **Add job** runs the example template:
it answers the 20 prompts in `examples/example.jsonl`. From the host's
terminal, any command can be a job:

```bash
node ../bin/ollabatch.mjs submit --name "my batch" --model gemma4:12b -- node batch-prompts.mjs example.jsonl out.jsonl
node ../bin/ollabatch.mjs ls
```

`npm link` in the repo puts `ollabatch` on your PATH.

**Step-by-step for a house of machines** (a Mac hosting, Windows PCs with one
or several GPUs joining, pinning one Ollama per card, keeping things awake):
[docs/home-setup.md](docs/home-setup.md).

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
```

`submit`, `ls` and the job commands talk to `--host` (default
`http://127.0.0.1:11500`); from another machine add `--password`.

## Roadmap

1. **Scheduler and dashboard** (this release).
2. **Machine agent**: one daemon per machine that finds its GPUs, starts a
   pinned Ollama per card, pulls models, reports VRAM and temperature, and can
   pause a card automatically while someone is using that PC.
3. **Job files and placement**: job manifests you commit, smarter model
   placement and swapping across cards.
4. **Pooled memory**: run one model too big for any single card across
   several machines. Over home Ethernet this is far slower per token than one
   card; it's for models that don't fit anywhere, not for speed.

## License

MIT
