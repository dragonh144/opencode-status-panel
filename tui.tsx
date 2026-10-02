import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal } from "solid-js"
import { spawnSync } from "node:child_process"
import { startUsageRefresh, fmtCountdown } from "./usage"
import type { Meters, GoMeter, CodexMeter, GlmMeter, ClaudeMeter, FableMeter, AgyMeter } from "./usage"

/**
 * Right-hand side status panel for OpenCode.
 *
 * Session rows (dir / git / model / ctx / tokens / cost), then the provider
 * usage meters (Claude, Fable, Codex, Agy, Go, GLM) with the same per-provider
 * colors as the ~/.claude statusline, then MCP servers.
 */

// Provider colors (xterm-256 hex, matching ~/.claude/statusline.py):
//   ORANGE 256-208  -> #ff8700 (Claude)
//   FABLE  256-135  -> #af5fff
//   NAVY   256-69   -> #5f87ff (Codex)
//   YELLOW          -> #eab308 (Agy)
//   CYAN            -> #22d3ee (Go / Opencode)
//   PINK   256-213  -> #ff87ff (GLM)
const C_ORANGE = "#ff8700"
const C_PURPLE = "#af5fff"
const C_BLUE = "#5f87ff"
const C_YELLOW = "#eab308"
const C_CYAN = "#22d3ee"
const C_PINK = "#ff87ff"

const initialMeters: Meters = {
  claude: { state: "logout" },
  fable: { state: "logout" },
  codex: { state: "absent" },
  agy: { state: "no-data" },
  go: { state: "absent" },
  glm: { state: "absent" },
}
const [metersSignal, setMetersSignal] = createSignal<Meters>(initialMeters)

function meters() {
  return metersSignal()
}

function setMeter(
  key: keyof Meters,
  value: GoMeter | CodexMeter | GlmMeter | ClaudeMeter | FableMeter | AgyMeter,
) {
  setMetersSignal((prev) => ({ ...prev, [key]: value }))
}

// --- small helpers -----------------------------------------------------------

function num(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

function fmtTokens(n: unknown): string {
  const v = num(n)
  if (v === undefined) return ""
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M"
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k"
  return String(Math.round(v))
}

function fmtUsd(n: unknown): string {
  const v = num(n)
  if (v === undefined) return ""
  return "$" + (v < 1 ? v.toFixed(4) : v.toFixed(2))
}

function fmtPct(frac: number | undefined): string {
  if (frac === undefined) return ""
  return Math.round(frac * 100) + "%"
}

function pctText(n?: number): string {
  return n === undefined ? "--" : Math.round(n) + "%"
}

function baseName(p?: string): string {
  if (!p) return ""
  const trimmed = p.replace(/\/+$/, "")
  const parts = trimmed.split("/")
  return parts[parts.length - 1] || p
}

function cd(reset?: number): string | undefined {
  if (reset === undefined) return undefined
  const rem = reset - Date.now() / 1000
  if (rem <= 0) return undefined
  return fmtCountdown(rem)
}

// --- git dirty (cached subprocess) ------------------------------------------

const dirtyCache = new Map<string, { ts: number; dirty: boolean }>()

function isDirty(dir: string): boolean {
  const hit = dirtyCache.get(dir)
  if (hit && Date.now() - hit.ts < 3000) return hit.dirty
  let dirty = false
  try {
    const r = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
      timeout: 1000,
      encoding: "utf8",
    })
    dirty = r.status === 0 && (r.stdout || "").trim().length > 0
  } catch {
    dirty = false
  }
  dirtyCache.set(dir, { ts: Date.now(), dirty })
  return dirty
}

// --- small components --------------------------------------------------------

