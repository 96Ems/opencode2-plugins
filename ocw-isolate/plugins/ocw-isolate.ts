/**
 * ocw-isolate — opencode2 server plugin (build next-17444, V2 beta API).
 *
 * Isolated session management via overlayfs (see ../bin/ocw):
 *  - GUARD (tool.hook "execute.before"): in the real repo with active ocw
 *    sessions, blocks destructive commands (git checkout --, restore,
 *    reset --hard, clean, stash, rm -rf/-f). In an isolated session, blocks
 *    git push and any command targeting the real repo.
 *  - TOOLS (tools.add): ocw_status, ocw_list, ocw_merge, ocw_up, ocw_down.
 *  - SLASH COMMANDS (command.transform upsert): /ocw_up, /ocw_status, … —
 *    server commands show in the TUI composer ("/" autocomplete).
 *  - AUTOSAVE (tool.hook "execute.after"): commits isolated views after
 *    every mutating tool call.
 *  - SYSTEM PROMPT (session.hook "context"): rules injected per context.
 *
 * The TUI plugin (ocw-actions.tsx) provides the same /ocw_* commands with
 * DIRECT execution (no model call) via the command palette.
 */

import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, join, resolve } from "node:path"
import { homedir } from "node:os"
import {
  type OcwMeta,
  run,
  readMeta,
  activeSessions,
  ocwUp,
  sessionMove,
  unmountAndClean,
  pruneOrphans,
} from "../../shared/ocw-core.ts"

type SessionInfo = { location?: { directory?: string } }

type PluginCtx = {
  options: Record<string, unknown>
  session: {
    get: (input: { sessionID: string }) => Promise<SessionInfo>
    create: (input: {
      title?: string
      agent?: string
      model?: unknown
      location?: { directory?: string; workspaceID?: string }
    }) => Promise<{ id?: string } | undefined>
    hook: (
      name: "context",
      cb: (event: {
        sessionID: string
        agent: string
        model: { id: string }
        system: Array<{ type: string; text: string; cache?: boolean }>
        messages: unknown[]
        tools: Record<string, unknown>
      }) => Promise<void> | void,
    ) => Promise<unknown>
  }
  tool: {
    hook: (
      name: "execute.before" | "execute.after",
      cb: (event: {
        tool: string
        sessionID: string
        agent: string
        messageID: string
        id: string
        input: Record<string, unknown>
      }) => Promise<void> | void,
    ) => Promise<unknown>
    transform: (
      cb: (tools: {
        add: (def: {
          name: string
          description: string
          input: Record<string, unknown>
          execute: (
            args: unknown,
            ctx: { sessionID: string; agent: string; messageID: string; id: string },
          ) => Promise<unknown>
          options?: { namespace?: string; codemode?: boolean }
        }) => void
      }) => Promise<void> | void,
    ) => Promise<unknown>
  }
}

