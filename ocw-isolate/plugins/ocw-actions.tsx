/** @jsxImportSource @opentui/solid */
/**
 * ocw-actions — plugin TUI opencode2 (build next-17444).
 *
 * Slash commands à exécution DIRECTE (zéro tour de modèle) :
 *   /ocw_up      crée + monte une session isolée et déplace la session courante dedans
 *   /ocw_status  état de la session
 *   /ocw_list    sessions actives du repo
 *   /ocw_merge   merge la vue isolée dans le repo réel
 *   /ocw_down    revient au repo réel + unmount
 *
 * Enregistrer dans ~/.config/opencode/cli.json (plugins TUI) :
 *   { "plugins": ["/home/emericclement/dev/opencode2-plugins/ocw-isolate/plugins/ocw-actions.tsx"] }
 */

import { Show, onCleanup, onMount } from "solid-js"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  readMeta,
  activeSessions,
  ocwUp,
  mergeSession,
  unmountAndClean,
} from "/home/emericclement/dev/opencode2-plugins/shared/ocw-core.ts"

const id = "ocw-actions"

type Route = { type: string; sessionID?: string; id?: string; name?: string }

type PluginCtx = {
  theme: {
    text: {
      default: string
      subdued: string
      feedback: {
        success: { default: string }
        warning: { default: string }
        error: { default: string }
        info: { default: string }
      }
    }
    border: { default: string }
  }
  client: {
    session: {
      move: (input: { sessionID: string; directory: string }) => Promise<unknown>
    }
  }
  data: {
    session: {
      get: (sessionID: string) => { location?: { directory?: string } } | undefined
    }
  }
  ui: {
    router: {
      current: () => Route
    }
    dialog: {
      show: (render: () => unknown, onClose?: () => void) => void
      set: (opts: { size?: "medium" | "large" | "xlarge" }) => void
      clear: () => void
    }
  }
  keymap: {
    layer: (
      cb: () => {
        mode?: string
        commands?: Array<{
          id: string
          title?: string
          bind?: string
          slash?: { name: string; arguments?: boolean }
          group?: string
          palette?: boolean
          run: (args?: string) => void | Promise<void>
        }>
      },
    ) => () => void
  }
}

const OCW_HOME = process.env.OCW_HOME ?? join(homedir(), ".cache", "ocw")

function sessionDir(ctx: PluginCtx): string | undefined {
  const route = ctx.ui.router.current()
  if (route?.type !== "session" || !route.sessionID) return undefined
  return ctx.data.session.get(route.sessionID)?.location?.directory
}

function ResultDialog(props: { ctx: PluginCtx; title: string; lines: string[]; error?: string }) {
  const t = props.ctx.theme
  let offLayer: (() => void) | undefined
  onMount(() => {
    props.ctx.ui.dialog.set({ size: "large" })
    offLayer = props.ctx.keymap.layer(() => ({
      mode: "modal",
      commands: [
        {
          id: "ocw.result.close",
          title: "Close",
          bind: "escape",
          run: () => props.ctx.ui.dialog.clear(),
        },
      ],
    }))
  })
  onCleanup(() => offLayer?.())
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column" height="100%">
      <text fg={t.text.default}>
        <b>{props.title}</b>
      </text>
      <scrollbox scrollY flexGrow={1}>
        <Show when={!props.error} fallback={<text fg={t.text.feedback.error.default}>{props.error}</text>}>
          <box flexDirection="column" gap={0}>
            {props.lines.map((l) => (
              <text fg={l.startsWith("Session") ? t.text.feedback.success.default : t.text.default}>{l}</text>
            ))}
          </box>
        </Show>
      </scrollbox>
      <text fg={t.text.subdued}>esc close</text>
    </box>
  )
}

function show(ctx: PluginCtx, title: string, lines: string[] | null, error?: string) {
  ctx.ui.dialog.show(() => <ResultDialog ctx={ctx} title={title} lines={lines ?? []} error={error} />)
}

function showError(ctx: PluginCtx, title: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  show(ctx, title, null, msg.slice(0, 1500))
}

// --- actions ---------------------------------------------------------------

async function actionUp(ctx: PluginCtx, name?: string) {
  const dir = sessionDir(ctx)
  if (!dir) return showError(ctx, "ocw_up", "not in a session — open a session first")
  const meta = await readMeta(dir)
  if (meta) {
    return show(ctx, "ocw_up", [`Already inside an isolated session ('${meta.session}').`])
  }
  try {
    const res = await ocwUp(dir, name || undefined, OCW_HOME)
    const route = ctx.ui.router.current()
    if (route?.type !== "session" || !route.sessionID) {
      return show(ctx, "ocw_up", [
        `Isolated session '${res.name}' created and mounted at ${res.merged}.`,
        "No active session to move — open it manually: cd " + res.merged + " && opencode2",
      ])
    }
    try {
      await ctx.client.session.move({ sessionID: route.sessionID, directory: res.merged })
      show(ctx, "ocw_up", [
        `Isolated session '${res.name}' created and mounted.`,
        `This session has been moved into the view (${res.merged}).`,
        "You are now working in isolation — changes are auto-saved, merge with /ocw_merge.",
      ])
    } catch (err) {
      show(ctx, "ocw_up", [
        `Isolated session '${res.name}' created and mounted at ${res.merged}.`,
        "But moving this session failed: " + String(err).slice(0, 300),
        "Open it manually: cd " + res.merged + " && opencode2",
      ])
    }
  } catch (err) {
    showError(ctx, "ocw_up", err)
  }
}

