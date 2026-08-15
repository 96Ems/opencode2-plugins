/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  fit,
  git,
  loadGraphData,
  buildGraph,
  refColor,
  GRAPH_PALETTE,
  CWD,
  type CommitNode,
  type GraphLine,
  type Theme,
} from "/home/emericclement/dev/opencode2-plugins/shared/git-core.ts"

const id = "git-graph"

const GIT_POLL_MS = 30_000
const TURN_MIN_INTERVAL_MS = 10_000

function PatchView(props: { theme: () => Theme; lines: string[] }) {
  const t = props.theme()
  const colorFor = (line: string) => {
    if (line.startsWith("+")) return t.text.feedback.success.default
    if (line.startsWith("-")) return t.text.feedback.error.default
    if (line.startsWith("@@")) return t.text.feedback.info.default
    if (
      line.startsWith("diff ") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("index ")
    ) {
      return t.text.subdued
    }
    return t.text.default
  }
  return (
    <box flexDirection="column" gap={0}>
      <For each={props.lines}>
        {(line) => <text fg={colorFor(line)}>{line}</text>}
      </For>
    </box>
  )
}

type PluginCtx = {
  theme: Theme
  data: {
    on: (type: string, handler: (event: unknown) => void) => () => void
    session: { get: (sessionID: string) => unknown }
  }
  ui: {
    slot: (def: { append: string; render: (input: { sessionID?: string }) => unknown }) => void
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
        target?: unknown
        enabled?: () => boolean
        commands?: Array<{ id: string; title?: string; bind?: string; run: () => void }>
      },
    ) => () => void
  }
}

function resolveDir(ctx: PluginCtx, sessionID?: string): string {
  const s = sessionID
    ? (ctx.data.session.get(sessionID) as { location?: { directory?: string } } | undefined)
    : undefined
  return s?.location?.directory ?? CWD
}

function groupSpans(cells: GraphLine["cells"]) {
  const out: Array<{ text: string; color: number }> = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last && last.color === cell.color) last.text += cell.ch
    else out.push({ text: cell.ch, color: cell.color })
  }
  return out
}

function CommitDialog(props: { ctx: PluginCtx; commit: CommitNode; dir: string }) {
  const theme = () => props.ctx.theme
  const [lines, setLines] = createSignal<string[]>([])
  const [error, setError] = createSignal<string | undefined>()
  let offLayer: (() => void) | undefined

  onMount(() => {
    props.ctx.ui.dialog.set({ size: "xlarge" })
    offLayer = props.ctx.keymap.layer(() => ({
      mode: "modal",
      commands: [
        {
          id: "git-graph.commit.close",
          title: "Fermer",
          bind: "escape",
          run: () => props.ctx.ui.dialog.clear(),
        },
      ],
    }))
    void git(["show", props.commit.hash], props.dir)
      .then((out) => setLines(out.split("\n")))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  })
  onCleanup(() => offLayer?.())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.default}>
          <b>{props.commit.short}</b> <span fg={theme().text.subdued}>{props.commit.subject}</span>
        </text>
        <text fg={theme().text.subdued}>esc close</text>
      </box>
      <Show when={error()} fallback={
        <scrollbox scrollY flexGrow={1}>
          <PatchView theme={theme} lines={lines()} />
        </scrollbox>
      }>
        <text fg={theme().text.feedback.error.default}>{error()}</text>
      </Show>
    </box>
  )
}

function GraphCells(props: { cells: GraphLine["cells"]; width: number; theme: () => Theme }) {
  const theme = props.theme
  const cellFg = (color: number) =>
    color < 0 ? theme().text.subdued : GRAPH_PALETTE[color % GRAPH_PALETTE.length]
  const spans = () => {
    const cells = props.cells.slice()
    while (cells.length < props.width) cells.push({ ch: " ", color: -1 })
    return groupSpans(cells)
  }
  return (
    <text wrapMode="none">
      <For each={spans()}>
        {(s) => <span fg={cellFg(s.color)}>{s.text}</span>}
      </For>
    </text>
  )
}

function Row(props: { ctx: PluginCtx; line: Extract<GraphLine, { kind: "commit" }>; dir: string; graphWidth: number }) {
  const theme = () => props.ctx.theme
  const c = props.line.commit

  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseUp={() =>
        props.ctx.ui.dialog.show(() => <CommitDialog ctx={props.ctx} commit={c} dir={props.dir} />)
      }
    >
      <GraphCells cells={props.line.cells} width={props.graphWidth} theme={theme} />
      <text wrapMode="none">
        <For each={c.refs}>
          {(r) => (
            <>
              {r.kind === "head" ? (
                <span fg={theme().text.feedback.info.default}>● </span>
              ) : r.kind === "tag" ? (
                <span fg={theme().text.subdued}>⋆ </span>
              ) : null}
              <span fg={GRAPH_PALETTE[refColor(r.name) % GRAPH_PALETTE.length]}>[{r.name}]</span>{" "}
            </>
          )}
        </For>
      </text>
      <text wrapMode="none" truncate fg={theme().text.default}>
        {c.subject}
      </text>
      <text wrapMode="none" fg={theme().text.subdued}>
        {c.short}
      </text>
    </box>
  )
}

function LaneRow(props: { cells: GraphLine["cells"]; graphWidth: number; theme: () => Theme }) {
  return (
    <box flexDirection="row" gap={1}>
      <GraphCells cells={props.cells} width={props.graphWidth} theme={props.theme} />
    </box>
  )
}

function GitGraphPanel(props: { ctx: PluginCtx; sessionID?: string }) {
  const theme = () => props.ctx.theme
  const [rows, setRows] = createSignal<GraphLine[]>([])
  const [error, setError] = createSignal<string | undefined>()

  const dir = () => resolveDir(props.ctx, props.sessionID)
  const graphWidth = () => rows().reduce((m, r) => Math.max(m, r.cells.length), 0)

  const refresh = async () => {
    try {
      setRows(buildGraph(await loadGraphData(dir())))
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  void refresh()
  const poll = setInterval(() => void refresh(), GIT_POLL_MS)
  let lastTurnFetch = 0
  const offTurn = props.ctx.data.on("session.execution.started", () => {
    const t = Date.now()
    if (t - lastTurnFetch < TURN_MIN_INTERVAL_MS) return
    lastTurnFetch = t
    void refresh()
  })
  onCleanup(() => {
    clearInterval(poll)
    offTurn()
  })

  return (
    <Show
      when={rows().length > 0}
      fallback={
        <Show when={error()}>
          <text fg={theme().text.feedback.error.default}>git: {fit(error() ?? "error", 40)}</text>
        </Show>
      }
    >
      <box gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.default}>
            <b>Git Graph</b>
          </text>
          <text fg={theme().text.subdued}>
            {rows().filter((r) => r.kind === "commit").length}
          </text>
        </box>
        <scrollbox scrollY maxHeight={28}>
          <box flexDirection="column" gap={0}>
            <For each={rows()}>
              {(line) =>
                line.kind === "commit" ? (
                  <Row ctx={props.ctx} line={line} dir={dir()} graphWidth={graphWidth()} />
                ) : (
                  <LaneRow cells={line.cells} graphWidth={graphWidth()} theme={theme} />
                )
              }
            </For>
          </box>
        </scrollbox>
        <text fg={theme().text.subdued}>click a commit to view it</text>
      </box>
    </Show>
  )
}

const plugin = {
  id,
  async setup(ctx: PluginCtx) {
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <GitGraphPanel ctx={ctx} sessionID={input?.sessionID} />,
    })
  },
}

export default plugin
