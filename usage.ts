import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

/**
 * Provider usage meters for the sidebar status panel.
 *
 * Sources (mirroring ~/.claude statusline where possible):
 *   - Claude / Fable -> login state via the macOS keychain (no usage data in OpenCode)
 *   - Codex          -> the Codex CLI rollout-*.jsonl files under ~/.codex/sessions
 *   - Agy            -> placeholder (quota needs the agy language-server RPC)
 *   - Go (OpenCode)  -> server console status endpoint (/console/api/go/status)
 *   - GLM (Z.ai)     -> cached fetch of the z.ai monitor endpoint
 *
 * No Solid/JSX dependency: it only fetches and reports through a caller-supplied
 * setter. All disk/network work happens off the render path.
 */

export type ClaudeMeter = { state: "logout" | "login" }
export type FableMeter = { state: "logout" | "login" }
export type GoMeter = {
  state: "ok" | "absent"
  // Remaining ("% left") percentages, mirroring the OpenCode console which
  // reports usage as "N% left" for the rolling 5h / weekly / monthly windows.
  fivePct?: number
  weekPct?: number
  monthPct?: number
  extraUsd?: number
  fiveReset?: number
  weekReset?: number
  monthReset?: number
}
export type CodexMeter = {
  state: "ok" | "credits" | "absent"
  fivePct?: number
  sevenPct?: number
  fiveReset?: number
  sevenReset?: number
  balance?: string
}
export type AgyMeter = { state: "ok" | "no-data"; fivePct?: number; weekPct?: number }
export type GlmMeter = {
  state: "ok" | "absent" | "unauth" | "error"
  fivePct?: number
  weekPct?: number
  fiveReset?: number
  weekReset?: number
  level?: string
  stale?: boolean
}
export type Meters = {
  claude: ClaudeMeter
  fable: FableMeter
  codex: CodexMeter
  agy: AgyMeter
  go: GoMeter
  glm: GlmMeter
}

export type SetMeter = (key: keyof Meters, value: Meters[keyof Meters]) => void

// --- small tolerant helpers --------------------------------------------------

const HOME = process.env.HOME || ""

function expand(p: string): string {
  if (p === "~") return HOME
  if (p.startsWith("~/")) return HOME + p.slice(1)
  return p
}

function num(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "number" && Number.isFinite(v)) return v
  return undefined
}

export function fmtCountdown(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return ""
  let s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  s %= 86400
  const h = Math.floor(s / 3600)
  s %= 3600
  const m = Math.floor(s / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m`
}

// --- Claude / Fable (login state) -------------------------------------------

function claudeLoggedIn(): boolean {
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      { stdio: "ignore" },
    )
    return r.status === 0
  } catch {
    return false
  }
}

function readClaudeState(): ClaudeMeter {
  return { state: claudeLoggedIn() ? "login" : "logout" }
}

// --- Go (OpenCode) -----------------------------------------------------------
//
// Go plan usage is metered SERVER-SIDE by OpenCode (rolling 5h / weekly /
// monthly dollar windows). The local `session_v2.cost` is only a per-session
// estimate for THIS machine and does NOT match the authoritative server
// accounting (which covers all org usage, peak/off-peak pricing, cache reads,
// etc.). So the meter reads the console's own status endpoint using the OAuth
// credential (access token + org id) stored in the same DB.

const DEFAULT_DB_PATH = "~/.local/share/opencode/opencode.db"
const GO_STATUS_URL = "https://opencode.ai/console/api/go/status"

interface GoCredential {
  access: string
  orgID: string
}

// Dynamic import so a missing/unavailable bun:sqlite cannot take the whole
// plugin down at load time.
let sqlite: any

async function getSqlite(): Promise<any> {
  if (sqlite !== undefined) return sqlite
  try {
    sqlite = await import("bun:sqlite")
  } catch {
    sqlite = null
  }
  return sqlite
}

// Read the OpenCode console OAuth credential (access token + org id) from the
// local DB. OpenCode refreshes the access token itself, so re-reading each
// cycle keeps it current.
async function readGoCredential(): Promise<GoCredential | null> {
  const mod = await getSqlite()
  if (!mod) return null
  const path = expand(process.env.OPENCODE_DB || DEFAULT_DB_PATH)
  let db: any
  try {
    db = new mod.Database(path, { readonly: true })
  } catch {
    return null
  }
  try {
    const row = db
      .query(
        "SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1 ORDER BY time_updated DESC LIMIT 1",
      )
      .get() as { value?: string } | null
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    const access = parsed?.access
    const orgID = parsed?.metadata?.orgID
    if (typeof access !== "string" || !access) return null
    if (typeof orgID !== "string" || !orgID) return null
    return { access, orgID }
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

function parseGoMeter(m: any): { usedPct?: number; leftPct?: number; reset?: number } {
  const limit = num(m?.limitMicroCents)
  const used = num(m?.usedMicroCents)
  if (limit === undefined || used === undefined || !(limit > 0)) {
    return {}
  }
  const usedPct = Math.max(0, Math.min(100, (used / limit) * 100))
  const leftPct = Math.max(0, Math.min(100, 100 - usedPct))
  const resetsAt = m?.resetsAt
  const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) / 1000 : undefined
  return { usedPct, leftPct, reset }
}

// Fetch the authoritative Go usage from OpenCode's console status endpoint.
async function readGoUsage(): Promise<GoMeter | null> {
  const cred = await readGoCredential()
  if (!cred) return null
  try {
    const resp = await fetch(GO_STATUS_URL, {
      headers: {
        "x-org-id": cred.orgID,
        Authorization: `Bearer ${cred.access}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const payload: any = await resp.json()
    const meters = payload?.access?.meters
    if (!meters) return null
    const five = parseGoMeter(meters.fiveHour)
    const week = parseGoMeter(meters.week)
    const month = parseGoMeter(meters.month)
    return {
      state: "ok",
      fivePct: five.leftPct,
      weekPct: week.leftPct,
      monthPct: month.leftPct,
      extraUsd: undefined,
      fiveReset: five.reset,
      weekReset: week.reset,
      monthReset: month.reset,
    }
  } catch {
    return null
  }
}

