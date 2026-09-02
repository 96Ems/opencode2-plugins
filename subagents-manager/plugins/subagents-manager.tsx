/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Plugin } from "@opencode-ai/plugin/tui"

const id = "subagents-manager"

const MAX_ROWS = 8
const PREVIEW_TOOLS = 4

type Theme = {
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

type Session = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created: number }
}

type ExecEvent = {
  type: string
  created?: number
  data?: { sessionID?: string; attempt?: number; at?: number; error?: string }
}

type EndKind = "completed" | "error" | "cancelled"

type Editor = {
  plainText: string
  focus: () => void
  blur: () => void
  setText?: (text: string) => void
  gotoLineEnd?: () => void
  isDestroyed: boolean
  traits?: unknown
  focused?: boolean
}

type ToolPartLike = {
  type?: string
  name?: string
  state?: { type?: string; input?: unknown }
}
type MessageLike = {
  id: string
  parts?: ToolPartLike[]
  time?: { created: number }
}
type MessageListResponse = {
  data?: MessageLike[]
}

type PluginCtx = {
  theme: Theme
  data: {
    on: (type: string, handler: (event: unknown) => void) => () => void
    session: {
      family: (sessionID: string) => string[]
      get: (sessionID: string) => Session | undefined
      status: (sessionID: string) => string | undefined
    }
  }
  ui: {
    slot: (def: { append: string; render: (input: { sessionID?: string }) => unknown }) => void
    router: { navigate: (dest: { type: string; sessionID?: string }) => void }
    dialog: {
      show: (render: () => unknown, onClose?: () => void) => void
      set: (opts: { size?: "medium" | "large" | "xlarge" }) => void
      clear: () => void
    }
    toast: { show: (opts: { variant?: "info" | "success" | "warning" | "error"; message: string }) => void }
  }
  keymap: {
    layer: (
      cb: () => {
        mode?: string
        target?: unknown
        enabled?: () => boolean
        commands?: Array<{ id: string; title?: string; bind?: string; run: () => void }>
      },
    ) => () => void
  }
  client: {
    session: {
      prompt: (params: {
        sessionID: string
        id?: string
        text: string
        files?: unknown[]
        delivery?: "steer" | "queue"
      }) => Promise<unknown>
    }
    message: {
      list: (params: {
        sessionID: string
        limit?: number
        order?: "asc" | "desc"
        cursor?: string
      }) => Promise<MessageListResponse>
    }
  }
}

function statusInfo(status: string | undefined, end: EndKind | undefined, theme: Theme) {
  if (status === "running") return { ch: "▶", fg: theme.text.feedback.info.default }
  if (end === "error") return { ch: "✕", fg: theme.text.feedback.error.default }
  if (end === "cancelled") return { ch: "–", fg: theme.text.subdued }
  if (end === "completed" || status === "idle") return { ch: "✓", fg: theme.text.feedback.success.default }
  return { ch: "·", fg: theme.text.subdued }
}

function fit(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function toolLabel(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>
    for (const key of ["path", "pattern", "command", "description", "query", "file", "url"]) {
      const v = obj[key]
      if (typeof v === "string" && v) return v
    }
    const json = JSON.stringify(obj)
    return json.length > 26 ? json.slice(0, 25) + "…" : json
  }
  const raw = String(input ?? "")
  return raw.length > 26 ? raw.slice(0, 25) + "…" : raw
}

async function loadToolPreview(
  client: PluginCtx["client"],
  sessionID: string,
): Promise<Array<{ name: string; label: string }>> {
  try {
    const res = await client.message.list({ sessionID, limit: 12, order: "desc" })
    const msgs = res?.data ?? []
    const out: Array<{ name: string; label: string }> = []
    for (const m of msgs) {
      if (!m?.parts) continue
      for (const p of [...m.parts].reverse()) {
        if (p?.type !== "tool" || !p?.name) continue
        out.push({ name: p.name, label: toolLabel(p.name, p.state?.input) })
        if (out.length >= PREVIEW_TOOLS) break
      }
      if (out.length >= PREVIEW_TOOLS) break
    }
    return out.reverse()
  } catch {
    return []
  }
}

