const TERM_THEME = {
  background:          '#0a0a0a',
  foreground:          '#e4e4e7',
  cursor:              '#e4e4e7',
  cursorAccent:        '#0a0a0a',
  selectionBackground: '#3f3f46',
  black:    '#18181b', brightBlack:   '#52525b',
  red:      '#f87171', brightRed:     '#fca5a5',
  green:    '#4ade80', brightGreen:   '#86efac',
  yellow:   '#facc15', brightYellow:  '#fde047',
  blue:     '#60a5fa', brightBlue:    '#93c5fd',
  magenta:  '#c084fc', brightMagenta: '#d8b4fe',
  cyan:     '#34d399', brightCyan:    '#6ee7b7',
  white:    '#e4e4e7', brightWhite:   '#f4f4f5',
}

// ── Multi-repo state ──────────────────────────────────────────────────────────

// { [port]: { port, label, baseUrl, wsBase, agentOrder, agents, agentStatus,
//             agentActivity, agentWasActive, terminals, activeAgent, model, models } }
const repoState = {}

let repoList = []     // ordered list of ports, persisted to localStorage
let activeRepo = null // currently shown port (number)

const LS_KEY = 'hive_repos'

function saveRepoList() {
  localStorage.setItem(LS_KEY, JSON.stringify(repoList))
}

function loadRepoList() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] }
}

// ── Notifications ──

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const n = new Notification(title, { body })
  n.onclick = () => { window.focus(); n.close() }
}

function maybeNotify(port, name, title, body) {
  const repo = repoState[port]
  if (document.hidden || port !== activeRepo || name !== repo?.activeAgent) {
    notify(title, body)
  }
}

// ── DOM refs ──
const agentListEl    = document.getElementById('agent-list')
const termContainer  = document.getElementById('terminal-container')
const headerColorBar = document.getElementById('header-color-bar')
const headerDot      = document.getElementById('header-dot')
const headerName     = document.getElementById('header-name')
const headerPort     = document.getElementById('header-port')
const btnStart       = document.getElementById('btn-start')
const btnStop        = document.getElementById('btn-stop')
const btnStartAll    = document.getElementById('btn-start-all')
const btnStopAll     = document.getElementById('btn-stop-all')
const modelSelect    = document.getElementById('model-select')
const repoTabsEl     = document.getElementById('repo-tabs')
const btnPermissions     = document.getElementById('btn-permissions')
const permissionsModal   = document.getElementById('permissions-modal')
const permissionsClose   = document.getElementById('permissions-close')
const permModeSelect     = document.getElementById('perm-mode')
const permAllowList      = document.getElementById('perm-allow-list')
const permDenyList       = document.getElementById('perm-deny-list')
const permAddAllow       = document.getElementById('perm-add-allow')
const permAddDeny        = document.getElementById('perm-add-deny')
const permSave           = document.getElementById('perm-save')

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  requestNotificationPermission()

  const primaryPort = parseInt(location.port || '80', 10)

  // Merge: always include primary port first, then any saved extras
  const saved = loadRepoList().filter(p => p !== primaryPort)
  repoList = [primaryPort, ...saved]

  // Init all repos in parallel — skip ones we can't reach
  await Promise.all(repoList.map(p => initRepo(p).catch(() => null)))

  // Remove ports that failed to load (server not running)
  repoList = repoList.filter(p => repoState[p])
  saveRepoList()

  renderRepoTabs()
  if (repoList.length > 0) await selectRepo(repoList[0])
}

// ── Repo management ───────────────────────────────────────────────────────────

async function initRepo(port) {
  const base = `http://localhost:${port}`
  const wsBase = `ws://localhost:${port}`

  const [infoData, agentData, modelData] = await Promise.all([
    fetch(`${base}/api/info`).then(r => r.json()),
    fetch(`${base}/api/agents`).then(r => r.json()),
    fetch(`${base}/api/model`).then(r => r.json()),
  ])

  const agentOrder = agentData.order ?? Object.keys(agentData.agents)
  const agents = {}
  const agentStatus = {}
  const agentActivity = {}
  const agentWasActive = {}
  const agentWaiting = {}

  for (const name of agentOrder) {
    const a = agentData.agents[name]
    if (!a) continue
    agents[name] = a
    agentStatus[name] = a.running
    agentActivity[name] = a.active ?? false
    agentWasActive[name] = false
    agentWaiting[name] = a.waiting ?? false
  }

  repoState[port] = {
    port,
    label: infoData.label ?? `localhost:${port}`,
    baseUrl: base,
    wsBase,
    agentOrder,
    agents,
    agentStatus,
    agentActivity,
    agentWasActive,
    agentWaiting,
    terminals: {},
    activeAgent: null,
    model: modelData.model,
    models: modelData.models,
  }
}

