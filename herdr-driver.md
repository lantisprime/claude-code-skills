# Herdr driver — drive terminals and CLI agents via a private Herdr session

Drive interactive terminals and CLI coding agents (codex, pi, claude, plain shells) through the [Herdr](https://herdr.dev) socket API, using a **private, throwaway Herdr session with its own socket** for every driver run. Never drive through the user's default session.

> `/tmux-driver` is the **preferred** seat driver; use this one when tmux or the drive scripts are unavailable, or when the user asks for Herdr.

**Why private sockets (lesson from cmux/tmux driver sockets):** shared driver sockets are cross-session shared state. One session running `start` or `server stop` on a shared socket kills a sibling session's server and wipes its live seats. A per-run named session gives you an isolated socket path (`~/.config/herdr/sessions/<name>/herdr.sock`), so nothing you start, stop, or break can touch the user's interactive workspace or another driver's seats.

Verified against Herdr 0.7.4 (protocol 16).

## When to use

- You need to run and steer an interactive CLI agent (pi, codex, a REPL, an ssh session) that can't be driven by plain `Bash` because it needs a real TTY, keystrokes, or mid-run interaction.
- You need to babysit a seat: wait for it to go idle/blocked, read its screen, answer its prompts.
- `/tmux-driver` (the preferred driver) can't run — no tmux, no drive scripts — or the user asked for Herdr. One advantage this transport keeps: Herdr reports agent status natively (`idle|working|blocked|done`), avoiding scrollback-grep false positives.

Do **not** use the driver to manipulate panes in the user's `default` Herdr session unless the user explicitly asks for that; then target those panes read-mostly and never `server stop` them.

## Instructions

All driving happens through the `herdr` CLI. **Every command must carry `--session "$S"`** — a call without it silently targets the user's default session, which is exactly the cmux failure mode this skill exists to prevent.

1. **Pick a unique session name** and check for collisions:

   ```bash
   S="drv-$(basename "$PWD")-$$"
   herdr session list --json   # confirm $S is not already listed; if a stale drv-* is listed and not running, herdr session delete <it>
   ```

2. **Start a private headless server** and wait until it reports running:

   ```bash
   herdr server --session "$S" >/dev/null 2>&1 &
   for i in 1 2 3 4 5; do
     herdr session list --json | grep -q "\"name\":\"$S\",\"running\":true" && break
     sleep 1
   done
   ```

   (Field order check is fine for this JSON; use `jq -e '.sessions[]|select(.name==env.S).running'` if available.)

3. **Spawn the seat** (repeat per seat; each gets its own workspace):

   ```bash
   herdr agent start <label> --session "$S" --cwd <path> -- <argv...>
   # e.g. ... -- pi   |   -- codex   |   -- bash
   ```

   Note the `pane_id` (e.g. `w1:p1`) from the JSON result.

4. **Drive it.** Three send modes — pick deliberately:
   - `herdr pane run <pane_id> '<command>' --session "$S"` — types the text **and presses Enter**. Use for shell commands.
   - `herdr agent send <target> '<text>' --session "$S"` — **literal text, no Enter**. Use for filling an agent's prompt box, then follow with `send-keys`.
   - `herdr pane send-keys <pane_id> enter --session "$S"` — individual keys (enter, escape, up, ctrl-c, …). Use for menus and confirmations.

5. **Synchronize on state, not on grepped scrollback.** Whole-pane text greps lie once earlier output quotes the marker (the "Working-grep false positive" lesson). Prefer, in order:
   - `herdr agent wait <target> --status idle --timeout 120000 --session "$S"` — blocks until the agent integration reports the status.
   - `herdr wait output <pane_id> --match '<regex>' --regex --timeout 60000 --session "$S"` — blocks on **new** output matching; emit a unique sentinel (e.g. `echo done-$RANDOM`) and wait for that exact value rather than a generic word.

6. **Read the screen** when you need to see what the seat is doing or answer a dialog:

   ```bash
   herdr pane read <pane_id> --source recent-unwrapped --lines 60 --session "$S"
   ```

7. **Supervise interactively — scan for approvals, steer the seat.** Driving is not fire-and-forget: run a supervision loop until the seat's work is done.

   ```
   loop:
     herdr agent wait <target> --status blocked --timeout 90000 --session "$S"   # or --status idle
     herdr pane read <pane_id> --source recent-unwrapped --lines 60 --session "$S"
     classify the screen, then act (below); repeat until the task is complete
   ```

   - **Approval dialog on screen** (permission prompt, y/N confirmation, "allow this command?"): always read the dialog with `pane read` **first**, then answer with `send-keys` in a **separate** command — never bundle look+approve. Auto-approve only **read-only** operations (`git status/log/diff`, file reads, ls, greps). Anything that writes, stashes, deletes, pushes, installs, or touches the network: leave the dialog up and surface it to the user with the quoted dialog text.
   - **Seat asking a question / waiting for input**: answer it if the answer is unambiguous from the task brief (`agent send` the text, then `send-keys enter`); otherwise surface the question to the user verbatim.
   - **Seat drifting or stuck** (replanning repeatedly without producing artifacts, working on the wrong file, looping on the same error): steer it — send a short corrective instruction ("stop replanning; implement X in file Y, then run the tests"), press enter, then `agent wait --status working` to confirm uptake. If it drifts twice after steering, stop the seat and report instead of fighting it.
   - **`wait` timed out while status is `working`**: read the screen to check real progress before waiting again — output advancing is fine; the same screen twice in a row means it's hung (send `ctrl-c` via `send-keys` only if the task brief allows interrupting, else surface).
   - **Status `done` or `idle` after output**: read the final screen, verify the expected artifact/result actually exists (run the real check, don't trust the seat's claim), then proceed to teardown.

8. **Tear down — always, including on failure.** Before ending the run (success, error, or abort):

   ```bash
   herdr session stop "$S" --json
   herdr session delete "$S" --json
   ```

   Confirm with `herdr session list --json` that only sessions you did not create remain.

## Safety

- **Never run `herdr server stop` or bare `herdr session stop default`** — both kill the user's live interactive server and every seat in it.
- **Never omit `--session "$S"`.** If a command errors with `NotFound` on the socket, the private server died — restart it with step 2; do not fall back to the default session.
- Dialog-babysitting rule carries over: when auto-answering an agent's permission prompts inside a driven seat, auto-approve **read-only** operations only (e.g. read-only git); anything that writes, stashes, or deletes gets surfaced to the user.
- Clean up stale `drv-*` sessions you find at startup (stopped ones: delete; running ones: leave — they belong to a sibling driver run).

## Output

Report: session name used, seats spawned (label, argv, pane id), the key interactions and their observed results (quote the relevant pane text), and confirmation that the private session was stopped and deleted.
