import express from 'express'
import { WebSocketServer } from 'ws'
import { spawn } from 'node-pty'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync, exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { ProjectWatcher } from './scanner.js'

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

const MAX_BUFFER_BYTES = 50_000

function makeBufferHelpers(dataDir) {
  mkdirSync(dataDir, { recursive: true })

  return {
    bufferPath: () => join(dataDir, 'agent.buf'),
    loadBuffer: () => {
      try {
        const data = readFileSync(join(dataDir, 'agent.buf'), 'utf8')
        return data ? [data] : []
      } catch { return [] }
    },
    scheduleSave: (session) => {
      clearTimeout(session.saveTimer)
      session.saveTimer = setTimeout(() => {
        const content = session.buffer.join('')
        if (content) writeFileSync(join(dataDir, 'agent.buf'), content, 'utf8')
      }, 1000)
    },
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function startServer({ port, pollInterval, scanDirs, dataDir }) {
  const MODELS = [
    { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]
  let currentModel = 'claude-sonnet-4-6'

  // Project sessions: { [projectId]: session }
  const sessions = {}
  let colorIdx = 0

  // Control WebSocket clients (for broadcasting project changes)
  const controlClients = new Set()

  function broadcastProjectsChanged() {
    const msg = JSON.stringify({ type: 'projects:changed', projects: getProjectList() })
    for (const ws of controlClients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  function getProjectList() {
    return Object.values(sessions).map(s => ({
      id: s.id,
      name: s.name,
      root: s.root,
      ports: s.ports,
      color: s.color,
      group: s.group,
      groupId: s.groupId,
      running: !!s.pty,
      active: s.active,
      waiting: s.waiting,
    }))
  }

  function projectDataDir(projectId) {
    return join(dataDir, 'projects', projectId)
  }

  function addProject(project) {
    if (sessions[project.id]) {
      // Update ports if changed
      sessions[project.id].ports = project.ports
      return
    }

    const pDataDir = projectDataDir(project.id)
    const buf = makeBufferHelpers(pDataDir)

    sessions[project.id] = {
      id: project.id,
      name: project.name,
      root: project.root,
      ports: project.ports,
      group: project.group ?? null,
      groupId: project.groupId ?? null,
      color: COLOR_PALETTE[colorIdx++ % COLOR_PALETTE.length],
      pty: null,
      buffer: buf.loadBuffer(),
      buf,
      clients: new Set(),
      active: false,
      waiting: false,
      activityTimer: null,
      saveTimer: null,
    }

    const portInfo = project.ports.length > 0 ? ` (${project.ports.map(p => ':' + p).join(' ')})` : ''
    console.log(`  + ${project.name}${portInfo}`)
    broadcastProjectsChanged()
  }

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

  function spawnAgent(projectId) {
    const session = sessions[projectId]
    if (!session || session.pty) return

    let pty
    try {
      pty = spawn(CLAUDE_BIN, ['--model', currentModel], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: session.root,
        env: buildSpawnEnv(),
      })
    } catch (err) {
      console.error(`[${session.name}] failed to spawn: ${err.message}`)
      broadcast(session, { type: 'status', running: false, error: err.message })
      return
    }

    session.pty = pty
    session.buffer = []

    pty.onData((data) => {
      session.buffer.push(data)
      trimBuffer(session)
      broadcast(session, { type: 'output', data })
      session.buf.scheduleSave(session)

      if (!session.active) {
        session.active = true
        session.waiting = false
        broadcast(session, { type: 'activity', active: true, waiting: false })
        broadcastProjectsChanged()
      }
      clearTimeout(session.activityTimer)
      session.activityTimer = setTimeout(() => {
        session.active = false
        const waiting = detectWaiting(session.buffer)
        session.waiting = waiting
        broadcast(session, { type: 'activity', active: false, waiting })
        broadcastProjectsChanged()
      }, 1500)
    })

    pty.onExit(({ exitCode }) => {
      clearTimeout(session.activityTimer)
      session.active = false
      session.waiting = false
      session.pty = null
      broadcast(session, { type: 'status', running: false, exitCode })
      broadcastProjectsChanged()
      console.log(`[${session.name}] exited (code ${exitCode})`)
    })

    console.log(`[${session.name}] started`)
    broadcast(session, { type: 'status', running: true })
    broadcastProjectsChanged()
  }

  function killAgent(projectId) {
    const session = sessions[projectId]
    if (session?.pty) {
      session.pty.kill()
      session.pty = null
      broadcastProjectsChanged()
    }
  }

  // ── Project watcher (dirs + ports) ──────────────────────────────────────────

  const watcher = new ProjectWatcher({ scanDirs, hivePort: port })

  // Directory scan: load projects immediately on startup
  const initialProjects = watcher.discoverFromDirs()
  for (const project of initialProjects) addProject(project)

  // Port scan: updates port info on known projects, may discover extras
  watcher.on('projects:updated', (projectList) => {
    for (const project of projectList) {
      if (sessions[project.id]) {
        const prev = sessions[project.id].ports
        const changed =
          prev.length !== project.ports.length ||
          prev.some(p => !project.ports.includes(p))
        if (changed) {
          sessions[project.id].ports = project.ports
        }
      } else {
        addProject(project)
      }
    }
    broadcastProjectsChanged()
  })

  // ── Express ─────────────────────────────────────────────────────────────────

  const app = express()

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json())
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/info', (_req, res) => {
    res.json({ mode: 'central', port, projectCount: Object.keys(sessions).length })
  })

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: getProjectList() })
  })

  app.post('/api/projects/scan', async (_req, res) => {
    await watcher.scan()
    res.json({ projects: getProjectList() })
  })

  // Resolve project from :id param
  function resolveProject(req, res) {
    const { id } = req.params
    if (!sessions[id]) { res.status(404).json({ error: 'Unknown project' }); return null }
    return sessions[id]
  }

  app.post('/api/projects/:id/start', (req, res) => {
    const session = resolveProject(req, res)
    if (!session) return
    spawnAgent(session.id)
    res.json({ ok: true })
  })

  app.post('/api/projects/:id/stop', (req, res) => {
    const session = resolveProject(req, res)
    if (!session) return
    killAgent(session.id)
    res.json({ ok: true })
  })

  app.post('/api/projects/:id/restart', (req, res) => {
    const session = resolveProject(req, res)
    if (!session) return

    killAgent(session.id)
    session.buffer = []
    clearTimeout(session.saveTimer)
    try { unlinkSync(session.buf.bufferPath()) } catch { /* ok */ }

    setTimeout(() => {
      spawnAgent(session.id)
      res.json({ ok: true })
    }, 300)
  })

  app.get('/api/model', (_req, res) => {
    res.json({ model: currentModel, models: MODELS })
  })

  app.post('/api/model', (req, res) => {
    const { model } = req.body
    if (!MODELS.find(m => m.id === model)) return res.status(400).json({ error: 'Unknown model' })
    currentModel = model
    console.log(`Model -> ${model}`)
    res.json({ ok: true })
  })

  // ── Permissions (project-scoped) ─────────────────────────────────────────

  app.get('/api/projects/:id/permissions', (req, res) => {
    const session = resolveProject(req, res)
    if (!session) return
    const settingsPath = join(session.root, '.claude', 'settings.json')
    try {
      const raw = readFileSync(settingsPath, 'utf8')
      res.json(JSON.parse(raw))
    } catch {
      res.json({ defaultMode: 'default', permissions: { allow: [], deny: [] } })
    }
  })

  app.put('/api/projects/:id/permissions', (req, res) => {
    const session = resolveProject(req, res)
    if (!session) return
    const settingsDir = join(session.root, '.claude')
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
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // Control channel: /ws/control — receives project list updates
    if (path === '/ws/control') {
      controlClients.add(ws)
      ws.send(JSON.stringify({ type: 'projects:changed', projects: getProjectList() }))
      ws.on('close', () => controlClients.delete(ws))
      return
    }

    // Terminal channel: /ws?project=<id>
    const projectId = url.searchParams.get('project')
    if (!projectId || !sessions[projectId]) {
      ws.close(1008, 'Unknown project')
      return
    }

    const skipBuffer = url.searchParams.get('skipBuffer') === 'true'
    const session = sessions[projectId]
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
        } else if (msg.type === 'clear') {
          session.buffer = []
          clearTimeout(session.saveTimer)
          try { unlinkSync(session.buf.bufferPath()) } catch { /* ok */ }
        }
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => {
      session.clients.delete(ws)
    })
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Error: port ${port} is already in use.`)
      console.error(`  Try a different port: hive --port ${port + 1}\n`)
    } else {
      console.error(`\n  Server error: ${err.message}\n`)
    }
    process.exit(1)
  })

  server.listen(port, () => {
    const count = Object.keys(sessions).length
    console.log(`\n  Hive running at http://localhost:${port}`)
    console.log(`  ${count} project(s) found, scanning ports every ${pollInterval / 1000}s...\n`)
    watcher.start(pollInterval)

    // Open browser
    const url = `http://localhost:${port}`
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} ${url}`)
  })

  function shutdown() {
    console.log('\n  Shutting down Hive...')
    watcher.stop()
    for (const session of Object.values(sessions)) {
      if (session.pty) session.pty.kill()
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