async function addRepo() {
  const input = window.prompt('Port of running Hive instance:')
  if (!input) return
  const port = parseInt(input.trim(), 10)
  if (!port || isNaN(port)) return window.alert('Invalid port number.')
  if (repoList.includes(port)) {
    // Already added — just switch to it
    return selectRepo(port)
  }

  try {
    await initRepo(port)
  } catch {
    return window.alert(`Could not connect to Hive on port ${port}.\nMake sure it's running.`)
  }

  repoList.push(port)
  saveRepoList()
  renderRepoTabs()
  selectRepo(port)
}

function removeRepo(port) {
  // Clean up terminals
  const repo = repoState[port]
  if (repo) {
    for (const name of Object.keys(repo.terminals)) {
      const t = repo.terminals[name]
      t.resizeObserver.disconnect()
      t.ws.current?.close()
      t.div.remove()
    }
    delete repoState[port]
  }

  repoList = repoList.filter(p => p !== port)
  saveRepoList()
  renderRepoTabs()

  if (activeRepo === port) {
    activeRepo = null
    if (repoList.length > 0) {
      selectRepo(repoList[0])
    } else {
      agentListEl.innerHTML = ''
      headerName.textContent = 'No repos'
    }
  }
}

// ── Repo tabs UI ──────────────────────────────────────────────────────────────

function renderRepoTabs() {
  repoTabsEl.innerHTML = ''

  for (const port of repoList) {
    const repo = repoState[port]
    if (!repo) continue

    const tab = document.createElement('div')
    tab.className = 'repo-tab' + (port === activeRepo ? ' active' : '')
    tab.dataset.port = port

    const labelSpan = document.createElement('span')
    labelSpan.textContent = repo.label

    const closeBtn = document.createElement('button')
    closeBtn.className = 'repo-tab-close'
    closeBtn.title = 'Remove repo'
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      removeRepo(port)
    })

    tab.appendChild(labelSpan)
    tab.appendChild(closeBtn)
    tab.addEventListener('click', () => selectRepo(port))
    repoTabsEl.appendChild(tab)
  }

  // '+' button
  const addBtn = document.createElement('button')
  addBtn.className = 'repo-tab-add'
  addBtn.title = 'Add another Hive repo'
  addBtn.textContent = '+'
  addBtn.addEventListener('click', addRepo)
  repoTabsEl.appendChild(addBtn)
}

// ── Select repo ───────────────────────────────────────────────────────────────

async function selectRepo(port) {
  const repo = repoState[port]
  if (!repo) return

  // Deactivate all terminals from old repo
  if (activeRepo && activeRepo !== port) {
    const old = repoState[activeRepo]
    if (old?.activeAgent && old.terminals[old.activeAgent]) {
      old.terminals[old.activeAgent].div.classList.remove('active')
    }
  }

  activeRepo = port

  // Update tab highlights
  repoTabsEl.querySelectorAll('.repo-tab').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.port, 10) === port)
  })

  // Sync model selector to this repo's model
  syncModelSelector(repo)

  // Re-render sidebar agents for this repo
  renderSidebar()

  // Select agent: restore previous or pick first
  const agentToSelect = repo.activeAgent ?? repo.agentOrder[0]
  if (agentToSelect) {
    selectAgent(agentToSelect)
  } else {
    headerName.textContent = 'No agents'
  }
}

// ── Model selector ────────────────────────────────────────────────────────────

function syncModelSelector(repo) {
  modelSelect.innerHTML = ''
  for (const m of (repo.models ?? [])) {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = m.label
    if (m.id === repo.model) opt.selected = true
    modelSelect.appendChild(opt)
  }
}

