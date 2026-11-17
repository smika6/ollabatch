# Home setup: a Mac hosts, every PC joins

One machine is the **host**: it keeps the queue, runs the jobs' own code, and
serves the dashboard. Here that's a Mac. Every other computer with a GPU
**joins** and lends its cards. Jobs' commands always run on the host, so only
the Mac needs your project's code; the other machines need only Ollama and a
copy of ollabatch.

## 1. The Mac (host)

1. Install Node 20 or newer and Ollama:

   ```bash
   brew install node
   brew install --cask ollama   # or download it from ollama.com
   ollama pull gemma4:12b       # the model your jobs use
   ```

2. Get ollabatch:

   ```bash
   git clone https://github.com/smika6/ollabatch ~/ollabatch
   ```

3. Start the host from the folder your jobs live in (where your
   `ollabatch.jobs.json` is, if you have one), kept awake for the night:

   ```bash
   cd ~/my-project
   caffeinate -i node ~/ollabatch/bin/ollabatch.mjs host --password pick-something
   ```

   `caffeinate -i` stops the Mac from sleeping while the host runs; keep it
   plugged in. If Ollama is running on the Mac, its GPU joins the pool by
   itself as a card named after the Mac.

4. The first time, macOS asks whether **node** may accept incoming network
   connections. Choose **Allow**. If you missed it: System Settings, Network,
   Firewall, Options, and set node to allow incoming connections.

5. The host prints the dashboard address and a ready-made join command with
   the Mac's address, for example:

   ```text
   listening on :11500
   dashboard: http://127.0.0.1:11500/
   join from another machine: ollabatch join http://192.168.1.20:11500 --password <your password>
   ```

   `ipconfig getifaddr en0` also shows the address. A DHCP reservation for the
   Mac in your router keeps it from changing, so join commands keep working.

6. Open the dashboard: `http://127.0.0.1:11500/` on the Mac (no password
   needed there), or `http://<mac-address>:11500/` from a phone or another
   computer (type the password once; that device remembers it).

## 2. Every other computer: install the agent once

On the computer you want to add (it needs Node.js 20+ and Ollama), open the
dashboard (`http://<mac-address>:11500/`) and go to **Add a machine**. If it's
one of your own PCs, tick **This is one of my own PCs** first (the command
gains `?trusted=1`). Copy the installer for that system and run it in a
terminal:

```powershell
irm http://<mac-address>:11500/install.ps1 | iex      # Windows (PowerShell)
```

```bash
curl -fsSL http://<mac-address>:11500/install.sh | sh  # macOS / Linux
```

No admin rights and no git: it unpacks the Mac's copy of ollabatch, puts the
`ollabatch` command on that computer's PATH, starts the agent now and at every
login, and opens the agent's page, which asks you to confirm lending to the
pool (type the pool password there). From then on, **Lend this PC's GPUs** on
the dashboard is one click on that computer.

The agent does the rest of this guide by itself: it finds each GPU, runs one
Ollama per card pinned to it (the user's own Ollama is left alone), tunes how
many requests each card takes, and steps a card aside while a fullscreen
program uses it. Its page, `http://127.0.0.1:11510/`, is where that computer's
owner pauses cards, sets when to lend and limits the disk models may use.
Installed as trusted (the tick above, or `ollabatch install --trusted`), a
machine downloads the models the pool needs without asking, and the
dashboard can manage it: each machine on the dashboard gets **Manage** for its
lending rules, model space, downloads and models, and each card gets lending
on/off, requests at once, Restart server and Re-tune. Someone else's PC (a
partner's, a roommate's) stays theirs: install it without the tick, and only
its own page changes it, unless its owner ticks **Let the pool manage this
PC** there.

The rest of this guide is for setting machines up **by hand, without the
agent**.

## 2a. By hand: a Windows PC with one GPU

Install Node 20+ (nodejs.org) and Ollama (ollama.com), pull the same model,
then in PowerShell:

```powershell
git clone https://github.com/smika6/ollabatch $HOME\ollabatch
node $HOME\ollabatch\bin\ollabatch.mjs join http://<mac-address>:11500 --password pick-something --labels gpu=nvidia,vram=10
```

Joining only connects out to the Mac, so Windows asks for no firewall changes.
Labels are optional; they let jobs pick cards (see the README). The card shows
up under Machines within a few seconds.

## 2b. By hand: a Windows PC with several GPUs

Without the agent, run one Ollama server per
card yourself, each pinned to its GPU on its own port, then join each one.

1. Quit the Ollama tray app (right-click its icon, Quit) so it doesn't hold
   port 11434 with no GPU pinning.