function AgentDialog(props: {
  ctx: PluginCtx
  sessionID: string
  agent: string
  title: string
  delivery?: "steer" | "queue"
}) {
  const theme = () => props.ctx.theme
  let editor: Editor | undefined
  let offLayer: (() => void) | undefined
  let sending = false
  const [tools, setTools] = createSignal<Array<{ name: string; label: string }>>([])

  const submit = async () => {
    const text = (editor?.plainText ?? "").trim()
    if (!text || sending) return
    sending = true
    try {
      await props.ctx.client.session.prompt({
        sessionID: props.sessionID,
        text,
        ...(props.delivery ? { delivery: props.delivery } : {}),
      })
      props.ctx.ui.dialog.clear()
      props.ctx.ui.toast.show({ variant: "success", message: `${props.title} envoyé à ${props.agent}` })
    } catch (err) {
      sending = false
      props.ctx.ui.toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const cancel = () => props.ctx.ui.dialog.clear()
  const openSession = () => {
    props.ctx.ui.dialog.clear()
    props.ctx.ui.router.navigate({ type: "session", sessionID: props.sessionID })
  }

  onMount(() => {
    props.ctx.ui.dialog.set({ size: "medium" })
    offLayer = props.ctx.keymap.layer(() => ({
      mode: "modal",
      commands: [
        {
          id: "subagents.dialog.submit",
          title: "Envoyer",
          bind: "return",
          run: () => void submit(),
        },
        { id: "subagents.dialog.open", title: "Ouvrir la session", bind: "ctrl+o", run: openSession },
        { id: "subagents.dialog.cancel", title: "Annuler", bind: "escape", run: cancel },
      ],
    }))
    void loadToolPreview(props.ctx.client, props.sessionID).then(setTools)
    setTimeout(() => {
      if (!editor || editor.isDestroyed) return
      editor.focus()
      editor.gotoLineEnd?.()
    }, 1)
  })
  createEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.traits = {}
    editor.focus()
  })
  onCleanup(() => offLayer?.())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.default}>
          <b>{props.title}</b> <span fg={theme().text.subdued}>{props.agent}</span>
        </text>
        <text fg={theme().text.subdued}>esc cancel</text>
      </box>
      <Show when={tools().length > 0}>
        <box gap={0}>
          <text fg={theme().text.subdued}>last tools</text>
          <For each={tools()}>
            {(t) => (
              <box flexDirection="row" gap={1}>
                <text width={9} wrapMode="none" truncate fg={theme().text.feedback.info.default}>
                  {t.name}
                </text>
                <text wrapMode="none" truncate fg={theme().text.subdued}>
                  {t.label}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <textarea
        ref={(el) => {
          editor = el as unknown as Editor
        }}
        height={1}
        wrapMode="none"
        placeholder="Message au sous-agent…"
        placeholderColor={theme().text.subdued}
        textColor={theme().text.default}
        focusedTextColor={theme().text.default}
        cursorColor={theme().text.default}
      />
      <box flexDirection="row" gap={2}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.subdued}>return</text>
          <text fg={theme().text.default}>send</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.subdued}>ctrl+o</text>
          <text fg={theme().text.default}>open session</text>
        </box>
      </box>
    </box>
  )
}

