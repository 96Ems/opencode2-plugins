/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { readFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const id = "carousel"

type PanelInput = { sessionID?: string }

type PanelItem = {
  id: string
  label: string
  render: (input: PanelInput) => unknown
}

type Slide = {
  id: string
  label: string
  order: number
  seq: number
  items: PanelItem[]
}

type ConfigEntry = { path: string; order?: number; label?: string; enabled?: boolean }
type ConfigSlide = { label?: string; plugins?: ConfigEntry[]; enabled?: boolean }
type ConfigKeybinds = { prev?: string; next?: string }

const CONFIG_PATH = join(homedir(), ".config/opencode/carousel.json")

function loadConfig(): { plugins?: ConfigEntry[]; slides?: ConfigSlide[]; keybinds?: ConfigKeybinds } {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    return {}
  }
}

function logLine(obj: unknown): void {
  try {
    void appendFile(
      "/tmp/opencode/carousel-load.jsonl",
      JSON.stringify({ ts: new Date().toISOString(), ...(obj as object) }) + "\n",
    )
  } catch {
    /* ignore */
  }
}

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
    slot: (def: { append: string; render: (input: PanelInput) => unknown }) => void
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
  client: Record<string, unknown>
}

type Session = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  time?: { created: number }
}

const [slides, setSlides] = createStore<{ list: Slide[] }>({ list: [] })

let seq = 0

const [index, setIndex] = createSignal(0)

function sortedSlides(): Slide[] {
  return [...slides.list].sort((a, b) => a.order - b.order || a.seq - b.seq)
}

export function prevSlide(): void {
  const n = slides.list.length
  if (n === 0) return
  setIndex((i) => (i - 1 + n) % n)
}

export function nextSlide(): void {
  const n = slides.list.length
  if (n === 0) return
  setIndex((i) => (i + 1) % n)
}

export function getLoadedSlides(): ReadonlyArray<Slide> {
  return slides.list
}