modelSelect.addEventListener('change', () => {
  const repo = repoState[activeRepo]
  if (!repo) return
  repo.model = modelSelect.value
  fetch(`${repo.baseUrl}/api/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelSelect.value }),
  })
})

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  agentListEl.innerHTML = ''
  const repo = repoState[activeRepo]
  if (!repo) return

  for (const name of repo.agentOrder) {
    const agent = repo.agents[name]
    if (!agent) continue

    const item = document.createElement('div')
    item.className = 'agent-item'
    item.dataset.name = name
    item.style.setProperty('--agent-color', agent.color)

    item.innerHTML = `
      <span class="agent-color-dot ${repo.agentStatus[name] ? 'running' : ''}"
            style="background:${agent.color}"></span>
      <span class="agent-info">
        <span class="agent-label">${agent.label}</span>
        <span class="agent-meta">${agent.port ? `:${agent.port}` : 'agent'}</span>
      </span>
      <span class="agent-status ${repo.agentStatus[name] ? 'running' : ''}"></span>
    `

    item.addEventListener('click', () => selectAgent(name))
    agentListEl.appendChild(item)
  }
}

function updateSidebarItem(port, name) {
  if (port !== activeRepo) return
  const repo = repoState[port]
  const item = agentListEl.querySelector(`[data-name="${name}"]`)
  if (!item || !repo) return
  const running = repo.agentStatus[name]
  const active  = repo.agentActivity[name]
  const waiting = repo.agentWaiting[name]
  const dot    = item.querySelector('.agent-color-dot')
  const status = item.querySelector('.agent-status')
  if (dot) {
    dot.classList.toggle('running', running)
    dot.classList.toggle('thinking', running && active)
    dot.classList.toggle('waiting', running && !active && waiting)
  }
  if (status) status.classList.toggle('running', running)

  const t = repo.terminals[name]
  if (t) t.div.classList.toggle('stopped', !running)
}

// ── Select / switch agent ─────────────────────────────────────────────────────

function selectAgent(name) {
  const repo = repoState[activeRepo]
  if (!repo || !repo.agents[name]) return

  // Deactivate currently active terminal for this repo
  if (repo.activeAgent && repo.terminals[repo.activeAgent]) {
    repo.terminals[repo.activeAgent].div.classList.remove('active')
  }

  agentListEl.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.name === name)
  })

  repo.activeAgent = name
  const agent = repo.agents[name]

  headerColorBar.style.background = agent.color
  headerDot.style.background = agent.color
  const isActive = repo.agentActivity[name] ?? false
  const isWaiting = repo.agentWaiting[name] ?? false
  headerDot.classList.toggle('thinking', isActive)
  headerDot.classList.toggle('waiting', !isActive && isWaiting)
  headerName.textContent = agent.label

  if (agent.port) {
    headerPort.textContent = `:${agent.port}`
    headerPort.href = `http://localhost:${agent.port}`
    headerPort.classList.add('linkable')
  } else {
    headerPort.textContent = 'agent'
    headerPort.removeAttribute('href')
    headerPort.classList.remove('linkable')
  }
  headerPort.style.display = ''
  document.documentElement.style.setProperty('--active-color', agent.color)

  updateHeaderButtons()

  if (!repo.terminals[name]) createTerminal(activeRepo, name)
  repo.terminals[name].div.classList.add('active')

  requestAnimationFrame(() => {
    const t = repo.terminals[name]
    if (!t) return
    const atBottom = t.term.buffer.active.viewportY >= t.term.buffer.active.baseY
    t.fitAddon.fit()
    if (atBottom) t.term.scrollToBottom()
  })
}

// ── Terminal creation ─────────────────────────────────────────────────────────

function createTerminal(port, name) {
  const repo = repoState[port]
  if (!repo) return

  const div = document.createElement('div')
  div.className = 'terminal-instance active'
  div.dataset.repo = port
  termContainer.appendChild(div)

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.4,
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
    macOptionIsMeta: true,
  })

  const fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(div)
  fitAddon.fit()

  const wsRef = { current: null }

  term.onData((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  })

  let resizeTimer = null
  const resizeObserver = new ResizeObserver(() => {
    if (!div.classList.contains('active')) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      const atBottom = term.buffer.active.viewportY >= term.buffer.active.baseY
      fitAddon.fit()
      if (atBottom) term.scrollToBottom()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }, 50)
  })
  resizeObserver.observe(termContainer)

  repo.terminals[name] = { term, fitAddon, div, ws: wsRef, resizeObserver }
  if (!repo.agentStatus[name]) div.classList.add('stopped')
  connectWS(port, name, term, wsRef)
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS(port, name, term, wsRef, skipBuffer = false) {
  const repo = repoState[port]
  if (!repo) return

  const wsUrl = `${repo.wsBase}/ws?agent=${name}&skipBuffer=${skipBuffer}`
  const ws = new WebSocket(wsUrl)
  wsRef.current = ws

  ws.addEventListener('message', (e) => {
    const repo = repoState[port]
    if (!repo) return
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'status') {
        const wasRunning = repo.agentStatus[name]
        repo.agentStatus[name] = msg.running
        updateSidebarItem(port, name)
        if (port === activeRepo && name === repo.activeAgent) updateHeaderButtons()
        if (wasRunning && !msg.running) {
          maybeNotify(port, name, `${repo.agents[name]?.label ?? name} stopped`, 'Agent session ended')
        }
      } else if (msg.type === 'activity') {
        const prev = repo.agentWasActive[name]
        repo.agentActivity[name] = msg.active
        repo.agentWaiting[name] = msg.waiting ?? false
        repo.agentWasActive[name] = msg.active
        updateSidebarItem(port, name)
        if (port === activeRepo && name === repo.activeAgent) {
          headerDot.classList.toggle('thinking', msg.active)
          headerDot.classList.toggle('waiting', !msg.active && (msg.waiting ?? false))
        }
        if (prev && !msg.active && repo.agentStatus[name]) {
          const label = repo.agents[name]?.label ?? name
          if (msg.waiting) {
            maybeNotify(port, name, `${label} needs input`, 'Waiting for your response')
          } else {
            maybeNotify(port, name, `${label} finished`, 'Claude is done responding')
          }
        }
      }
    } catch { /* ignore */ }
  })

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  })

  ws.addEventListener('close', () => {
    term.write('\r\n\x1b[90m[disconnected — reconnecting...]\x1b[0m\r\n')
    setTimeout(() => {
      const repo = repoState[port]
      if (!repo || !repo.terminals[name]) return
      connectWS(port, name, term, wsRef, true)
    }, 3000)
  })
}