// --- Codex -------------------------------------------------------------------

const CODEX_SESSIONS_ROOT = "~/.codex/sessions"
const CODEX_MAX_FILES = 10
const CODEX_TAIL_BYTES = 2 * 1024 * 1024

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function findRolloutFiles(root: string): string[] {
  const found: { path: string; mtime: number }[] = []
  try {
    for (const a of readdirSync(root)) {
      const p1 = join(root, a)
      if (!isDir(p1)) continue
      for (const b of readdirSync(p1)) {
        const p2 = join(p1, b)
        if (!isDir(p2)) continue
        for (const c of readdirSync(p2)) {
          const p3 = join(p2, c)
          if (!isDir(p3)) continue
          try {
            for (const f of readdirSync(p3)) {
              if (f.startsWith("rollout-") && f.endsWith(".jsonl")) {
                const full = join(p3, f)
                try {
                  found.push({ path: full, mtime: statSync(full).mtimeMs })
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  found.sort((x, y) => y.mtime - x.mtime)
  return found.slice(0, CODEX_MAX_FILES).map((r) => r.path)
}

function readCodexUsage(): CodexMeter {
  const absent: CodexMeter = { state: "absent" }
  let files: string[] = []
  try {
    files = findRolloutFiles(expand(CODEX_SESSIONS_ROOT))
  } catch {
    return absent
  }
  let snapshot: CodexMeter = absent

  for (const path of files) {
    try {
      let buf: Buffer
      try {
        buf = readFileSync(path)
      } catch {
        continue
      }
      const start = Math.max(0, buf.length - CODEX_TAIL_BYTES)
      const data = buf.subarray(start).toString("utf8")
      const lines = data.split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (line.indexOf("token_count") === -1) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (!record || typeof record !== "object") continue
        let payload = (record as Record<string, unknown>).payload
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload)
          } catch {
            continue
          }
        }
        if (!payload || typeof payload !== "object") continue
        const pl = payload as Record<string, unknown>
        if (pl.type !== "token_count") continue
        const rateLimits = pl.rate_limits
        if (!rateLimits || typeof rateLimits !== "object") continue
        const rl = rateLimits as Record<string, unknown>

        const limitId = rl.limit_id != null ? String(rl.limit_id) : null
        const limitName = rl.limit_name != null ? String(rl.limit_name) : null
        if (limitId === "base_model_inference" || limitName === "gpt-reserve") continue

        const slots = [rl.primary, rl.secondary].filter(
          (s): s is Record<string, unknown> => !!s && typeof s === "object",
        )
        const has300 = slots.some((s) => s.window_minutes === 300)
        const isSubscription = limitId === "codex" || has300
        if (!isSubscription && limitId !== "premium") continue

        let fiveHour: { pct: number; resetsAt?: number } | undefined
        let sevenDay: { pct: number; resetsAt?: number } | undefined
        for (const slot of slots) {
          const p = num(slot.used_percent)
          if (p === undefined) continue
          const resetsAt = num(slot.resets_at)
          if (slot.window_minutes === 300) fiveHour = { pct: p, resetsAt }
          else if (slot.window_minutes === 10080) sevenDay = { pct: p, resetsAt }
        }

        let balance: string | undefined
        const credits = rl.credits
        if (credits && typeof credits === "object") {
          const b = (credits as Record<string, unknown>).balance
          if (b != null) balance = String(b)
        } else if (rl.balance != null) {
          balance = String(rl.balance)
        }

        if (fiveHour || sevenDay) {
          snapshot = {
            state: "ok",
            fivePct: fiveHour?.pct,
            sevenPct: sevenDay?.pct,
            fiveReset: fiveHour?.resetsAt,
            sevenReset: sevenDay?.resetsAt,
            balance,
          }
          return snapshot
        }
        if (limitId === "premium") {
          snapshot = { state: "credits", balance }
          return snapshot
        }
      }
    } catch {
      continue
    }
  }
  return snapshot
}

// --- Agy (Antigravity) -------------------------------------------------------

// Quota requires an RPC against the agy language server (random port); not
// implemented yet. Returns no-data so the meter renders a placeholder.
function readAgyUsage(): AgyMeter {
  return { state: "no-data" }
}

// --- GLM (Z.ai) --------------------------------------------------------------

const GLM_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
const GLM_CACHE_SECONDS = 60

function glmKey(): string | undefined {
  const env = process.env.ZAI_API_KEY
  if (env && env.trim()) return env.trim()
  const authDir = (process.env.PI_AUTH_DIR || "~/.pi/agent").trim()
  try {
    const blob = JSON.parse(readFileSync(join(expand(authDir), "auth.json"), "utf8"))
    const zai = blob?.zai
    if (zai && typeof zai === "object" && typeof zai.key === "string" && zai.key.trim()) {
      return zai.key.trim()
    }
  } catch {
    /* ignore */
  }
  return undefined
}

function parseGlm(payload: unknown): {
  five?: { pct: number; reset?: number }
  week?: { pct: number; reset?: number }
  level?: string
} {
  if (!payload || typeof payload !== "object") return {}
  const data = (payload as Record<string, unknown>).data
  if (!data || typeof data !== "object") return {}
  const limits = (data as Record<string, unknown>).limits
  if (!Array.isArray(limits)) return {}
  let five: { pct: number; reset?: number } | undefined
  let week: { pct: number; reset?: number } | undefined
  for (const item of limits) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    const unit = num(it.unit)
    if (unit !== 3 && unit !== 6) continue
    const p = num(it.percentage)
    if (p === undefined) continue
    const resetMs = num(it.nextResetTime)
    const window = {
      pct: Math.max(0, Math.min(100, p)),
      reset: resetMs !== undefined ? resetMs / 1000 : undefined,
    }
    if (unit === 3) {
      if (!five || window.pct > five.pct) five = window
    } else {
      if (!week || window.pct > week.pct) week = window
    }
  }
  const level = (data as Record<string, unknown>).level
  return { five, week, level: typeof level === "string" && level ? level : undefined }
}

let glmLastFetch = 0

async function refreshGlm(setMeter: SetMeter, force = false) {
  const now = Date.now()
  if (!force && now - glmLastFetch < GLM_CACHE_SECONDS * 1000) return
  const key = glmKey()
  if (!key) {
    setMeter("glm", { state: "absent" })
    return
  }
  glmLastFetch = now
  try {
    const resp = await fetch(GLM_URL, {
      headers: { Authorization: key, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      setMeter("glm", { state: resp.status === 401 || resp.status === 403 ? "unauth" : "error" })
      return
    }
    const payload = await resp.json()
    const { five, week, level } = parseGlm(payload)
    setMeter("glm", {
      state: "ok",
      fivePct: five?.pct,
      weekPct: week?.pct,
      fiveReset: five?.reset,
      weekReset: week?.reset,
      level,
      stale: false,
    })
  } catch {
    setMeter("glm", { state: "error" })
  }
}

// --- refresh loop ------------------------------------------------------------

let started = false

export function startUsageRefresh(setMeter: SetMeter): () => void {
  if (started) return () => {}
  started = true

  const tick = async () => {
    const claude = readClaudeState()
    setMeter("claude", claude)
    setMeter("fable", claude)
    const go = await readGoUsage()
    setMeter("go", go ?? { state: "absent" })
    setMeter("codex", readCodexUsage())
    setMeter("agy", readAgyUsage())
    await refreshGlm(setMeter)
  }

  void tick()
  const interval = setInterval(() => void tick(), 30000)
  return () => clearInterval(interval)
}
