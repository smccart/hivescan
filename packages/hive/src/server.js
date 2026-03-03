import express from 'express'
import { WebSocketServer } from 'ws'
import { spawn } from 'node-pty'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const COLOR_PALETTE = [
  '#4ade80', '#34d399', '#fb923c', '#60a5fa',
  '#94a3b8', '#c084fc', '#818cf8', '#fbbf24',
  '#f472b6', '#38bdf8', '#a3e635', '#f97316',
]

// ── Shell / Claude resolution ─────────────────────────────────────────────────

function resolveShellPath() {
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      const out = execFileSync(shell, ['-l', '-c', 'echo $PATH'], { encoding: 'utf8' }).trim()
      if (out) return out
    } catch { /* try next */ }
  }
  return process.env.PATH ?? ''
}

function resolveClaude() {
  const home = process.env.HOME || ''
  const nativeBin = `${home}/.local/bin/claude`
  if (existsSync(nativeBin)) return nativeBin
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      const bin = execFileSync(shell, ['-l', '-c', 'which claude'], { encoding: 'utf8' }).trim()
      if (bin) return bin
    } catch { /* try next */ }
  }
  return 'claude'
}

const SHELL_PATH = resolveShellPath()
const CLAUDE_BIN = resolveClaude()

// ── Waiting-state detection ──────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[()][A-Z0-9])/g, '')
}

function detectWaiting(buffer) {
  const raw = buffer.slice(-5).join('')
  const tail = raw.slice(-2000)
  const clean = stripAnsi(tail).replace(/\r/g, '').trim()
  const lines = clean.split('\n').filter(l => l.trim()).slice(-8)
  if (lines.length === 0) return false
  const text = lines.join('\n')

  if (/\?\s*$/m.test(text)) return true
  if (/\by[/|]n\b/i.test(text)) return true
  if (/\ballow\b/i.test(text)) return true
  if (/\bdeny\b/i.test(text)) return true
  return false
}

// ── Buffer persistence ─────────────────────────────────────────────────────────