2. Start one server per card, each in its own PowerShell window:

   ```powershell
   # NVIDIA card (CUDA)
   $env:OLLAMA_HOST = '127.0.0.1:11434'; $env:CUDA_VISIBLE_DEVICES = '0'; $env:OLLAMA_NUM_PARALLEL = '2'
   ollama serve
   ```

   ```powershell
   # Intel Arc card (Vulkan)
   $env:OLLAMA_HOST = '127.0.0.1:11435'; $env:CUDA_VISIBLE_DEVICES = '-1'; $env:OLLAMA_VULKAN = '1'; $env:GGML_VK_VISIBLE_DEVICES = '1'
   ollama serve
   ```

   Each server's log names the GPU it picked ("inference compute ...").
   If the Arc server picks the wrong device, try `GGML_VK_VISIBLE_DEVICES=0`.

3. Join each card, each in its own window:

   ```powershell
   node $HOME\ollabatch\bin\ollabatch.mjs join http://<mac-address>:11500 --password pick-something --ollama http://127.0.0.1:11434 --slots 2 --label "RTX card" --labels gpu=nvidia,vram=16
   ```

   ```powershell
   node $HOME\ollabatch\bin\ollabatch.mjs join http://<mac-address>:11500 --password pick-something --ollama http://127.0.0.1:11435 --slots 2 --label "Arc card" --labels gpu=intel,vram=16
   ```

**A card that also drives your monitors** has less free memory than its size
says. Keep `OLLAMA_NUM_PARALLEL` and `--slots` at 2 for it: at 4 a 16 GB card
running gemma4:12b with the desktop on it slowed from about 2 s to 30 s per
item.

To get a card back for gaming, press **Pause card** on the dashboard: it stops
taking work and unloads its model. **Resume card** puts it back to work.

## 2c. By hand: Linux or another Mac

```bash
git clone https://github.com/smika6/ollabatch ~/ollabatch
node ~/ollabatch/bin/ollabatch.mjs join http://<mac-address>:11500 --password pick-something
```

For several GPUs on Linux, pin one `ollama serve` per card with
`CUDA_VISIBLE_DEVICES=<n> OLLAMA_HOST=127.0.0.1:<port>` and join each with
`--ollama`, as on Windows.

## Stopping

- **A joined card:** Ctrl+C in its join window. It leaves cleanly and the host
  hands its unfinished requests to other cards right away.
- **The host:** Ctrl+C on the Mac. Running jobs stop. Jobs marked
  `restartable` go back in the queue at their old place on the next start;
  scripts that resume by default then finish only what's left.
- Joined machines keep retrying while the host is down and carry on when it
  comes back.

## Watching it run

- **Queue**: each job's progress, speed and time left ("2h 10m left, around
  03:40"). **Details** opens a job's full record.
- **History**: every finished job, searchable, with an optional AI summary
  (History settings) and CSV/JSON export.
- **Insights**: tokens per second, model loads, request and queue times, slot
  use and failures over 1 hour to 30 days. A card that keeps switching models
  gets a warning: that's minutes lost per switch.
- **Machines**: each card's temperature, memory and use as small graphs;
  click them for the card's history.
- **Notify me** (on the Mac's own `127.0.0.1` page): a notification when a job
  finishes or fails. Every page shows those alerts in-page anyway.

## When something's off

| You see | Check |
|---|---|
| A card shows "gone" | Its join window is still running and the Mac is reachable: open `http://<mac-address>:11500/` on that PC. |
| A job says "waiting for cards" | No online card matches its selector or has its model. Compare the job's "needs" line with the card's labels and models under Machines. |
| `the host rejected the pool password` | The password is the one given to `ollabatch host`, also saved in `.ollabatch/token` in the folder the host runs from. |
| Nothing can reach the Mac | The macOS firewall is blocking node (step 1.4), or the PC is on a guest network. |
| A change from the dashboard says "waiting for the PC" | The PC's agent checks in every 10 seconds; if it stays, the PC is off or its agent isn't running. |
| "changed back on the PC" | Its owner changed that setting on the PC after you did. Theirs stands until you change it again. |
| A machine says "managed by its owner" | Its owner hasn't ticked **Let the pool manage this PC** on its page (`http://127.0.0.1:11510/` on that PC). |
| A summary says "no trusted card with a model is online" | Summaries only run on the Mac's own GPU or on PCs the pool manages, and need a model there. |
| The model-switching warning | Several jobs with different models share a card. Give them one model, or selectors that keep them on separate cards. |