function AgentRow(props: {
  ctx: PluginCtx
  sessionID: string
  agent: string
  end: EndKind | undefined
  running: boolean
  started: Record<string, number>
  now: () => number
}) {
  const theme = () => props.ctx.theme
  const session = () => props.ctx.data.session.get(props.sessionID)
  const status = () => props.ctx.data.session.status(props.sessionID)
  const info = () => statusInfo(status(), props.end, theme())

  const elapsed = () => {
    if (!props.running) return ""
    const start = props.started[props.sessionID]
    if (!start) return ""
    return " · " + fmtElapsed(props.now() - start)
  }
  const title = () => session()?.title || "…"
  const line = () => fit(title() + elapsed(), 26)

  const onClick = () => {
    props.ctx.ui.dialog.show(() => (
      <AgentDialog
        ctx={props.ctx}
        sessionID={props.sessionID}
        agent={props.agent}
        title={props.running ? "Steer" : "Message"}
        delivery={props.running ? "steer" : undefined}
      />
    ))
  }

  return (
    <box flexDirection="row" gap={1} onMouseUp={onClick}>
      <text width={1} wrapMode="none" fg={info().fg}>
        {info().ch}
      </text>
      <text width={7} wrapMode="none" truncate fg={theme().text.default}>
        {props.agent}
      </text>
      <text wrapMode="none" truncate fg={theme().text.subdued}>
        {line()}
      </text>
    </box>
  )
}

function ComposerInput(props: { ctx: PluginCtx; sessionID: string; agent?: string }) {
  const theme = () => props.ctx.theme
  const [editor, setEditor] = createSignal<Editor | undefined>()
  let offLayer: (() => void) | undefined
  let sending = false

  const submit = async () => {
    const ed = editor()
    const text = (ed?.plainText ?? "").trim()
    if (!text || sending) return
    sending = true
    try {
      const status = props.ctx.data.session.status(props.sessionID)
      await props.ctx.client.session.prompt({
        sessionID: props.sessionID,
        text,
        ...(status === "running" ? { delivery: "steer" as const } : {}),
      })
      try {
        ed?.setText?.("")
      } catch {
        /* ignore */
      }
      ed?.focus()
      props.ctx.ui.toast.show({
        variant: "success",
        message: `Message envoyé au subagent ${props.agent ?? ""}`.trim(),
      })
    } catch (err) {
      sending = false
      props.ctx.ui.toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : String(err),
      })
      ed?.focus()
    }
  }

  const onKeyDown = (e: { name?: string; preventDefault?: () => void }) => {
    if (e?.name === "escape") {
      e.preventDefault?.()
      editor()?.blur()
    }
  }

  const focusEditor = () => {
    const ed = editor()
    if (ed && !ed.isDestroyed) {
      ed.traits = {}
      ed.focus()
    }
  }

  onMount(() => {
    offLayer = props.ctx.keymap.layer(() => ({
      mode: "modal",
      commands: [
        {
          id: "subagents.composer.submit",
          title: "Envoyer au subagent",
          bind: "return",
          run: () => void submit(),
        },
        {
          id: "subagents.composer.submit.shift",
          title: "Envoyer au subagent",
          bind: "shift+return",
          run: () => void submit(),
        },
        {
          id: "subagents.composer.submit.ctrl",
          title: "Envoyer au subagent",
          bind: "ctrl+return",
          run: () => void submit(),
        },
      ],
    }))
    setTimeout(focusEditor, 120)
    setTimeout(focusEditor, 600)
  })
  onCleanup(() => offLayer?.())

  return (
    <box gap={1} paddingTop={1} paddingLeft={1} paddingRight={1}>
      <textarea
        ref={(el) => setEditor(el as unknown as Editor)}
        height={1}
        wrapMode="none"
        onSubmit={() => {
          setTimeout(() => setTimeout(() => void submit(), 0), 0)
        }}
        onKeyDown={onKeyDown}
        placeholder={`Message au subagent${props.agent ? ` ${props.agent}` : ""}…`}
        placeholderColor={theme().text.subdued}
        textColor={theme().text.default}
        focusedTextColor={theme().text.default}
        cursorColor={theme().text.default}
      />
      <box flexDirection="row" gap={1}>
        <text fg={theme().text.subdued}>return send · esc leave</text>
      </box>
    </box>
  )
}