function McpRow(props: { server: any }) {
  const ctx = usePlugin()
  const status = createMemo(() => props.server?.status?.status)
  const name = createMemo(() => props.server?.name ?? props.server?.id ?? props.server?.target ?? "mcp")
  const color = createMemo(() =>
    status() === "connected"
      ? ctx.theme.text.feedback.success.base
      : status() === "failed"
        ? ctx.theme.text.feedback.error.base
        : ctx.theme.text.muted,
  )
  return (
    <box flexDirection="row" gap={1} paddingLeft={7}>
      <text fg={color()} flexShrink={0} wrapMode="none">●</text>
      <text fg={ctx.theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
        {name()}
      </text>
    </box>
  )
}

function Win(props: {
  lead?: string
  w: string
  pct?: number
  cd?: string
  color: any
  pad: number
}) {
  const ctx = usePlugin()
  return (
    <box flexDirection="row" gap={1} paddingLeft={props.pad}>
      <Show when={props.lead !== undefined}>
        <text fg={props.color} width={props.lead!.length} flexShrink={0} wrapMode="none">
          {props.lead}
        </text>
      </Show>
      <text fg={ctx.theme.text.muted} wrapMode="none">{props.w}</text>
      <text fg={props.color} wrapMode="none">{pctText(props.pct)}</text>
      <Show when={props.cd !== undefined}>
        <text fg={ctx.theme.text.muted} wrapMode="none">({props.cd})</text>
      </Show>
    </box>
  )
}

function StateRow(props: { lead: string; value: string; color: any }) {
  const ctx = usePlugin()
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.color} wrapMode="none">{props.lead}</text>
      <text fg={ctx.theme.text.muted} wrapMode="none">{props.value}</text>
    </box>
  )
}

