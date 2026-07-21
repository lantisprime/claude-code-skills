# tmux driver — drive CLI agent seats over private tmux sockets

Drive interactive CLI coding agents (pi, codex, REPLs) through per-run **private tmux sockets** and control-file driver scripts. This is the **fallback** for `/herdr-driver` (preferred — its native agent-status waits make supervision event-driven rather than poll-based); use this when `herdr` is unavailable. Core doctrine either way: nothing you `start`, `kill-server`, or break may share a socket with another live session.

**Why private sockets:** tmux sockets and control dirs are cross-session shared mutable state. A driver whose `start` runs `kill-server` on a fixed socket will destroy a sibling session's live seat (this happened; the wreckage was real). Every run therefore gets its own socket name and its own control dir, and existing sockets are treated as owned by someone else.

## When to use

- `/herdr-driver` is preferred; reach for this when `herdr` is unavailable, or the seat is already wired to the tmux drive scripts (`~/.claude/pi-drive.sh`, `~/.claude/codex-drive.sh`) mid-run.
- You need a TTY-driven seat: pi/codex implementer or reviewer, an interactive REPL, anything plain `Bash` can't steer mid-run.

## Instructions

### 1. Claim a private socket + control dir — never a shared one

- **Before anything**: `tmux -L <name> ls` — if ANY session answers, a sibling owns that socket. Do not start, do not kill; pick a fresh name.
- **pi seats** (`pi-drive.sh` reads env overrides):

  ```bash
  export PI_DRIVE_SOCKET="drv-pi-$$"          # private socket
  export PI_DRIVE_DIR="$SCRATCHPAD/pi-drive"  # private control dir — scratchpad, NOT ~/.claude
  export PI_DRIVE_CWD=<worktree>              # seat runs in an isolated worktree
  ```

- **codex seats** (`codex-drive.sh` hard-codes its socket): make a session-scoped copy —

  ```bash
  sed 's/drive-codex-em/drv-codex-'"$$"'/' ~/.claude/codex-drive.sh > "$SCRATCHPAD/codex-drive.sh"
  export CODEX_DRIVE_DIR="$SCRATCHPAD/codex-drive"
  ```

- Control dirs live in the session scratchpad so nothing accumulates in `~/.claude` (43 stale seat-run dirs were swept from there on 2026-07-21 — don't rebuild the pile).
- Some socket names may be user-allowlisted for permission-free `send-keys`/`capture-pane` (check `~/.claude/settings.json`); still verify occupancy first — allowlisted ≠ yours.

### 2. Drive via the control-file protocol

Write the action to `$DIR/control` (line 1: `start|ask|send|key|poll|wait|read|stop`; line 2: literal text/keyname for `send`/`key`), put prompts in `$DIR/prompt.txt`, then run the script:

```bash
printf 'start\n' > "$PI_DRIVE_DIR/control" && bash ~/.claude/pi-drive.sh
printf '%s\n' "<task brief>" > "$PI_DRIVE_DIR/prompt.txt"
printf 'ask\n' > "$PI_DRIVE_DIR/control" && bash ~/.claude/pi-drive.sh
```

This single-shape design exists so the checkpoint classifier asks once per session — keep to it; don't bypass the script with raw `tmux send-keys` except on your own private socket for keys the script lacks.

### 3. Supervise interactively — poll the driver, scan for approvals, steer

- **Sync on the driver's `poll`/`wait` actions, never on whole-pane greps** — grepping scrollback for "Working" lies as soon as a report quotes the word. If you must sample, compare consecutive `read` outputs or token counters for change.
- **Approval dialogs**: `read` (read-only capture) FIRST to see the dialog, then answer via `send`/`key` in a SEPARATE invocation — bundling look+approve gets denied as approving unseen. Auto-approve **read-only** operations only (git status/log/diff, file reads, ls, grep). Writes, stashes, deletes, pushes, installs, network: leave the dialog up and surface the quoted text to the user.
- **Questions from the seat**: answer via `prompt.txt` + `ask` (or `send`) when unambiguous from the brief; otherwise surface verbatim.
- **Drift/stall**: seat replanning repeatedly without artifacts, or looping on one error → send a short corrective instruction and confirm uptake on the next poll; after two failed steers, `stop` and report rather than fight it.
- **Permission-mode escalation** (pi `/permissions mode auto` etc.): only with the user's explicit say-so, sent mid-session — never baked into the launch command.

### 4. Tear down — always, including on failure

```bash
printf 'stop\n' > "$DIR/control" && bash <driver>   # per seat
tmux -L "$PI_DRIVE_SOCKET" kill-server 2>/dev/null  # YOUR private socket only
rm -rf "$DIR"                                       # your control dir (scratchpad)
```

Never issue kill/start against a socket you didn't create this run — if you collided with a sibling, finish read-only (`capture-pane -p`) and vacate; they restart their own.

## Safety

- An occupied socket is a sibling's seat: read-only access at most, no `kill-server`, no `start`.
- Seats run in isolated git worktrees; a reviewer seat once ran `git stash` and wiped builder work — hence the read-only-only auto-approve line above.
- Never leave per-run control dirs or sockets behind; teardown runs on success, error, and abort alike.

## Output

Report: socket names and control dirs used, seats driven (script, argv/model, worktree), key interactions with quoted pane text, and confirmation that every private socket was killed and every control dir removed.