function registerKeymap(ctx: PluginCtx): (() => void) | undefined {
  const binds = loadConfig().keybinds ?? {}
  const makeCmd = (
    id: string,
    title: string,
    bind: string | undefined,
    run: () => void,
  ): { id: string; title: string; bind?: string; run: () => void } => {
    const cmd: { id: string; title: string; bind?: string; run: () => void } = { id, title, run }
    if (bind) cmd.bind = bind
    return cmd
  }
  try {
    const layer = ctx.keymap?.layer?.(
      () => ({
        mode: "global",
        commands: [
          makeCmd("carousel.slide.prev", "Carousel: slide précédent", binds.prev, prevSlide),
          makeCmd("carousel.slide.next", "Carousel: slide suivant", binds.next, nextSlide),
        ],
      }),
    ) as (() => void) | undefined
    logLine({ event: "keymap", hasKeymap: !!ctx.keymap, hasLayer: typeof ctx.keymap?.layer === "function", off: typeof layer, binds })
    return layer
  } catch (err) {
    logLine({ event: "keymap-error", error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

async function loadSlideItems(ctx: PluginCtx, entries: ConfigEntry[]): Promise<PanelItem[]> {
  const items: PanelItem[] = []
  for (const entry of entries) {
    if (entry.enabled === false) {
      logLine({ event: "skip", path: entry.path, reason: "disabled" })
      continue
    }
    const target = isAbsolute(entry.path) ? entry.path : resolve(CONFIG_PATH, "..", entry.path)
    try {
      const mod = await import(target)
      const plugin = (mod as { default?: unknown }).default as
        | { id?: unknown; setup?: unknown }
        | undefined
      if (!plugin || typeof plugin.id !== "string" || !plugin.id || typeof plugin.setup !== "function") {
        logLine({ event: "skip", path: target, reason: "invalid module shape" })
        continue
      }
      const captured: { render?: (input: PanelInput) => unknown } = {}
      const wrapped: PluginCtx = {
        ...ctx,
        ui: {
          ...ctx.ui,
          slot: (def) => {
            if (def.append === "sidebar.content") {
              captured.render = def.render
            } else {
              ctx.ui.slot(def)
            }
          },
        },
      }
      await (plugin.setup as (c: PluginCtx) => Promise<void> | void)(wrapped)
      if (captured.render) {
        items.push({ id: plugin.id, label: entry.label ?? plugin.id, render: captured.render })
        logLine({ event: "loaded", path: target, id: plugin.id })
      } else {
        logLine({ event: "skip", path: target, id: plugin.id, reason: "no sidebar.content slot" })
      }
    } catch (err) {
      logLine({ event: "error", path: target, error: err instanceof Error ? err.message : String(err) })
      try {
        ctx.ui.toast.show({
          variant: "error",
          message: `carousel: failed to load ${entry.path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      } catch {
        /* no toast */
      }
    }
  }
  return items
}

function buildSlideDefs(cfg: ReturnType<typeof loadConfig>): ConfigSlide[] {
  const out: ConfigSlide[] = []
  if (Array.isArray(cfg.slides)) out.push(...cfg.slides)
  if (Array.isArray(cfg.plugins)) out.push(...cfg.plugins.map((p) => ({ plugins: [p] })))
  return out
}

function Carousel(props: { ctx: PluginCtx; sessionID?: string }) {
  const theme = () => props.ctx.theme

  let offKeymap: (() => void) | undefined
  onMount(() => {
    offKeymap = registerKeymap(props.ctx)
  })
  onCleanup(() => offKeymap?.())

  const list = createMemo(sortedSlides)

  createEffect(() => {
    if (list().length > 0 && index() >= list().length) setIndex(0)
  })

  const slide = () => list()[index()]

  const prev = () => {
    if (list().length === 0) return
    setIndex((index() - 1 + list().length) % list().length)
  }
  const next = () => {
    if (list().length === 0) return
    setIndex((index() + 1) % list().length)
  }

  return (
    <box gap={1}>
      <Show when={list().length > 0} fallback={<text fg={theme().text.subdued}>carousel: no slides</text>}>
        <box gap={1}>
          <box flexDirection="row" gap={1}>
            <text width={3} wrapMode="none" fg={theme().text.subdued} onMouseUp={prev}>
              {" ◀"}
            </text>
            <text fg={theme().text.default}>
              <b>{slide().label}</b>
            </text>
            <text width={3} wrapMode="none" fg={theme().text.subdued} onMouseUp={next}>
              {"▶ "}
            </text>
            <text fg={theme().text.subdued}>
              {index() + 1}/{list().length}
            </text>
            <For each={list()}>
              {(s, i) => (
                <text
                  wrapMode="none"
                  fg={i() === index() ? theme().text.default : theme().text.subdued}
                  onMouseUp={() => setIndex(i())}
                >
                  ●
                </text>
              )}
            </For>
          </box>
          <For each={slide().items}>
            {(item) => item.render({ sessionID: props.sessionID })}
          </For>
          <Show when={slide().items.length === 0}>
            <text fg={theme().text.subdued}>slide vide — voir /tmp/opencode/carousel-load.jsonl</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const plugin = {
  id,
  async setup(ctx: PluginCtx) {
    const cfg = loadConfig()
    const slideDefs = buildSlideDefs(cfg)
    for (let i = 0; i < slideDefs.length; i++) {
      const def = slideDefs[i]
      if (def.enabled === false) {
        logLine({ event: "slide-skip", index: i, label: def.label ?? null, reason: "disabled" })
        continue
      }
      const items = await loadSlideItems(ctx, def.plugins ?? [])
      setSlides("list", (list) => [
        ...list.filter((s) => s.id !== `slide-${i}`),
        { id: `slide-${i}`, label: def.label ?? `Slide ${i + 1}`, order: i, seq: seq++, items },
      ])
      logLine({ event: "slide", index: i, label: def.label ?? null, items: items.length })
    }
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        logLine({ event: "slot-render", input: input as unknown })
        return <Carousel ctx={ctx} sessionID={input?.sessionID} />
      },
    })
  },
}

export default plugin