function SidebarStatus(props: { sessionID: string }) {
  const ctx = usePlugin()

  const session = createMemo(() => ctx.data.session.get(props.sessionID))
  const location = () => ctx.location ?? ctx.data.location.default()

  const dir = createMemo(() => {
    const s = session()
    const loc = location()
    return loc?.directory ?? s?.location?.directory
  })

  const vcs = createMemo(() => {
    try {
      return ctx.data.location.vcs.info(location())
    } catch {
      return undefined
    }
  })

  const models = createMemo(() => {
    try {
      return ctx.data.location.model.list(location()) ?? []
    } catch {
      return []
    }
  })

  const modelRef = createMemo(() => session()?.model)
  const modelInfo = createMemo(() => models().find((m: any) => m.id === modelRef()?.id))
  const variant = createMemo(() => modelRef()?.variant)

  const tokens = createMemo(() => session()?.tokens)
  const cost = createMemo(() => session()?.cost)

  const totalTokens = createMemo(() => {
    const t = tokens()
    if (!t) return undefined
    return (num(t.input) ?? 0) + (num(t.output) ?? 0)
  })

  const usagePct = createMemo(() => {
    const t = totalTokens()
    const lim = num(modelInfo()?.limit?.context)
    if (t === undefined || !lim) return undefined
    return t / lim
  })

  const branch = createMemo(() => vcs()?.branch?.current)
  const dirty = createMemo(() => {
    const d = dir()
    if (!d) return false
    try {
      return isDirty(d)
    } catch {
      return false
    }
  })

  const mcp = createMemo(() => {
    try {
      return ctx.data.location.mcp.server.list(location()) ?? []
    } catch {
      return []
    }
  })

  const usageColor = createMemo(() => {
    const p = usagePct()
    if (p === undefined) return ctx.theme.text.muted
    if (p >= 0.8) return ctx.theme.text.feedback.error.base
    if (p >= 0.5) return ctx.theme.text.feedback.warning.base
    return ctx.theme.text.feedback.success.base
  })

  const gitValue = createMemo(() => {
    const b = branch()
    if (!b) return ""
    return dirty() ? b + " ✱" : b
  })
  const gitColor = createMemo(() =>
    dirty() ? ctx.theme.text.feedback.warning.base : ctx.theme.text.base,
  )

  const modelValue = createMemo(() => {
    const m = modelRef()
    if (!m) return ""
    return variant() ? `${m.id} (${variant()})` : m.id
  })

  // --- provider usage meters ---

  const claude = createMemo(() => meters().claude)
  const fable = createMemo(() => meters().fable)
  const codex = createMemo(() => meters().codex)
  const agy = createMemo(() => meters().agy)
  const go = createMemo(() => meters().go)
  const glm = createMemo(() => meters().glm)

  return (
    <box flexDirection="column" gap={0} width="100%">
      <Show when={dir()}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">dir</text>
          <text fg={ctx.theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {baseName(dir())}
          </text>
        </box>
      </Show>

      <Show when={branch()}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">git</text>
          <text fg={gitColor()} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {gitValue()}
          </text>
        </box>
      </Show>

      <Show when={modelRef()}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">model</text>
          <text fg={ctx.theme.text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {modelValue()}
          </text>
        </box>
      </Show>

      <Show when={usagePct() !== undefined}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">ctx</text>
          <text fg={usageColor()} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {fmtPct(usagePct())}
          </text>
        </box>
      </Show>

      <Show when={totalTokens() !== undefined}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">tokens</text>
          <text fg={ctx.theme.text.muted} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {fmtTokens(totalTokens())}
          </text>
        </box>
      </Show>

      <Show when={cost() !== undefined}>
        <box flexDirection="row" gap={1}>
          <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">cost</text>
          <text fg={ctx.theme.text.muted} flexGrow={1} minWidth={0} wrapMode="none" truncate>
            {fmtUsd(cost())}
          </text>
        </box>
      </Show>

      <box height={1} />
      <text fg={ctx.theme.text.muted} wrapMode="none">Usage</text>

      <StateRow
        lead="Claude"
        value={claude().state === "logout" ? "logout" : "—"}
        color={C_ORANGE}
      />
      <StateRow
        lead="Fable"
        value={fable().state === "logout" ? "logout" : "—"}
        color={C_PURPLE}
      />

      <Show when={codex().state === "ok"}>
        <Win lead="Codex" w="5h" pct={codex().fivePct} cd={cd(codex().fiveReset)} color={C_BLUE} pad={0} />
        <Win w="7d" pct={codex().sevenPct} cd={cd(codex().sevenReset)} color={C_BLUE} pad={6} />
      </Show>
      <Show when={codex().state === "credits"}>
        <StateRow lead="Codex" value={codex().balance ? "credits " + codex().balance : "credits"} color={C_BLUE} />
      </Show>

      <StateRow lead="Agy" value="—" color={C_YELLOW} />

      <Show when={go().state === "ok"}>
        <Win lead="Go" w="5h" pct={go().fivePct} cd={cd(go().fiveReset)} color={C_CYAN} pad={0} />
        <Win w="wk" pct={go().weekPct} cd={cd(go().weekReset)} color={C_CYAN} pad={3} />
        <Win w="mo" pct={go().monthPct} cd={cd(go().monthReset)} color={C_CYAN} pad={3} />
        <text fg={ctx.theme.text.muted} paddingLeft={3} wrapMode="none">
          % left
        </text>
        <Show when={(go().extraUsd ?? 0) > 0}>
          <text fg={ctx.theme.text.feedback.warning.base} paddingLeft={3} wrapMode="none">
            +${(go().extraUsd ?? 0).toFixed(2)} extra
          </text>
        </Show>
      </Show>

      <Show when={glm().state === "ok"}>
        <Win lead="GLM" w="5h" pct={glm().fivePct} cd={cd(glm().fiveReset)} color={C_PINK} pad={0} />
        <Win w="7d" pct={glm().weekPct} cd={cd(glm().weekReset)} color={C_PINK} pad={4} />
      </Show>
      <Show when={glm().state === "unauth"}>
        <StateRow lead="GLM" value="unauth" color={C_PINK} />
      </Show>
      <Show when={glm().state === "error"}>
        <StateRow lead="GLM" value="err" color={C_PINK} />
      </Show>

      <Show when={mcp().length > 0}>
        <box height={1} />
        <text fg={ctx.theme.text.muted} width={7} flexShrink={0} wrapMode="none">mcp</text>
        <For each={mcp()}>{(server) => <McpRow server={server} />}</For>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "sidebar-status",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => (
        <SidebarStatus sessionID={sessionID} />
      ),
    })
    const stop = startUsageRefresh(setMeter)
    return () => stop()
  },
})