function makeBufferHelpers(dataDir) {
  mkdirSync(dataDir, { recursive: true })

  return {
    bufferPath: (name) => join(dataDir, `${name}.buf`),
    loadBuffer: (name) => {
      try {
        const data = readFileSync(join(dataDir, `${name}.buf`), 'utf8')
        return data ? [data] : []
      } catch { return [] }
    },
    scheduleSave: (name, session) => {
      clearTimeout(session.saveTimer)
      session.saveTimer = setTimeout(() => {
        const content = session.buffer.join('')
        if (content) writeFileSync(join(dataDir, `${name}.buf`), content, 'utf8')
      }, 1000)
    },
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function startServer(config, repoRoot) {
  const port = config.port ?? 4199
  const dataDir = join(repoRoot, '.hive')
  const buf = makeBufferHelpers(dataDir)

  // Build AGENT_CONFIG from user config, assigning colors from palette if not set
  const AGENT_CONFIG = {}
  const agentOrder = []
  for (let i = 0; i < config.agents.length; i++) {
    const a = config.agents[i]
    const color = a.color ?? COLOR_PALETTE[i % COLOR_PALETTE.length]
    const absDir = resolve(repoRoot, a.dir)
    AGENT_CONFIG[a.name] = {
      dir: absDir,
      port: a.port ?? null,
      label: a.label ?? a.name,
      color,
    }
    agentOrder.push(a.name)
  }

  // Per-agent session state
  const sessions = {}
  for (const name of agentOrder) {
    sessions[name] = {
      pty: null,
      buffer: buf.loadBuffer(name),
      clients: new Set(),
      active: false,
      waiting: false,
      activityTimer: null,
      saveTimer: null,
    }
  }

  const MAX_BUFFER_BYTES = 50_000

  function trimBuffer(session) {
    let total = session.buffer.reduce((n, s) => n + s.length, 0)
    while (total > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      total -= session.buffer[0].length
      session.buffer.shift()
    }
  }

  function broadcast(session, msg) {
    const str = JSON.stringify(msg)
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(str)
    }
  }

  function buildSpawnEnv() {
    const env = { ...process.env }
    const home = env.HOME || ''
    const localBin = `${home}/.local/bin`
    const basePath = SHELL_PATH || env.PATH || ''
    env.PATH = basePath.split(':').includes(localBin)
      ? basePath
      : `${localBin}:${basePath}`
    env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    delete env.VSCODE_IPC_HOOK
    return env
  }

  function spawnAgent(name) {
    const session = sessions[name]
    if (session.pty) return

    const { dir } = AGENT_CONFIG[name]
    const pty = spawn(CLAUDE_BIN, ['--model', currentModel], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env: buildSpawnEnv(),
    })

    session.pty = pty
    session.buffer = []

    pty.onData((data) => {
      session.buffer.push(data)
      trimBuffer(session)
      broadcast(session, { type: 'output', data })
      buf.scheduleSave(name, session)

      if (!session.active) {
        session.active = true
        session.waiting = false
        broadcast(session, { type: 'activity', active: true, waiting: false })
      }
      clearTimeout(session.activityTimer)
      session.activityTimer = setTimeout(() => {
        session.active = false
        const waiting = detectWaiting(session.buffer)
        session.waiting = waiting
        broadcast(session, { type: 'activity', active: false, waiting })
      }, 1500)
    })

    pty.onExit(({ exitCode }) => {
      clearTimeout(session.activityTimer)
      session.active = false
      session.pty = null
      broadcast(session, { type: 'status', running: false, exitCode })
      console.log(`[${name}] exited (code ${exitCode})`)
    })

    console.log(`[${name}] started`)
    broadcast(session, { type: 'status', running: true })
  }

  function killAgent(name) {
    const session = sessions[name]
    if (session.pty) {
      session.pty.kill()
      session.pty = null
    }
  }

  const MODELS = [
    { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]
  let currentModel = config.defaultModel ?? 'claude-opus-4-6'

  // ── Express ─────────────────────────────────────────────────────────────────

  const app = express()

  // CORS — allow cross-origin requests from other Hive instances (local dev tool)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json())
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/info', (_req, res) => {
    res.json({ label: config.label ?? repoRoot.split('/').pop(), port })
  })

  app.get('/api/agents', (_req, res) => {
    const result = {}
    for (const name of agentOrder) {
      const cfg = AGENT_CONFIG[name]
      result[name] = {
        ...cfg,
        running: !!sessions[name].pty,
        active: sessions[name].active,
        waiting: sessions[name].waiting,
      }
    }
    // Include order so the UI can sort correctly
    res.json({ agents: result, order: agentOrder })
  })

  app.post('/api/agents/:name/start', (req, res) => {
    const { name } = req.params
    if (!AGENT_CONFIG[name]) return res.status(404).json({ error: 'Unknown agent' })
    spawnAgent(name)
    res.json({ ok: true })
  })

  app.post('/api/agents/:name/stop', (req, res) => {
    const { name } = req.params
    if (!AGENT_CONFIG[name]) return res.status(404).json({ error: 'Unknown agent' })
    killAgent(name)
    res.json({ ok: true })
  })

  app.get('/api/model', (_req, res) => {
    res.json({ model: currentModel, models: MODELS })
  })

  app.post('/api/model', (req, res) => {
    const { model } = req.body
    if (!MODELS.find(m => m.id === model)) return res.status(400).json({ error: 'Unknown model' })
    currentModel = model
    console.log(`Model → ${model}`)
    res.json({ ok: true })
  })

  // ── Permissions (.claude/settings.json) ────────────────────────────────────

  app.get('/api/permissions', (_req, res) => {
    const settingsPath = join(repoRoot, '.claude', 'settings.json')
    try {
      const raw = readFileSync(settingsPath, 'utf8')
      res.json(JSON.parse(raw))
    } catch {
      res.json({ defaultMode: 'default', permissions: { allow: [], deny: [] } })
    }
  })

  app.post('/api/permissions', (req, res) => {
    const settingsDir = join(repoRoot, '.claude')
    const settingsPath = join(settingsDir, 'settings.json')
    try {
      const { defaultMode, permissions } = req.body
      if (!defaultMode || !permissions) {
        return res.status(400).json({ error: 'Invalid payload' })
      }
      mkdirSync(settingsDir, { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({ defaultMode, permissions }, null, 2) + '\n', 'utf8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── HTTP + WebSocket server ──────────────────────────────────────────────────

  const server = createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const name = url.searchParams.get('agent')

    if (!name || !AGENT_CONFIG[name]) {
      ws.close(1008, 'Unknown agent')
      return
    }

    const skipBuffer = url.searchParams.get('skipBuffer') === 'true'
    const session = sessions[name]
    session.clients.add(ws)

    if (!skipBuffer && session.buffer.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: session.buffer.join('') }))
    }

    ws.send(JSON.stringify({ type: 'status', running: !!session.pty }))
    ws.send(JSON.stringify({ type: 'activity', active: session.active, waiting: session.waiting }))

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input' && session.pty) {
          session.pty.write(msg.data)
        } else if (msg.type === 'resize' && session.pty) {
          session.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows))
        }
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => {
      session.clients.delete(ws)
    })
  })

  server.listen(port, () => {
    console.log(`\n  Hive running at http://localhost:${port}\n`)
  })

  process.on('SIGINT', () => {
    console.log('\n  Shutting down Hive...')
    for (const name of agentOrder) killAgent(name)
    process.exit(0)
  })
}
