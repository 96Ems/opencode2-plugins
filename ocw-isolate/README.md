# ocw-isolate — isolated opencode sessions via overlayfs

Each opencode session works in its own **COW view** of the repo (overlayfs:
`lowerdir` = frozen snapshot of the repo, `upperdir` = private to the
session). An agent **physically cannot** destroy another agent's work:

- `git checkout --`, `rm -f`, `git reset --hard` in session A only touch A's
  view (its `upperdir`).
- Each view has a **private `.git`** (copied up into the upperdir): no
  `index.lock` races, no torn reads (the lower is a frozen snapshot, never
  modified while mounted — this fixes the oh-my-pi #4627 bug class).
- Merge back is explicit, into the real repo, via `git fetch + merge`
  (conflicts handled by git, nothing is lost).

## Contents

| File | Role |
| --- | --- |
| `bin/ocw` | Bash launcher: `up` (snapshot + mount + launch opencode2), `merge`, `down`, `list`, `status`, `prune` |
| `plugins/ocw-isolate.ts` | opencode2 server plugin: destructive-command guard, `ocw_status`/`ocw_merge`/`ocw_list`/`ocw_down` tools, system-prompt rules |

## Installation

1. Declare the server plugin in `~/.config/opencode/opencode.jsonc`:

   ```jsonc
   {
     "plugin": ["/path/to/opencode2-plugins/ocw-isolate/plugins/ocw-isolate.ts"]
   }
   ```

2. Put `bin/ocw` on your PATH:

   ```sh
   ln -s /path/to/opencode2-plugins/ocw-isolate/bin/ocw ~/.local/bin/ocw
   ```

3. Mounting: `fuse-overlayfs` if installed (rootless), otherwise `sudo mount`
   (or add a sudoers rule to avoid the password prompt; set `OCW_MOUNT=fuse`
   to force rootless).

## Usage

```sh
cd ~/your/project

ocw                       # start an isolated session (auto-named) + opencode2
ocw feature-A             # same, with an explicit name
                          # (on exit: merge + cleanup prompts)

ocw list                  # sessions mounted/dead + change counts
ocw merge                 # merge the session (auto-selected if unique)
ocw down                  # unmount + delete (after exiting opencode2)
ocw prune                 # remove dead sessions
```

From the TUI you also have direct slash commands (executed client-side,
**no model call**): `/ocw_up` (mounts the overlay and moves the current
session into the view, like `/cd` — via `POST /api/session/<id>/move`),
`/ocw_status`, `/ocw_list`, `/ocw_merge`, `/ocw_down` (moves the session
back to the real repo, unmounts and cleans up). The agent also has the
`ocw_*` tools, and rules are injected into its system prompt. Changes in
isolated views are auto-committed (autosave) after each tool call, so a
brutal `/exit` never loses work.

## Real-repo guard

The plugin's `tool.execute.before` hook blocks (when ocw sessions are active
on the repo): `git checkout --`, `git checkout .`, `git checkout -f`,
`git restore`, `git reset --hard/--merge/--mixed`, `git reset <target>`,
`git clean`, `git stash`, `rm -rf/-f`. Inside an isolated session it blocks
`git push` and any command targeting the real repo.

## Notes / limitations

- **Snapshot = committed repo state** (`git clone --no-hardlinks`, no
  untracked files). Uncommitted changes in the real repo are not copied —
  intended: each agent starts from a clean base.
- **ext4**: the clone is a full copy (O(tree) per session). On btrfs/xfs,
  replace with `cp --reflink=auto` for O(1) cost (not implemented here).
- Sessions don't see each other live: changes become visible after
  `ocw merge` (other sessions can then fetch/rebase).
- `ocw up` refuses to start inside an already-isolated view.
- If the real repo is modified elsewhere while a session runs: the session is
  unaffected (the lower is frozen by construction).
- `OCW_HOME` (default `~/.cache/ocw`): no spaces allowed in the path (mount).