// ── Header buttons ────────────────────────────────────────────────────────────

function updateHeaderButtons() {
  const repo = repoState[activeRepo]
  if (!repo?.activeAgent) return
  const running = repo.agentStatus[repo.activeAgent]
  btnStart.style.opacity = running ? '0.4' : '1'
  btnStop.style.opacity  = running ? '1'   : '0.4'
}

btnStart.addEventListener('click', async () => {
  const repo = repoState[activeRepo]
  if (!repo?.activeAgent) return
  const name = repo.activeAgent
  await fetch(`${repo.baseUrl}/api/agents/${name}/start`, { method: 'POST' })
  repo.agentStatus[name] = true
  updateSidebarItem(activeRepo, name)
  updateHeaderButtons()
})

btnStop.addEventListener('click', async () => {
  const repo = repoState[activeRepo]
  if (!repo?.activeAgent) return
  const name = repo.activeAgent
  await fetch(`${repo.baseUrl}/api/agents/${name}/stop`, { method: 'POST' })
  repo.agentStatus[name] = false
  updateSidebarItem(activeRepo, name)
  updateHeaderButtons()
})

btnStartAll.addEventListener('click', async () => {
  const repo = repoState[activeRepo]
  if (!repo) return
  for (const name of repo.agentOrder) {
    await fetch(`${repo.baseUrl}/api/agents/${name}/start`, { method: 'POST' })
    repo.agentStatus[name] = true
    updateSidebarItem(activeRepo, name)
  }
  updateHeaderButtons()
})

btnStopAll.addEventListener('click', async () => {
  const repo = repoState[activeRepo]
  if (!repo) return
  for (const name of repo.agentOrder) {
    await fetch(`${repo.baseUrl}/api/agents/${name}/stop`, { method: 'POST' })
    repo.agentStatus[name] = false
    updateSidebarItem(activeRepo, name)
  }
  updateHeaderButtons()
})

