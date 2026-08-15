/**
 * ocw-core — logique partagée entre le plugin serveur (ocw-isolate.ts) et le
 * plugin TUI (ocw-actions.tsx) : création/montage de sessions isolées,
 * merge back, unmount, helpers meta.
 */

import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, join, resolve } from "node:path"

export type OcwMeta = {
  ocw: number
  session: string
  repo: string
  branch: string
  created: number
  snapshot: string
  upper: string
  merged: string
  mergedAt: number | null
}

export const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export const run = promisify(execFile) as (
  file: string,
  args: string[],
  opts?: { cwd?: string; encoding?: string; maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

export function autoName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `auto-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export async function readMeta(dir: string): Promise<OcwMeta | null> {
  try {
    const raw = await readFile(join(dir, ".ocw", "meta.json"), "utf8")
    return JSON.parse(raw) as OcwMeta
  } catch {
    return null
  }
}

export async function isMounted(merged: string): Promise<boolean> {
  try {
    const mounts = await readFile("/proc/mounts", "utf8")
    const target = resolve(merged)
    return mounts.split("\n").some((line) => {
      const parts = line.split(" ")
      return parts.length > 2 && resolve(parts[1]) === target
    })
  } catch {
    return false
  }
}

export async function activeSessions(repo: string, ocwHome: string): Promise<OcwMeta[]> {
  const base = join(ocwHome, basename(repo))
  let names: string[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    names = (await readdir(base, { withFileTypes: true })).map((e) => e.name)
  } catch {
    return []
  }
  const out: OcwMeta[] = []
  for (const name of names) {
    const meta = await readMeta(join(base, name, "upper"))
    if (!meta || meta.repo !== repo) continue
    if (await isMounted(meta.merged)) out.push(meta)
  }
  return out
}

export function writeMeta(upper: string, meta: OcwMeta): Promise<void> {
  return import("node:fs/promises").then((fs) =>
    fs.mkdir(join(upper, ".ocw"), { recursive: true }).then(() =>
      fs.writeFile(join(upper, ".ocw", "meta.json"), JSON.stringify(meta, null, 2)),
    ),
  )
}

export async function mountOverlay(snap: string, upper: string, work: string, merged: string): Promise<void> {
  const hasFuse = await run("sh", ["-c", "command -v fuse-overlayfs || true"], { encoding: "utf8" }).then(
    (r) => r.stdout.trim().length > 0,
  )
  if (hasFuse) {
    await run("fuse-overlayfs", ["-o", `lowerdir=${snap},upperdir=${upper},workdir=${work}`, merged], { encoding: "utf8" })
    return
  }
  await run("sudo", ["-n", "mount", "-t", "overlay", "overlay", "-o", `lowerdir=${snap},upperdir=${upper},workdir=${work}`, merged], {
    encoding: "utf8",
  }).catch((err) => {
    throw new Error(
      `overlay mount failed (${(err as { stderr?: string })?.stderr ?? String(err).slice(0, 200)}). ` +
        "Install fuse-overlayfs for rootless mounts, or ensure passwordless sudo for `mount`.",
    )
  })
}

// Create an isolated session: snapshot + meta + mount. Returns { name, merged }.
export async function ocwUp(
  repoDir: string,
  nameArg: string | undefined,
  ocwHome: string,
): Promise<{ name: string; merged: string }> {
  // Resolve the repo root (the session dir may be a subdirectory or not a repo)
  const repo = await run("git", ["-C", repoDir, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    .then((r) => r.stdout.trim())
    .catch((err) => {
      throw new Error(
        `'${repoDir}' is not inside a git repository — cd into a git repo first ` +
          `(${(err as { stderr?: string })?.stderr?.trim().slice(0, 120) ?? ""})`,
      )
    })
  if (!repo) throw new Error(`'${repoDir}' is not inside a git repository — cd into a git repo first`)

  const name = nameArg && nameArg.trim() ? nameArg.trim() : autoName()
  if (!SESSION_RE.test(name)) throw new Error(`invalid session name: '${name}' (alnum . _ -)`)
  const root = join(ocwHome, basename(repo), name)
  const snap = join(root, "snapshot")
  const upper = join(root, "upper")
  const work = join(root, "work")
  const merged = join(root, "merged")
  const fs = await import("node:fs/promises")

  if (await fs.stat(root).then(() => true, () => false)) throw new Error(`session '${name}' already exists (${root})`)
  await fs.mkdir(join(ocwHome, basename(repo)), { recursive: true })
  await fs.mkdir(upper, { recursive: true })
  await fs.mkdir(work, { recursive: true })
  await fs.mkdir(merged, { recursive: true })

  await run("git", ["clone", "--no-hardlinks", "--quiet", repo, snap], { encoding: "utf8" }).catch((err) => {
    throw new Error(
      `snapshot clone failed: ${(err as { stderr?: string })?.stderr?.trim().slice(0, 300) ?? String(err).slice(0, 300)}`,
    )
  })
  await run("git", ["-C", snap, "remote", "remove", "origin"], { encoding: "utf8" }).catch(() => undefined)
  await fs.appendFile(join(snap, ".git", "info", "exclude"), ".ocw/\n")

  const branch = await run("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" })
    .then((r) => r.stdout.trim() || "detached")
    .catch(() => "detached")
  await writeMeta(upper, {
    ocw: 1,
    session: name,
    repo,
    branch,
    created: Math.floor(Date.now() / 1000),
    snapshot: snap,
    upper,
    merged,
    mergedAt: null,
  })

  // Optional: share the real repo's node_modules (OCW_LINK_NODE_MODULES=1).
  // Default is ISOLATED: installs in the session go to the upperdir and are
  // deleted on `ocw down`. With the symlink, installs hit the shared folder
  // (survives down; the symlink itself is deleted, the target is untouched).
  if (process.env.OCW_LINK_NODE_MODULES === "1" || process.env.OCW_LINK_NODE_MODULES === "true") {
    const nm = join(repo, "node_modules")
    if (await fs.stat(nm).then(() => true, () => false)) {
      await fs.symlink(nm, join(upper, "node_modules"))
    }
  }

  await mountOverlay(snap, upper, work, merged)
  if (!(await isMounted(merged))) throw new Error("mount failed")
  return { name, merged }
}

// Move a session to another directory (same as the TUI /cd command).
// The server plugin ctx has no session.move, but the CLI does (with its own auth):
//   opencode2 api post /api/session/<id>/move --data '{"directory": "…"}'
export async function sessionMove(sessionID: string, directory: string): Promise<void> {
  const bin = process.env.OCW_OPENCODE ?? "opencode2"
  await run(bin, ["api", "post", `/api/session/${sessionID}/move`, "--data", JSON.stringify({ directory })], {
    encoding: "utf8",
    timeout: 30_000,
  })
}

// Merge the isolated view back into the real repo: commit + fetch + merge.
export async function mergeSession(meta: OcwMeta): Promise<string> {
  const dirty = await run("git", ["-C", meta.merged, "status", "--porcelain"], { encoding: "utf8" })
  if (dirty.stdout.trim().length > 0) {
    await run("git", ["-C", meta.merged, "add", "-A"], { encoding: "utf8" })
    await run("git", ["-C", meta.merged, "commit", "-m", `ocw: ${meta.session}`], { encoding: "utf8" })
  }
  await run("git", ["-C", meta.repo, "fetch", meta.merged, `HEAD:refs/ocw/${meta.session}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const merge = await run("git", ["-C", meta.repo, "merge", "--no-edit", `refs/ocw/${meta.session}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  return merge.stdout.trim().split("\n").slice(-6).join("\n")
}

export async function unmountAndClean(
  meta: OcwMeta,
  ocwHome: string,
): Promise<{ unmounted: boolean; removed: boolean }> {
  let unmounted = false
  let removed = false
  try {
    await run(
      "sh",
      ["-c", `command -v fusermount3 >/dev/null 2>&1 && fusermount3 -u "${meta.merged}" || sudo -n umount "${meta.merged}"`],
      { encoding: "utf8" },
    )
    unmounted = true
  } catch {
    /* still mounted — session process holds it */
  }
  try {
    const fs = await import("node:fs/promises")
    const root = join(ocwHome, basename(meta.repo), meta.session)
    await fs.rm(root, { recursive: true, force: true })
    removed = true
  } catch {
    /* folder still held by processes — removable later */
  }
  return { unmounted, removed }
}

// Remove orphaned sessions: dirs whose overlay is no longer mounted (dead
// sessions, leftovers from ocw_down when the server still held the folder).
// Returns the removed session names.
export async function pruneOrphans(ocwHome: string): Promise<string[]> {
  const fs = await import("node:fs/promises")
  const removed: string[] = []
  let repos: string[] = []
  try {
    repos = (await fs.readdir(ocwHome, { withFileTypes: true })).map((e) => e.name)
  } catch {
    return removed
  }
  for (const repo of repos) {
    let sessions: string[] = []
    try {
      sessions = (await fs.readdir(join(ocwHome, repo), { withFileTypes: true })).map((e) => e.name)
    } catch {
      continue
    }
    for (const name of sessions) {
      const meta = await readMeta(join(ocwHome, repo, name, "upper"))
      if (!meta) continue
      if (await isMounted(meta.merged)) continue
      try {
        await fs.rm(join(ocwHome, repo, name), { recursive: true, force: true })
        removed.push(`${repo}/${name}`)
      } catch {
        /* still held — retry on next sweep */
      }
    }
  }
  return removed
}
