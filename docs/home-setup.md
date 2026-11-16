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

## 2. A Windows PC with one GPU

Install Node 20+ (nodejs.org) and Ollama (ollama.com), pull the same model,
then in PowerShell:

```powershell
git clone https://github.com/smika6/ollabatch $HOME\ollabatch
node $HOME\ollabatch\bin\ollabatch.mjs join http://<mac-address>:11500 --password pick-something --labels gpu=nvidia,vram=10
```

Joining only connects out to the Mac, so Windows asks for no firewall changes.
Labels are optional; they let jobs pick cards (see the README). The card shows
up under Machines within a few seconds.

## 3. A Windows PC with several GPUs

Until the machine agent arrives (roadmap step 2), run one Ollama server per
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

## 4. Linux or another Mac joining

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

## When something's off

| You see | Check |
|---|---|
| A card shows "gone" | Its join window is still running and the Mac is reachable: open `http://<mac-address>:11500/` on that PC. |
| A job says "waiting for cards" | No online card matches its selector or has its model. Compare the job's "needs" line with the card's labels and models under Machines. |
| `the host rejected the pool password` | The password is the one given to `ollabatch host`, also saved in `.ollabatch/token` in the folder the host runs from. |
| Nothing can reach the Mac | The macOS firewall is blocking node (step 1.4), or the PC is on a guest network. |