function SubagentComposer(props: { ctx: PluginCtx; sessionID?: string }) {
  const session = () => (props.sessionID ? props.ctx.data.session.get(props.sessionID) : undefined)
  return (
    <Show when={session()?.parentID}>
      <ComposerInput ctx={props.ctx} sessionID={props.sessionID!} agent={session()?.agent} />
    </Show>
  )
}

function SubagentsPanel(props: { ctx: PluginCtx; sessionID?: string }) {
  const theme = () => props.ctx.theme
  const [tick, setTick] = createSignal(Date.now())
  const started: Record<string, number> = {}
  const ended: Record<string, EndKind> = {}

  const offStarted = props.ctx.data.on("session.execution.started", (event) => {
    const e = event as ExecEvent
    const sid = e?.data?.sessionID
    if (!sid) return
    if (typeof e.created === "number") started[sid] = e.created
    delete ended[sid]
  })
  const offSucceeded = props.ctx.data.on("session.execution.succeeded", (event) => {
    const sid = (event as ExecEvent)?.data?.sessionID
    if (sid) ended[sid] = "completed"
  })
  const offFailed = props.ctx.data.on("session.execution.failed", (event) => {
    const sid = (event as ExecEvent)?.data?.sessionID
    if (sid) ended[sid] = "error"
  })
  const offInterrupted = props.ctx.data.on("session.execution.interrupted", (event) => {
    const sid = (event as ExecEvent)?.data?.sessionID
    if (sid) ended[sid] = "cancelled"
  })

  const children = createMemo(() => {
    const root = props.sessionID
    if (!root) return []
    const fam = props.ctx.data.session.family(root).filter((x) => x !== root)
    const direct = fam.filter((x) => props.ctx.data.session.get(x)?.parentID === root)
    const nested = fam.filter((x) => props.ctx.data.session.get(x)?.parentID !== root)
    const byAge = (a: string, b: string) =>
      (props.ctx.data.session.get(b)?.time?.created ?? 0) -
      (props.ctx.data.session.get(a)?.time?.created ?? 0)
    return [...direct, ...nested].sort(byAge).slice(0, MAX_ROWS)
  })

  const total = () => {
    const fam = props.sessionID ? props.ctx.data.session.family(props.sessionID) : []
    return Math.max(0, fam.length - 1)
  }
  const runningCount = () =>
    children().filter((x) => props.ctx.data.session.status(x) === "running").length
  const hidden = () => total() - children().length

  const timer = setInterval(() => setTick(Date.now()), 1000)
  onCleanup(() => {
    clearInterval(timer)
    offStarted()
    offSucceeded()
    offFailed()
    offInterrupted()
  })

  return (
    <Show when={props.sessionID && total() > 0}>
      <box gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.default}>
            <b>Subagents</b>
          </text>
          <text fg={theme().text.subdued}>{total()}</text>
          <Show when={runningCount() > 0}>
            <text fg={theme().text.feedback.info.default}>{runningCount()} active</text>
          </Show>
        </box>
        <For each={children()}>
          {(childID) => {
            const session = props.ctx.data.session.get(childID)
            return (
              <AgentRow
                ctx={props.ctx}
                sessionID={childID}
                agent={session?.agent ?? "agent"}
                end={ended[childID]}
                running={props.ctx.data.session.status(childID) === "running"}
                started={started}
                now={tick}
              />
            )
          }}
        </For>
        <Show when={hidden() > 0}>
          <text fg={theme().text.subdued}>+{hidden()} more</text>
        </Show>
        <Show when={runningCount() > 0}>
          <text fg={theme().text.subdued}>click ▶ steer · ✓ message</text>
        </Show>
        <Show when={runningCount() === 0 && total() > 0}>
          <text fg={theme().text.subdued}>click a row to send a message</text>
        </Show>
      </box>
    </Show>
  )
}

const plugin = Plugin.define({
  id,
  setup(ctx: PluginCtx) {
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <SubagentsPanel ctx={ctx} sessionID={input?.sessionID} />,
    })
    ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => <SubagentComposer ctx={ctx} sessionID={input?.sessionID} />,
    })
  },
})

export default plugin
