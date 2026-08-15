import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appendFile, readFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

export type Theme = {
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

export type GitEntry = {
  path: string
  code: string
  staged: boolean
  untracked: boolean
}

export type GitData = {
  branch: string
  ahead: number
  behind: number
  entries: GitEntry[]
  stats: Map<string, { adds: number; dels: number }>
}

const run = promisify(execFile) as (
  file: string,
  args: string[],
  opts?: { cwd?: string; encoding?: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

export const CWD = process.cwd()

export function probe(label: string, value: unknown) {
  try {
    appendFileSync(
      "/tmp/opencode/resolve-probe.jsonl",
      JSON.stringify({ ts: new Date().toISOString(), label, value }) + "\n",
    )
  } catch {
    /* ignore */
  }
}

let probed = false
async function diagnose(cmd: string, cwd: string, err: unknown) {
  if (probed) return
  probed = true
  const e = err as { message?: string; stderr?: string; code?: string }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    cwd,
    cmd,
    code: e?.code,
    message: e?.message,
    stderr: e?.stderr,
  })
  try {
    await appendFile("/tmp/opencode/git-probe.jsonl", line + "\n")
  } catch {
    /* ignore */
  }
}

export async function git(args: string[], cwd: string = CWD): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as { message?: string; stderr?: string }
    void diagnose(`git ${args.join(" ")}`, cwd, err)
    const stderr = (e?.stderr ?? "").trim()
    throw new Error(stderr ? stderr.split("\n")[0] : e?.message ?? "git failed")
  }
}

export function fit(text: string, max: number) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