// ── Permissions modal ─────────────────────────────────────────────────────────

let permDraft = { defaultMode: 'default', permissions: { allow: [], deny: [] } }

async function loadPermissions() {
  const repo = repoState[activeRepo]
  if (!repo) return
  try {
    const res = await fetch(`${repo.baseUrl}/api/permissions`)
    const data = await res.json()
    permDraft = {
      defaultMode: data.defaultMode ?? 'default',
      permissions: {
        allow: [...(data.permissions?.allow ?? [])],
        deny:  [...(data.permissions?.deny ?? [])],
      }
    }
  } catch {
    permDraft = { defaultMode: 'default', permissions: { allow: [], deny: [] } }
  }
}

function renderPermRule(rule) {
  const item = document.createElement('div')
  item.className = 'perm-rule-item'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'perm-rule-input'
  input.value = rule
  input.placeholder = 'e.g. Bash(git diff *)'

  const removeBtn = document.createElement('button')
  removeBtn.className = 'perm-rule-remove'
  removeBtn.title = 'Remove rule'
  removeBtn.textContent = '\u00d7'
  removeBtn.addEventListener('click', () => item.remove())

  item.appendChild(input)
  item.appendChild(removeBtn)
  return item
}

function renderPermissions() {
  permModeSelect.value = permDraft.defaultMode

  permAllowList.innerHTML = ''
  for (const rule of permDraft.permissions.allow) {
    permAllowList.appendChild(renderPermRule(rule))
  }

  permDenyList.innerHTML = ''
  for (const rule of permDraft.permissions.deny) {
    permDenyList.appendChild(renderPermRule(rule))
  }
}

function syncDraftFromDOM() {
  permDraft.defaultMode = permModeSelect.value
  permDraft.permissions.allow = []
  permAllowList.querySelectorAll('.perm-rule-input').forEach(input => {
    const val = input.value.trim()
    if (val) permDraft.permissions.allow.push(val)
  })
  permDraft.permissions.deny = []
  permDenyList.querySelectorAll('.perm-rule-input').forEach(input => {
    const val = input.value.trim()
    if (val) permDraft.permissions.deny.push(val)
  })
}

async function savePermissions() {
  const repo = repoState[activeRepo]
  if (!repo) return
  syncDraftFromDOM()
  try {
    const res = await fetch(`${repo.baseUrl}/api/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permDraft),
    })
    const data = await res.json()
    if (data.ok) {
      closePermissionsModal()
    } else {
      window.alert('Failed to save: ' + (data.error ?? 'Unknown error'))
    }
  } catch (err) {
    window.alert('Failed to save permissions: ' + err.message)
  }
}

async function openPermissionsModal() {
  await loadPermissions()
  renderPermissions()
  permissionsModal.style.display = ''
}

function closePermissionsModal() {
  permissionsModal.style.display = 'none'
}

btnPermissions.addEventListener('click', openPermissionsModal)
permissionsClose.addEventListener('click', closePermissionsModal)
permSave.addEventListener('click', savePermissions)

permAddAllow.addEventListener('click', () => {
  permAllowList.appendChild(renderPermRule(''))
  const inputs = permAllowList.querySelectorAll('.perm-rule-input')
  inputs[inputs.length - 1].focus()
})

permAddDeny.addEventListener('click', () => {
  permDenyList.appendChild(renderPermRule(''))
  const inputs = permDenyList.querySelectorAll('.perm-rule-input')
  inputs[inputs.length - 1].focus()
})

permissionsModal.addEventListener('click', (e) => {
  if (e.target === permissionsModal) closePermissionsModal()
})

// ── Keyboard shortcuts: Alt+1–9 ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && permissionsModal.style.display !== 'none') {
    closePermissionsModal()
    return
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const repo = repoState[activeRepo]
    if (!repo) return
    const idx = parseInt(e.key, 10) - 1
    const name = repo.agentOrder[idx]
    if (name && repo.agents[name]) {
      e.preventDefault()
      selectAgent(name)
    }
  }
})

init()
