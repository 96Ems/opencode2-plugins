/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { fit, loadGit, loadPatch, CWD, type GitEntry, type Theme } from "/home/emericclement/dev/opencode2-plugins/shared/git-core.ts"

const id = "git-changes"

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

const GIT_POLL_MS = 30_000
const TURN_MIN_INTERVAL_MS = 10_000

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

function DiffDialog(props: { ctx: PluginCtx; file: string; entry: GitEntry; dir: string }) {
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
          id: "git-changes.diff.close",
          title: "Fermer",
          bind: "escape",
          run: () => props.ctx.ui.dialog.clear(),
        },
      ],
    }))
    void loadPatch(props.file, props.entry.untracked, props.dir)
      .then((patch) => setLines(patch.split("\n")))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  })
  onCleanup(() => offLayer?.())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column" height="100%">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.default}>
          <b>{fit(props.file, 60)}</b>{" "}
          <span fg={theme().text.feedback.info.default}>{props.entry.code}</span>
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

function GitChangesPanel(props: { ctx: PluginCtx; sessionID?: string }) {
  const theme = () => props.ctx.theme
  const [data, setData] = createSignal<Awaited<ReturnType<typeof loadGit>> | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  const dir = () => resolveDir(props.ctx, props.sessionID)

  const refresh = async () => {
    try {
      setData(await loadGit(dir()))
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
      when={data()}
      fallback={
        <Show when={error()}>
          <text fg={theme().text.feedback.error.default}>git: {fit(error() ?? "error", 40)}</text>
        </Show>
      }
    >
      {(d) => {
        const t = theme()
        const staged = d().entries.filter((e) => e.staged && !e.untracked).length
        const unstaged = d().entries.filter((e) => !e.staged && !e.untracked).length
        const untracked = d().entries.filter((e) => e.untracked).length
        const glyph = (e: GitEntry) => {
          if (e.untracked) return { ch: "?", fg: t.text.subdued }
          if (e.staged) return { ch: e.code[0], fg: t.text.feedback.info.default }
          if (e.code[1] !== " ") return { ch: e.code[1], fg: t.text.feedback.warning.default }
          return { ch: "·", fg: t.text.subdued }
        }
        return (
          <box gap={1}>
            <box flexDirection="row" gap={1}>
              <Show when={d().entries.length === 0} fallback={<text fg={t.text.feedback.warning.default}>●</text>}>
                <text fg={t.text.feedback.success.default}>●</text>
              </Show>
              <text fg={t.text.default}>
                <b>{fit(d().branch || "HEAD", 16)}</b>
              </text>
              <Show when={d().ahead > 0}>
                <text fg={t.text.feedback.info.default}>↑{d().ahead}</text>
              </Show>
              <Show when={d().behind > 0}>
                <text fg={t.text.feedback.warning.default}>↓{d().behind}</text>
              </Show>
              <Show when={d().entries.length > 0}>
                <text fg={t.text.subdued}>
                  {d().entries.length}
                  <Show when={staged > 0}> S{staged}</Show>
                  <Show when={untracked > 0}> U{untracked}</Show>
                </text>
              </Show>
            </box>
            <Show
              when={d().entries.length === 0}
              fallback={
                <box flexDirection="column" gap={0}>
                  <For each={d().entries}>
                    {(e) => {
                      const g = glyph(e)
                      const stat = d().stats.get(e.path)
                      const tail = e.untracked
                        ? "new"
                        : stat && (stat.adds > 0 || stat.dels > 0)
                          ? `+${stat.adds} -${stat.dels}`
                          : ""
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseUp={() =>
                            props.ctx.ui.dialog.show(() => (
                              <DiffDialog ctx={props.ctx} file={e.path} entry={e} dir={dir()} />
                            ))
                          }
                        >
                          <text width={1} wrapMode="none" fg={g.fg}>
                            {g.ch}
                          </text>
                          <text width={24} wrapMode="none" truncate fg={t.text.default}>
                            {e.path}
                          </text>
                          <text wrapMode="none" fg={t.text.subdued}>
                            {tail}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                  <text fg={t.text.subdued}>click a file to view diff</text>
                </box>
              }
            >
              <text fg={t.text.feedback.success.default}>clean</text>
            </Show>
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
      render: (input) => <GitChangesPanel ctx={ctx} sessionID={input?.sessionID} />,
    })
  },
}

export default plugin