async function actionStatus(ctx: PluginCtx) {
  const dir = sessionDir(ctx)
  if (!dir) return showError(ctx, "ocw_status", "not in a session")
  const meta = await readMeta(dir)
  if (!meta) {
    const active = await activeSessions(dir, OCW_HOME)
    if (active.length === 0) return show(ctx, "ocw_status", ["No active ocw session on this repo. Use /ocw_up."])
    return show(ctx, "ocw_status", [
      `${active.length} active ocw session(s) on this repo (their work is NOT in this working tree):`,
      ...active.map((m) => `  • ${m.session} (branch ${m.branch})`),
    ])
  }
  const { run } = await import("../../shared/ocw-core.ts")
  try {
    const status = await run("git", ["-C", meta.merged, "status", "--porcelain"], { encoding: "utf8" })
    const entries = status.stdout.split("\n").filter(Boolean)
    const dirty = entries.length === 0 ? "clean working tree" : `${entries.length} modified file(s)`
    show(ctx, "ocw_status", [
      `Isolated ocw session: ${meta.session}`,
      `  real repo: ${meta.repo}`,
      `  branch:    ${meta.branch}`,
      `  ${dirty}`,
      ...entries.slice(0, 25),
    ])
  } catch (err) {
    showError(ctx, "ocw_status", err)
  }
}

async function actionList(ctx: PluginCtx) {
  const dir = sessionDir(ctx)
  if (!dir) return showError(ctx, "ocw_list", "not in a session")
  const active = await activeSessions(dir, OCW_HOME)
  if (active.length === 0) return show(ctx, "ocw_list", ["No active ocw session on this repo."])
  show(ctx, "ocw_list", [
    "Active ocw sessions:",
    ...active.map((m) => `  • ${m.session} — ${m.merged}`),
  ])
}

async function actionMerge(ctx: PluginCtx) {
  const dir = sessionDir(ctx)
  if (!dir) return showError(ctx, "ocw_merge", "not in a session")
  const meta = await readMeta(dir)
  if (!meta) return showError(ctx, "ocw_merge", "this session is not isolated (no ocw meta)")
  try {
    const summary = await mergeSession(meta)
    show(ctx, "ocw_merge", [`Session '${meta.session}' merged into ${meta.repo} ✓`, summary])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showError(ctx, "ocw_merge", msg + " — resolve conflicts in " + meta.repo + " (git mergetool) then `git merge --continue`")
  }
}

async function actionDown(ctx: PluginCtx) {
  const dir = sessionDir(ctx)
  if (!dir) return showError(ctx, "ocw_down", "not in a session")
  const meta = await readMeta(dir)
  if (!meta) return showError(ctx, "ocw_down", "this session is not isolated (no ocw meta)")
  const steps: string[] = []
  const route = ctx.ui.router.current()
  if (route?.type === "session" && route.sessionID) {
    try {
      await ctx.client.session.move({ sessionID: route.sessionID, directory: meta.repo })
      steps.push("Session moved back to the real repo.")
    } catch {
      steps.push("Could not move the session back (relaunch opencode2 from the repo).")
    }
  }
  const res = await unmountAndClean(meta, OCW_HOME)
  if (res.unmounted) {
    steps.push(`Session '${meta.session}' unmounted.`)
    steps.push(res.removed ? "Session cleaned up." : "Folder left behind — run `ocw prune` after quitting opencode2.")
  } else {
    steps.push(`Could not unmount now — quit opencode2 and run \`ocw down ${meta.session}\` in a terminal.`)
  }
  show(ctx, "ocw_down", steps)
}

// --- module -----------------------------------------------------------------

function OcwCommands(props: { ctx: PluginCtx }) {
  let off: (() => void) | undefined
  onMount(() => {
    // keymap.layer must be called from inside the TUI tree (Keymap.Provider),
    // i.e. from a mounted component — not from setup().
    off = props.ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ocw.up",
          title: "Start an isolated ocw session (move this session into it)",
          slash: { name: "ocw_up", arguments: true },
          group: "OCW",
          palette: true,
          run: (args) => void actionUp(props.ctx, args?.trim() || undefined),
        },
        {
          id: "ocw.status",
          title: "Show ocw isolation state of this session",
          slash: { name: "ocw_status", arguments: true },
          group: "OCW",
          palette: true,
          run: () => void actionStatus(props.ctx),
        },
        {
          id: "ocw.list",
          title: "List active ocw sessions on this repo",
          slash: { name: "ocw_list", arguments: true },
          group: "OCW",
          palette: true,
          run: () => void actionList(props.ctx),
        },
        {
          id: "ocw.merge",
          title: "Merge this ocw session back into the real repo",
          slash: { name: "ocw_merge", arguments: true },
          group: "OCW",
          palette: true,
          run: () => void actionMerge(props.ctx),
        },
        {
          id: "ocw.down",
          title: "Finish this ocw session (move back + unmount)",
          slash: { name: "ocw_down", arguments: true },
          group: "OCW",
          palette: true,
          run: () => void actionDown(props.ctx),
        },
      ],
    }))
  })
  onCleanup(() => off?.())
  return <Show when={false} />
}

const plugin = {
  id,
  setup(ctx: PluginCtx) {
    ctx.ui.slot({
      append: "sidebar.content",
      render: () => <OcwCommands ctx={ctx} />,
    })
  },
}

export default plugin
