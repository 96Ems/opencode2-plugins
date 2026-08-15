/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const id = "go-usage"

const SEG = 12
const MARK = 3
const POLL_MS = 60_000
const TURN_MIN_INTERVAL_MS = 10_000

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

type PluginCtx = {
  theme: Theme
  data: { on: (type: string, handler: (event: unknown) => void) => () => void }
  ui: { slot: (def: { append: string; render: () => unknown }) => void }
}

type UsageWindow = { status: string; percent: number; resetsAt: string }
type UsagePayload = { usage: { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow } }

async function readApiKey(): Promise<string | undefined> {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY
  try {
    const json = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))
    return json["opencode-go"]?.key
  } catch {
    return undefined
  }
}

async function fetchUsage(): Promise<UsagePayload> {
  const key = await readApiKey()
  if (!key) throw new Error("no go api key")
  const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as UsagePayload
}

function statusColor(theme: Theme, percent: number) {
  if (percent < 25) return theme.text.feedback.info.default
  if (percent < 50) return theme.text.feedback.success.default
  if (percent < 75) return theme.text.feedback.warning.default
  return theme.text.feedback.error.default
}

function formatReset(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

type WindowKind = "rolling" | "weekly" | "monthly"

const SPIN = ["↺", "↻", "⟲", "⟳"]

function windowLabel(kind: WindowKind) {
  if (kind === "rolling") return "↻"
  if (kind === "weekly") return "7d"
  return "1m"
}

function Bar(props: { percent: number; color: string; muted: string }) {
  const parts = () => {
    const filled = Math.round(Math.min(100, Math.max(0, props.percent)) / (100 / SEG))
    const out: Array<{ ch: string; lit: boolean }> = []
    for (let i = 0; i < SEG; i++) {
      out.push({ ch: i < filled ? "█" : "░", lit: i < filled })
      if ((i + 1) % MARK === 0 && i !== SEG - 1) {
        out.push({ ch: "│", lit: i + 1 <= filled })
      }
    }
    return out
  }
  return (
    <text width={15} wrapMode="none">
      <For each={parts()}>
        {(s) => (
          <span style={{ fg: s.lit ? props.color : props.muted }}>{s.ch}</span>
        )}
      </For>
    </text>
  )
}

function WindowRow(props: {
  ctx: PluginCtx
  kind: WindowKind
  win: UsageWindow
  now: number
}) {
  const theme = () => props.ctx.theme
  const color = statusColor(theme(), props.win.percent)
  const muted = () => theme().text.subdued
  return (
    <box flexDirection="row" gap={1} border={["left"]} borderColor={theme().border.default} paddingLeft={1}>
      <text width={4} wrapMode="none" fg={props.kind === "rolling" ? color : muted()}>
        {windowLabel(props.kind)}
      </text>
      <Bar percent={props.win.percent} color={color} muted={muted()} />
      <text width={4} wrapMode="none">
        <Show when={props.win.percent >= 80} fallback={`${props.win.percent}%`}>
          <b>{props.win.percent}%</b>
        </Show>
      </text>
      <text wrapMode="none" fg={muted()}>
        · {formatReset(new Date(props.win.resetsAt).getTime() - props.now)}
      </text>
    </box>
  )
}

function View(props: { ctx: PluginCtx }) {
  const theme = () => props.ctx.theme
  const [data, setData] = createSignal<UsagePayload | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [lastFetch, setLastFetch] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  const refresh = async () => {
    try {
      setData(await fetchUsage())
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLastFetch(Date.now())
  }

  const ago = () => {
    if (!lastFetch()) return ""
    const s = Math.floor((now() - lastFetch()) / 1000)
    if (s < 5) return "live"
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m`
  }

  void refresh()
  const poll = setInterval(() => void refresh(), POLL_MS)
  let lastTurnFetch = 0
  const offTurn = props.ctx.data.on("session.execution.started", () => {
    const t = Date.now()
    if (t - lastTurnFetch < TURN_MIN_INTERVAL_MS) return
    lastTurnFetch = t
    void refresh()
  })
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    clearInterval(tick)
    clearInterval(poll)
    offTurn()
  })

  return (
    <Show
      when={data()}
      fallback={
        <Show when={error()}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().text.default}>
              <b>Go Usage</b>
            </text>
            <text fg={theme().text.subdued}>key missing</text>
          </box>
        </Show>
      }
    >
      {(d) => {
        const worst = Math.max(
          d().usage.rolling.percent,
          d().usage.weekly.percent,
          d().usage.monthly.percent,
        )
        return (
          <box gap={1}>
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(theme(), worst)}>●</text>
              <text fg={theme().text.default}>
                <b>Go Usage</b>
              </text>
              <Show when={error()}>
                <text fg={theme().text.feedback.warning.default}>stale</text>
              </Show>
              <Show when={ago() === "live"}>
                <text fg={theme().text.feedback.success.default}>live</text>
              </Show>
              <Show when={ago() !== "" && ago() !== "live"}>
                <text fg={theme().text.subdued}>{ago()}</text>
              </Show>
            </box>
            <box flexDirection="column" gap={0}>
              <WindowRow ctx={props.ctx} kind="rolling" win={d().usage.rolling} now={now()} />
              <WindowRow ctx={props.ctx} kind="weekly" win={d().usage.weekly} now={now()} />
              <WindowRow ctx={props.ctx} kind="monthly" win={d().usage.monthly} now={now()} />
            </box>
          </box>
        )
      }}
    </Show>
  )
}

const plugin = {
  id,
  async setup(ctx: PluginCtx) {
    ctx.ui.slot({
      append: "sidebar.content",
      render: () => <View ctx={ctx} />,
    })
  },
}

export default plugin
