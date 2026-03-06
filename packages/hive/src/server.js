import express from 'express'
import { WebSocketServer } from 'ws'
import { spawn } from 'node-pty'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
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


// ── Main export ───────────────────────────────────────────────────────────────

export function startServer({ port, pollInterval, scanDirs, dataDir, noOpen }) {
  const MODELS = [
    { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]
  let currentModel = 'claude-sonnet-4-6'

  // Project registry: discovered projects (no PTY info)
  const projectRegistry = {}  // { [projectId]: { id, name, root, ports, color, group, groupId } }
  // Agent instances: running/stopped agents with PTYs
  const agents = {}            // { [sessionId]: agentSession }
  let colorIdx = 0

  // Control WebSocket clients (for broadcasting project changes)
  const controlClients = new Set()
  let detectedPorts = []

  function broadcastProjectsChanged() {
    const msg = JSON.stringify({ type: 'projects:changed', projects: getProjectList(), detectedPorts })
    for (const ws of controlClients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  function getProjectList() {
    return Object.values(projectRegistry).map(p => ({
      id: p.id,
      name: p.name,
      root: p.root,
      ports: p.ports,
      color: p.color,
      group: p.group,
      groupId: p.groupId,
      agents: getAgentsForProject(p.id),
    }))
  }

  function getAgentsForProject(projectId) {
    return Object.values(agents)
      .filter(a => a.projectId === projectId)
      .map(a => ({
        sessionId: a.sessionId,
        instanceIdx: a.instanceIdx,
        running: !!a.pty,
        active: a.active,
        waiting: a.waiting,
      }))
      .sort((a, b) => a.instanceIdx - b.instanceIdx)
  }

  function projectDataDir(projectId) {
    return join(dataDir, 'projects', projectId)
  }

  function migrateBuffer(projectId) {
    const pDir = projectDataDir(projectId)
    const oldPath = join(pDir, 'agent.buf')
    const newPath = join(pDir, 'agent-0.buf')
    if (existsSync(oldPath) && !existsSync(newPath)) {
      mkdirSync(pDir, { recursive: true })
      renameSync(oldPath, newPath)
    }
  }

  function addProject(project) {
    if (projectRegistry[project.id]) {
      // Update ports if changed
      projectRegistry[project.id].ports = project.ports
      return
    }

    migrateBuffer(project.id)

    projectRegistry[project.id] = {
      id: project.id,
      name: project.name,
      root: project.root,
      ports: project.ports,
      group: project.group ?? null,
      groupId: project.groupId ?? null,
      color: COLOR_PALETTE[colorIdx++ % COLOR_PALETTE.length],
    }

    const portInfo = project.ports.length > 0 ? ` (${project.ports.map(p => ':' + p).join(' ')})` : ''
    console.log(`  + ${project.name}${portInfo}`)
    broadcastProjectsChanged()
  }

  function nextInstanceIdx(projectId) {
    const existing = Object.values(agents).filter(a => a.projectId === projectId)
    if (existing.length === 0) return 0
    return Math.max(...existing.map(a => a.instanceIdx)) + 1
  }

  function makeAgentBufferHelpers(projectId, instanceIdx) {
    const pDir = projectDataDir(projectId)
    mkdirSync(pDir, { recursive: true })
    const bufPath = join(pDir, `agent-${instanceIdx}.buf`)
    return {
      bufferPath: () => bufPath,
      loadBuffer: () => {
        try {
          const data = readFileSync(bufPath, 'utf8')
          return data ? [data] : []
        } catch { return [] }
      },
      scheduleSave: (agent) => {
        clearTimeout(agent.saveTimer)
        agent.saveTimer = setTimeout(() => {
          const content = agent.buffer.join('')
          if (content) writeFileSync(bufPath, content, 'utf8')
        }, 1000)
      },
    }
  }

  function createAgentSession(projectId, instanceIdx) {
    const sessionId = `${projectId}:${instanceIdx}`
    if (agents[sessionId]) return agents[sessionId]

    const buf = makeAgentBufferHelpers(projectId, instanceIdx)
    agents[sessionId] = {
      sessionId,
      projectId,
      instanceIdx,
      pty: null,
      buffer: buf.loadBuffer(),
      buf,
      clients: new Set(),
      active: false,
      waiting: false,
      activityTimer: null,
      saveTimer: null,
    }
    return agents[sessionId]
  }

  function trimBuffer(agent) {
    let total = agent.buffer.reduce((n, s) => n + s.length, 0)
    while (total > MAX_BUFFER_BYTES && agent.buffer.length > 0) {
      total -= agent.buffer[0].length
      agent.buffer.shift()
    }
  }

  function broadcast(agent, msg) {
    const str = JSON.stringify(msg)
    for (const ws of agent.clients) {
      if (ws.readyState === 1) ws.send(str)
    }
  }

  function buildSpawnEnv() {
    // Whitelist safe env vars instead of forwarding everything
    const SAFE_ENV_KEYS = [
      'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'TERM', 'TERM_PROGRAM', 'COLORTERM',
      'PATH', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'NODE_ENV', 'EDITOR', 'VISUAL',
      // Claude-specific
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENTRYPOINT',
    ]
    const env = {}
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    const home = env.HOME || ''
    const localBin = `${home}/.local/bin`
    const basePath = SHELL_PATH || env.PATH || ''
    env.PATH = basePath.split(':').includes(localBin)
      ? basePath
      : `${localBin}:${basePath}`
    env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    return env
  }

  function spawnAgentPty(sessionId) {
    const agent = agents[sessionId]
    if (!agent || agent.pty) return
    const project = projectRegistry[agent.projectId]
    if (!project) return

    let pty
    try {
      pty = spawn(CLAUDE_BIN, ['--model', currentModel], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: project.root,
        env: buildSpawnEnv(),
      })
    } catch (err) {
      console.error(`[${project.name}:${agent.instanceIdx}] failed to spawn: ${err.message}`)
      broadcast(agent, { type: 'status', running: false, error: err.message })
      return
    }

    agent.pty = pty
    agent.buffer = []

    pty.onData((data) => {
      agent.buffer.push(data)
      trimBuffer(agent)
      broadcast(agent, { type: 'output', data })
      agent.buf.scheduleSave(agent)

      if (!agent.active) {
        agent.active = true
        agent.waiting = false
        broadcast(agent, { type: 'activity', active: true, waiting: false })
        broadcastProjectsChanged()
      }
      clearTimeout(agent.activityTimer)
      agent.activityTimer = setTimeout(() => {
        agent.active = false
        const waiting = detectWaiting(agent.buffer)
        agent.waiting = waiting
        broadcast(agent, { type: 'activity', active: false, waiting })
        broadcastProjectsChanged()
      }, 1500)
    })

    pty.onExit(({ exitCode }) => {
      clearTimeout(agent.activityTimer)
      agent.active = false
      agent.waiting = false
      agent.pty = null
      broadcast(agent, { type: 'status', running: false, exitCode })
      broadcastProjectsChanged()
      console.log(`[${project.name}:${agent.instanceIdx}] exited (code ${exitCode})`)
    })

    console.log(`[${project.name}:${agent.instanceIdx}] started`)
    broadcast(agent, { type: 'status', running: true })
    broadcastProjectsChanged()
  }

  function killAgentPty(sessionId) {
    const agent = agents[sessionId]
    if (agent?.pty) {
      agent.pty.kill()
      agent.pty = null
      broadcastProjectsChanged()
    }
  }

  function removeAgent(sessionId) {
    const agent = agents[sessionId]
    if (!agent) return
    if (agent.pty) agent.pty.kill()
    clearTimeout(agent.activityTimer)
    clearTimeout(agent.saveTimer)
    try { unlinkSync(agent.buf.bufferPath()) } catch { /* ok */ }
    delete agents[sessionId]
    broadcastProjectsChanged()
  }

  // ── Project watcher (dirs + ports) ──────────────────────────────────────────

  const watcher = new ProjectWatcher({ scanDirs, hivePort: port })

  // Directory scan: load projects immediately on startup
  const initialProjects = watcher.discoverFromDirs()
  for (const project of initialProjects) addProject(project)

  // Port scan: updates port info on known projects, may discover extras
  watcher.on('projects:updated', (projectList, allPorts) => {
    detectedPorts = allPorts || []
    for (const project of projectList) {
      if (projectRegistry[project.id]) {
        const prev = projectRegistry[project.id].ports
        const changed =
          prev.length !== project.ports.length ||
          prev.some(p => !project.ports.includes(p))
        if (changed) {
          projectRegistry[project.id].ports = project.ports
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
    const origin = _req.headers.origin || ''
    const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : `http://localhost:${port}`)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json())
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/info', (_req, res) => {
    res.json({ mode: 'central', port, projectCount: Object.keys(projectRegistry).length })
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
    if (!projectRegistry[id]) { res.status(404).json({ error: 'Unknown project' }); return null }
    return projectRegistry[id]
  }

  // Spawn a new agent instance for a project
  app.post('/api/projects/:id/agents', (req, res) => {
    const project = resolveProject(req, res)
    if (!project) return
    const idx = nextInstanceIdx(project.id)
    const agent = createAgentSession(project.id, idx)
    spawnAgentPty(agent.sessionId)
    res.json({ sessionId: agent.sessionId, instanceIdx: idx })
  })

  // Start agent (backward compat: starts instance 0)
  app.post('/api/projects/:id/start', (req, res) => {
    const project = resolveProject(req, res)
    if (!project) return
    const sessionId = `${project.id}:0`
    if (!agents[sessionId]) createAgentSession(project.id, 0)
    spawnAgentPty(sessionId)
    res.json({ ok: true })
  })

  // Stop all agents for a project
  app.post('/api/projects/:id/stop', (req, res) => {
    const project = resolveProject(req, res)
    if (!project) return
    for (const agent of Object.values(agents)) {
      if (agent.projectId === project.id) killAgentPty(agent.sessionId)
    }
    res.json({ ok: true })
  })

  // Restart agent (backward compat: restarts instance 0)
  app.post('/api/projects/:id/restart', (req, res) => {
    const project = resolveProject(req, res)
    if (!project) return
    const sessionId = `${project.id}:0`
    const agent = agents[sessionId]
    if (!agent) return res.status(404).json({ error: 'No agent instance' })

    killAgentPty(sessionId)
    agent.buffer = []
    clearTimeout(agent.saveTimer)
    try { unlinkSync(agent.buf.bufferPath()) } catch { /* ok */ }

    setTimeout(() => {
      spawnAgentPty(sessionId)
      res.json({ ok: true })
    }, 300)
  })

  // Agent-specific endpoints (by sessionId)
  app.post('/api/agents/:sessionId/stop', (req, res) => {
    const { sessionId } = req.params
    if (!agents[sessionId]) return res.status(404).json({ error: 'Unknown agent' })
    killAgentPty(sessionId)
    res.json({ ok: true })
  })

  app.post('/api/agents/:sessionId/restart', (req, res) => {
    const { sessionId } = req.params
    const agent = agents[sessionId]
    if (!agent) return res.status(404).json({ error: 'Unknown agent' })

    killAgentPty(sessionId)
    agent.buffer = []
    clearTimeout(agent.saveTimer)
    try { unlinkSync(agent.buf.bufferPath()) } catch { /* ok */ }

    setTimeout(() => {
      spawnAgentPty(sessionId)
      res.json({ ok: true })
    }, 300)
  })

  app.delete('/api/agents/:sessionId', (req, res) => {
    const { sessionId } = req.params
    if (!agents[sessionId]) return res.status(404).json({ error: 'Unknown agent' })
    removeAgent(sessionId)
    res.json({ ok: true })
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
    const project = resolveProject(req, res)
    if (!project) return
    const settingsPath = join(project.root, '.claude', 'settings.json')
    try {
      const raw = readFileSync(settingsPath, 'utf8')
      res.json(JSON.parse(raw))
    } catch {
      res.json({ defaultMode: 'default', permissions: { allow: [], deny: [] } })
    }
  })

  const VALID_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']

  app.put('/api/projects/:id/permissions', (req, res) => {
    const project = resolveProject(req, res)
    if (!project) return
    const settingsDir = join(project.root, '.claude')
    const settingsPath = join(settingsDir, 'settings.json')
    try {
      const { defaultMode, permissions } = req.body
      if (!defaultMode || !permissions) {
        return res.status(400).json({ error: 'Invalid payload' })
      }
      if (!VALID_MODES.includes(defaultMode)) {
        return res.status(400).json({ error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` })
      }
      if (!Array.isArray(permissions.allow) || !Array.isArray(permissions.deny)) {
        return res.status(400).json({ error: 'permissions.allow and permissions.deny must be arrays' })
      }
      const allRules = [...permissions.allow, ...permissions.deny]
      if (allRules.some(r => typeof r !== 'string' || r.length > 200)) {
        return res.status(400).json({ error: 'Each rule must be a string under 200 characters' })
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
      ws.send(JSON.stringify({ type: 'projects:changed', projects: getProjectList(), detectedPorts }))
      ws.on('close', () => controlClients.delete(ws))
      return
    }

    // Terminal channel: /ws?session=<sessionId> or /ws?project=<id> (backward compat)
    let sessionId = url.searchParams.get('session')
    if (!sessionId) {
      const projectId = url.searchParams.get('project')
      if (projectId) sessionId = `${projectId}:0`
    }
    if (!sessionId || !agents[sessionId]) {
      ws.close(1008, 'Unknown agent session')
      return
    }

    const skipBuffer = url.searchParams.get('skipBuffer') === 'true'
    const agent = agents[sessionId]
    agent.clients.add(ws)

    if (!skipBuffer && agent.buffer.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: agent.buffer.join('') }))
    }

    ws.send(JSON.stringify({ type: 'status', running: !!agent.pty }))
    ws.send(JSON.stringify({ type: 'activity', active: agent.active, waiting: agent.waiting }))

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input' && agent.pty) {
          agent.pty.write(msg.data)
        } else if (msg.type === 'resize' && agent.pty) {
          agent.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows))
        } else if (msg.type === 'clear') {
          agent.buffer = []
          clearTimeout(agent.saveTimer)
          try { unlinkSync(agent.buf.bufferPath()) } catch { /* ok */ }
        }
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => {
      agent.clients.delete(ws)
    })
  })

  server.listen(port, () => {
    const count = Object.keys(projectRegistry).length
    console.log(`\n  HiveScan running at http://localhost:${port}`)
    console.log(`  ${count} project(s) found, scanning ports every ${pollInterval / 1000}s...\n`)
    watcher.start(pollInterval)

    // Open browser unless --no-open was passed
    if (!noOpen) {
      const url = `http://localhost:${port}`
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      execFile(cmd, [url], () => {})
    }
  })

  function shutdown() {
    console.log('\n  Shutting down HiveScan...')
    watcher.stop()
    for (const agent of Object.values(agents)) {
      if (agent.pty) agent.pty.kill()
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