export async function loadGit(cwd: string = CWD): Promise<GitData> {
  const [out, unum, snum] = await Promise.all([
    git(["status", "--porcelain=v1", "--branch"], cwd),
    git(["diff", "--numstat"], cwd),
    git(["diff", "--cached", "--numstat"], cwd),
  ])
  let branch = ""
  let ahead = 0
  let behind = 0
  const entries: GitEntry[] = []
  for (const line of out.split("\n")) {
    if (line.startsWith("## ")) {
      const rest = line.slice(3)
      branch = rest.split("...")[0] || branch
      const am = /ahead (\d+)/.exec(rest)
      if (am) ahead = +am[1]
      const bm = /behind (\d+)/.exec(rest)
      if (bm) behind = +bm[1]
      continue
    }
    const code = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(" -> ")
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (!path) continue
    entries.push({ path, code, staged: code[0] !== " " && code[0] !== "?", untracked: code === "??" })
  }
  const stats = new Map<string, { adds: number; dels: number }>()
  for (const block of [unum, snum]) {
    for (const line of block.split("\n")) {
      const parts = line.split("\t")
      if (parts.length < 3) continue
      const [adds, dels, path] = parts
      const prev = stats.get(path)
      stats.set(path, {
        adds: (prev?.adds ?? 0) + (adds === "-" ? 0 : +adds || 0),
        dels: (prev?.dels ?? 0) + (dels === "-" ? 0 : +dels || 0),
      })
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { branch, ahead, behind, entries, stats }
}

export async function loadPatch(file: string, untracked: boolean, cwd: string = CWD): Promise<string> {
  if (untracked) {
    const content = await readFile(join(cwd, file), "utf8").catch(() => "<unreadable>")
    const body = content.split("\n").map((l) => "+" + l).join("\n")
    return `--- untracked: ${file}\n+++ (new file)\n${body}`
  }
  const [u, s] = await Promise.all([
    git(["diff", "--", file], cwd).catch(() => ""),
    git(["diff", "--cached", "--", file], cwd).catch(() => ""),
  ])
  const out = [u, s].filter(Boolean).join("\n").trim()
  return out || "(no changes)"
}

export type CommitRef = {
  name: string
  kind: "head" | "branch" | "remote" | "tag"
}

export type CommitNode = {
  hash: string
  short: string
  parents: string[]
  refs: CommitRef[]
  author: string
  date: string
  subject: string
}

export type GraphCell = {
  ch: string
  color: number
}

export type GraphRow = {
  cells: GraphCell[]
  commit: CommitNode
}

export type GraphLine =
  | { kind: "commit"; cells: GraphCell[]; commit: CommitNode }
  | { kind: "lane"; cells: GraphCell[] }

export const GRAPH_PALETTE = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#d19a66",
  "#7fb2f0",
  "#ff9cce",
  "#86e2d5",
]

function parseRefs(raw: string): CommitRef[] {
  if (!raw) return []
  const out: CommitRef[] = []
  for (const part of raw.split(",")) {
    const p = part.trim()
    if (!p) continue
    if (p.startsWith("HEAD -> ")) out.push({ name: p.slice(8), kind: "head" })
    else if (p.startsWith("tag: ")) out.push({ name: p.slice(5), kind: "tag" })
    else if (p.includes("/")) out.push({ name: p, kind: "remote" })
    else out.push({ name: p, kind: "branch" })
  }
  return out
}

export async function loadGraphData(cwd: string = CWD): Promise<CommitNode[]> {
  const out = await git(
    [
      "log",
      "--all",
      "--topo-order",
      "--date=relative",
      "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ar%x1f%s%x1e",
      "-n",
      "24",
    ],
    cwd,
  )
  const commits: CommitNode[] = []
  for (const raw of out.split("\x1e")) {
    const rec = raw.trim()
    if (!rec) continue
    const [hash, parentsRaw, refsRaw, author, date, subject] = rec.split("\x1f")
    if (!hash) continue
    commits.push({
      hash,
      short: hash.slice(0, 7),
      parents: parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [],
      refs: parseRefs(refsRaw ?? ""),
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
    })
  }
  return commits
}

export function refColor(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % GRAPH_PALETTE.length
}

export function buildGraph(commits: CommitNode[]): GraphLine[] {
  type Lane = { head: string | null; color: number }
  const lanes: Lane[] = []
  const rows: GraphLine[] = []
  let nextColor = 0
  const newColor = () => nextColor++ % GRAPH_PALETTE.length

  for (const c of commits) {
    let pos = lanes.findIndex((l) => l.head === c.hash)
    if (pos === -1) {
      pos = lanes.length
      lanes.push({ head: c.hash, color: newColor() })
    }
    const parents = c.parents
    const extraParents = parents.slice(1)

    const collapse: number[] = []
    for (let j = 0; j < lanes.length; j++) {
      if (j !== pos && lanes[j].head === c.hash) collapse.push(j)
    }
    const merges: number[] = []
    for (let j = 0; j < lanes.length; j++) {
      if (j !== pos && lanes[j].head && extraParents.includes(lanes[j].head)) merges.push(j)
    }
    const newLanes: string[] = []
    for (const p of extraParents) {
      if (!merges.some((j) => lanes[j].head === p)) newLanes.push(p)
    }
    for (const p of newLanes) lanes.push({ head: p, color: newColor() })

    const cells: GraphCell[] = lanes.map((l) => ({ ch: " ", color: -1 }))
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j].head !== null) cells[j] = { ch: "│", color: lanes[j].color }
    }
    cells[pos] = { ch: parents.length > 1 ? "◆" : "●", color: lanes[pos].color }

    const joins = [...collapse, ...merges]
    for (const j of joins) {
      cells[j] = { ch: j < pos ? "└" : "┘", color: lanes[j].color }
      const [a, b] = j < pos ? [j, pos] : [pos, j]
      for (let k = a + 1; k < b; k++) cells[k] = { ch: "─", color: lanes[j].color }
    }
    for (const p of newLanes) {
      const j = lanes.findIndex((l) => l.head === p)
      if (j > pos) {
        cells[j] = { ch: "┐", color: lanes[j].color }
        for (let k = pos + 1; k < j; k++) cells[k] = { ch: "─", color: lanes[j].color }
      }
    }

    rows.push({ kind: "commit", cells, commit: c })

    for (const j of collapse) lanes[j].head = null
    for (const j of merges) lanes[j].head = null
    lanes[pos].head = parents[0] ?? null

    for (let j = lanes.length - 1; j >= 0; j--) {
      if (lanes[j].head === null) lanes.splice(j, 1)
    }

    if (lanes.length > 0) {
      rows.push({ kind: "lane", cells: lanes.map((l) => ({ ch: "│", color: l.color })) })
    }
  }
  return rows
}