const run2 = promisify(execFile) as (
  file: string,
  args: string[],
  opts?: { cwd?: string; encoding?: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

function destructiveMatch(cmd: string): string | null {
  if (/\bgit\b[^|;&]*\bcheckout\b[^|;&]*(--|\s\.|\s-f\b)/.test(cmd)) return "git checkout --/./-f (file revert)"
  if (/\bgit\b[^|;&]*\brestore\b/.test(cmd)) return "git restore (file revert)"
  if (/\bgit\b[^|;&]*\breset\b[^|;&]*(--hard|--merge|--mixed|--keep)/.test(cmd)) return "git reset --hard/--merge/--mixed (loses changes)"
  if (/\bgit\b[^|;&]*\breset\b\s+[^-]/.test(cmd)) return "git reset <target> (branch move)"
  if (/\bgit\b[^|;&]*\bclean\b/.test(cmd)) return "git clean (deletes untracked files)"
  if (/\bgit\b[^|;&]*\bstash\b/.test(cmd)) return "git stash (files removed from the working tree)"
  if (/\brm\s+-([a-zA-Z]*[fFrR])/.test(cmd)) return "rm -f/-r (file deletion)"
  return null
}

function targetsRepo(cmd: string, repo: string): boolean {
  if (!repo) return false
  const repoPath = resolve(repo)
  if (!cmd.includes(repoPath)) return false
  return /\b(git|rm|mv|cp|touch|mkdir|truncate|tee|shred)\b|>|>>/.test(cmd)
}

function formatDirty(entries: string[]): string {
  if (entries.length === 0) return "clean working tree"
  const lines = entries.slice(0, 25).join("\n")
  return `${entries.length} modified file(s):\n${lines}${entries.length > 25 ? `\n… and ${entries.length - 25} more` : ""}`
}

const NO_ARGS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

// Autosave: commit the isolated view's changes (5s debounce per session).
const autosaveDebounce = new Map<string, number>()
let pruneTimer: ReturnType<typeof setInterval> | undefined
async function autosave(meta: OcwMeta): Promise<void> {
  const now = Date.now()
  const last = autosaveDebounce.get(meta.session) ?? 0
  if (now - last < 5000) return
  autosaveDebounce.set(meta.session, now)
  try {
    const dirty = await run("git", ["-C", meta.merged, "status", "--porcelain"], { encoding: "utf8" })
    if (dirty.stdout.trim().length === 0) return
    await run("git", ["-C", meta.merged, "add", "-A"], { encoding: "utf8" })
    await run("git", ["-C", meta.merged, "commit", "-m", `ocw: ${meta.session} (autosave)`], { encoding: "utf8" })
  } catch {
    // commit failed (missing git identity…) — non-blocking
  }
}

// ---------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------

export default {
  id: "ocw.isolate",
  setup: async (ctx: PluginCtx) => {
    const ocwHome =
      (typeof ctx.options.ocwHome === "string" && ctx.options.ocwHome) ||
      process.env.OCW_HOME ||
      join(homedir(), ".cache", "ocw")

    const sessionDir = async (sessionID: string): Promise<string | undefined> => {
      try {
        const s = await ctx.session.get({ sessionID })
        return s?.location?.directory
      } catch {
        return undefined
      }
    }

    // ---- orphan sweep (dead overlays get removed automatically) -----------
    // A session dir is orphaned once its overlay is unmounted (ocw_down,
    // crashes). The folder may still be held by the server process (cwd);
    // retry every 60s until it can be removed.
    if (pruneTimer) clearInterval(pruneTimer)
    pruneTimer = setInterval(() => void pruneOrphans(ocwHome).catch(() => undefined), 60_000)
    void pruneOrphans(ocwHome).catch(() => undefined)

    // ---- slash commands ---------------------------------------------------
    // The TUI plugin (ocw-actions.tsx) registers /ocw_* as keymap commands
    // with slash.arguments — the composer resolves THOSE directly (no model)
    // and lists them in-session. Server commands are NOT registered here to
    // avoid duplicates in the composer (server commands + keymap slash
    // commands would show twice).

    // ---- guard -----------------------------------------------------------
    await ctx.tool.hook("execute.before", async (e) => {
      if (e.tool !== "bash" && e.tool !== "shell") return
      const cmd = (e.input?.command ?? "") as string
      if (!cmd.trim()) return
      const directory = await sessionDir(e.sessionID)
      if (!directory) return

      const meta = await readMeta(directory)
      if (meta) {
        if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) {
          throw new Error(
            "ocw: `git push` blocked — this session is isolated (private COW view). " +
              "Merge back into the real repo with the ocw_merge tool.",
          )
        }
        if (targetsRepo(cmd, meta.repo)) {
          throw new Error(
            `ocw: command blocked — it targets the real repo (${meta.repo}) from an isolated session. ` +
              "The real repo is managed by other agents; work in your isolated view and merge with ocw_merge.",
          )
        }
        return
      }

      const active = await activeSessions(directory, ocwHome)
      if (active.length === 0) return

      const why = destructiveMatch(cmd)
      if (why) {
        throw new Error(
          `ocw: command blocked (${active.length} active ocw session(s) on this repo). ` +
            `${why} would destroy other agents' work — this working tree is not isolated. ` +
            "Work via `ocw up <name>`, or merge the sessions before touching the tree.",
        )
      }
    })

    // ---- autosave (commit after mutating tools in isolated views) ---------
    await ctx.tool.hook("execute.after", async (e) => {
      if (e.tool !== "bash" && e.tool !== "shell" && e.tool !== "edit" && e.tool !== "write" && e.tool !== "patch" && e.tool !== "apply_patch") return
      const directory = await sessionDir(e.sessionID)
      if (!directory) return
      const meta = await readMeta(directory)
      if (!meta) return
      await autosave(meta)
    })

    // ---- system prompt ----------------------------------------------------
    await ctx.session.hook("context", async (e) => {
      try {
        const directory = await sessionDir(e.sessionID)
        if (!directory) return
        const meta = await readMeta(directory)
        if (meta) {
          e.system.push({
            type: "text",
            text:
              `You are working in an ISOLATED ocw session (private COW view of repo ${meta.repo}). ` +
              "Your changes are visible only in this view: no one can overwrite them. " +
              "Rules: (1) NEVER run git push; (2) NEVER target the real repo with " +
              "git -C / --git-dir / --work-tree / cd, nor rm/mv on it; " +
              "(3) to merge your work back into the real repo, call the ocw_merge tool when you are done.",
          })
        } else {
          const active = await activeSessions(directory, ocwHome)
          if (active.length > 0) {
            e.system.push({
              type: "text",
              text:
                `⚠️ ${active.length} ISOLATED ocw session(s) are currently working on this repo (` +
                active.map((m) => m.session).join(", ") +
                "). Their work is NOT visible in this working tree. " +
                "NEVER run git checkout --, git restore, git reset --hard, git clean, " +
                "git stash, rm -rf or rm -f: these commands would destroy uncommitted work " +
                "(yours or other agents'). To work safely, run `ocw up <name>`.",
            })
          }
        }
      } catch {
        // non-blocking injection
      }
    })

    // ---- tools ------------------------------------------------------------
    const toolDefs = [
      {
        name: "ocw_status",
        description:
          "Callable from code mode as tools.ocw.ocw_status({}), no arguments. " +
          "State of the isolated ocw session (branch, modified files, real repo) — or, in the real repo, " +
          "list the active ocw sessions whose work is not visible here.",
        execute: async (_args: unknown, tctx: { sessionID: string }) => {
          const directory = await sessionDir(tctx.sessionID)
          if (!directory) return { content: "ocw_status: session directory not found." }
          const meta = await readMeta(directory)
          if (!meta) {
            const active = await activeSessions(directory, ocwHome)
            if (active.length === 0) {
              return {
                content:
                  "No active ocw session on this repo. Run `ocw up <name>` (in a terminal) to work isolated.",
              }
            }
            return {
              content:
                `${active.length} active ocw session(s) on this repo (their work is NOT in this working tree):\n` +
                active.map((m) => `  • ${m.session} (branch ${m.branch})`).join("\n"),
            }
          }
          try {
            const status = await run("git", ["-C", meta.merged, "status", "--porcelain"], { encoding: "utf8" })
            const entries = status.stdout.split("\n").filter(Boolean)
            return {
              content: [
                `Isolated ocw session: ${meta.session}`,
                `  real repo: ${meta.repo}`,
                `  branch    : ${meta.branch}`,
                `  ${formatDirty(entries)}`,
                "",
                "To merge your work back into the real repo: ocw_merge.",
              ].join("\n"),
            }
          } catch (err) {
            return { content: `ocw_status: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      },
      {
        name: "ocw_list",
        description: "Callable from code mode as tools.ocw.ocw_list({}), no arguments. " +
          "List active (mounted) ocw sessions on the current repo.",
        execute: async (_args: unknown, tctx: { sessionID: string }) => {
          const directory = await sessionDir(tctx.sessionID)
          if (!directory) return { content: "ocw_list: session directory not found." }
          const active = await activeSessions(directory, ocwHome)
          if (active.length === 0) return { content: "No active ocw session on this repo." }
          return {
            content:
              "Active ocw sessions on this repo:\n" +
              active.map((m) => `  • ${m.session} — view ${m.merged}`).join("\n"),
          }
        },
      },
      {
        name: "ocw_merge",
        description:
          "Callable from code mode as tools.ocw.ocw_merge({}), no arguments. " +
          "Merge the current isolated ocw session into the real repo: commit all changes, " +
          "fetch into the real repo, then git merge. On conflicts, give resolution instructions.",
        execute: async (_args: unknown, tctx: { sessionID: string }) => {
          const directory = await sessionDir(tctx.sessionID)
          if (!directory) return { content: "ocw_merge: session directory not found." }
          const meta = await readMeta(directory)
          if (!meta) {
            return { content: "Cannot merge: this session is not isolated (no ocw meta). You are in the real repo." }
          }
          try {
            const dirty = await run("git", ["-C", meta.merged, "status", "--porcelain"], { encoding: "utf8" })
            if (dirty.stdout.trim().length > 0) {
              await run("git", ["-C", meta.merged, "add", "-A"], { encoding: "utf8" })
              await run("git", ["-C", meta.merged, "commit", "-m", `ocw: ${meta.session}`], { encoding: "utf8" })
            }
            await run("git", ["-C", meta.repo, "fetch", meta.merged, `HEAD:refs/ocw/${meta.session}`], {
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
            })
            const merge = await run(
              "git",
              ["-C", meta.repo, "merge", "--no-edit", `refs/ocw/${meta.session}`],
              { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
            )
            return {
              content: [
                `Session '${meta.session}' merged into ${meta.repo} ✓`,
                merge.stdout.trim().split("\n").slice(-6).join("\n"),
                "",
                "Notify the user: they can now close the session (ocw down) and/or launch other agents on this repo.",
              ].join("\n"),
            }
          } catch (err) {
            const stderr = (err as { stderr?: string })?.stderr ?? String(err)
            return {
              content:
                `ocw_merge: merge failed in ${meta.repo}:\n${stderr.slice(0, 1200)}\n` +
                "If these are CONFLICTS: resolve them (git status / git mergetool) then `git merge --continue`. " +
                "Your isolated view is intact, nothing is lost.",
            }
          }
        },
      },
      {
        name: "ocw_down",
        description: "Callable from code mode as tools.ocw.ocw_down({}), no arguments. " +
          "Mark the ocw session as finished and give cleanup instructions (ocw down).",
        execute: async (_args: unknown, tctx: { sessionID: string }) => {
          const directory = await sessionDir(tctx.sessionID)
          if (!directory) return { content: "ocw_down: session directory not found." }
          const meta = await readMeta(directory)
          if (!meta) return { content: "Cannot: this session is not isolated." }
          const steps: string[] = []
          try {
            await sessionMove(tctx.sessionID, meta.repo)
            steps.push("Session moved back to the real repo.")
          } catch {
            steps.push("Could not move the session back (quit opencode2 and relaunch it from the repo).")
          }
          const res = await unmountAndClean(meta, ocwHome)
          if (res.unmounted) {
            steps.push(`Session '${meta.session}' unmounted.`)
            if (!res.removed) {
              steps.push("Folder left behind (the server still holds it) — run `ocw prune` after quitting opencode2.")
            } else {
              steps.push("Session cleaned up.")
            }
          } else {
            steps.push(
              `Could not unmount now — merge first (ocw_merge), then quit opencode2 and run \`ocw down ${meta.session}\` in a terminal.`,
            )
          }
          return { content: steps.join("\n") }
        },
      },
      {
        name: "ocw_up",
        description:
          "Callable from code mode as tools.ocw.ocw_up({}), no required arguments (optional \"name\"). " +
          "Create a new isolated ocw session on the current repo (frozen snapshot + overlay mount) " +
          "and move this session into that view. Optional name, auto-generated by default. " +
          "Use this when you want to work without risking other agents' changes, or vice versa.",
        input: {
          type: "object",
          properties: { name: { type: "string", description: "Session name (optional, auto-generated by default)" } },
          additionalProperties: false,
        },
        execute: async (args: unknown, tctx: { sessionID: string }) => {
          const directory = await sessionDir(tctx.sessionID)
          if (!directory) return { content: "ocw_up: session directory not found." }
          const meta = await readMeta(directory)
          if (meta) {
            return {
              content:
                `ocw_up: already inside an isolated session ('${meta.session}') — this session is already isolated, no need to create another one here.`,
            }
          }
          const name = typeof (args as { name?: unknown } | null)?.name === "string" ? ((args as { name: string }).name) : undefined
          try {
            const res = await ocwUp(directory, name, ocwHome)
            try {
              await sessionMove(tctx.sessionID, res.merged)
            } catch (err) {
              return {
                content: [
                  `Isolated session '${res.name}' created and mounted at ${res.merged}.`,
                  "But moving this session into it failed: " + (err instanceof Error ? err.message : String(err)).slice(0, 300),
                  `Open it manually: cd ${res.merged} && opencode2`,
                ].join("\n"),
              }
            }
            return {
              content: [
                `Isolated session '${res.name}' created and mounted at ${res.merged}.`,
                "Your current session has been moved into that view (like /cd) — you are now working in isolation.",
                "Changes are auto-saved (autosave commits). Merge back with ocw_merge.",
              ].join("\n"),
            }
          } catch (err) {
            return { content: `ocw_up: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      },
    ]

    await ctx.tool.transform((tools) => {
      for (const def of toolDefs) {
        tools.add({
          ...def,
          input: def.input ?? NO_ARGS,
          options: { namespace: "ocw", codemode: true },
        })
      }
    })
  },
}
