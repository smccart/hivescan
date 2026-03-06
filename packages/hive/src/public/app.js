const TERM_THEMES = {
  dark: {
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
  },
  light: {
    background:          '#f8f8fa',
    foreground:          '#18181b',
    cursor:              '#18181b',
    cursorAccent:        '#f8f8fa',
    selectionBackground: '#bfdbfe',
    black:    '#18181b', brightBlack:   '#3f3f46',
    red:      '#dc2626', brightRed:     '#ef4444',
    green:    '#16a34a', brightGreen:   '#22c55e',
    yellow:   '#ca8a04', brightYellow:  '#eab308',
    blue:     '#2563eb', brightBlue:    '#3b82f6',
    magenta:  '#9333ea', brightMagenta: '#a855f7',
    cyan:     '#0891b2', brightCyan:    '#06b6d4',
    white:    '#e4e4e7', brightWhite:   '#f4f4f5',
  },
}

function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark'
}

function getTermTheme() {
  return TERM_THEMES[getCurrentTheme()]
}

// ── State ────────────────────────────────────────────────────────────────────

const baseUrl = `${location.protocol}//${location.host}`
const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`

// { [projectId]: { id, name, root, ports, color, group, groupId, agents: { [sessionId]: agentState } } }
const projects = {}
let projectOrder = []   // ordered list of project IDs
let activeProject = null  // currently selected projectId
let activeSession = null  // currently selected sessionId (projectId:idx)

let currentModel = ''
let models = []

// All detected ports from scanner
let allDetectedPorts = []

// Preview panel state
let previewOpen = false
let previewPort = null
let splitWidth = null

// Sidebar section state (persisted)
let collapsedGroups = new Set(JSON.parse(localStorage.getItem('hive:collapsed') || '["__ports__"]'))
let hiddenProjects = new Set(JSON.parse(localStorage.getItem('hive:hidden') || '[]'))
function saveCollapsed() { localStorage.setItem('hive:collapsed', JSON.stringify([...collapsedGroups])) }
function saveHidden() { localStorage.setItem('hive:hidden', JSON.stringify([...hiddenProjects])) }

// ── Notifications ────────────────────────────────────────────────────────────

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

function maybeNotify(projectId, title, body) {
  if (document.hidden || projectId !== activeProject) {
    notify(title, body)
  }
}

// ── Tab title attention badge ────────────────────────────────────────────────

const ORIGINAL_TITLE = document.title

function updateTabAttention() {
  const waitingNames = []
  for (const id of projectOrder) {
    const p = projects[id]
    if (p && hasWaitingAgent(id)) waitingNames.push(p.name)
  }

  if (waitingNames.length > 0 && document.hidden) {
    document.title = waitingNames.length === 1
      ? `(!) ${waitingNames[0]} needs input — ${ORIGINAL_TITLE}`
      : `(${waitingNames.length}!) Projects need input — ${ORIGINAL_TITLE}`
  } else {
    document.title = ORIGINAL_TITLE
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = ORIGINAL_TITLE
})

// ── DOM refs ─────────────────────────────────────────────────────────────────

const tier1El        = document.getElementById('tier1-tabs')
const tier2El        = document.getElementById('tier2-tabs')
const tier3El        = document.getElementById('tier3-tabs')
const agentListEl    = document.getElementById('agent-list')
const termContainer  = document.getElementById('terminal-container')
const headerColorBar = document.getElementById('header-color-bar')
const headerDot      = document.getElementById('header-dot')
const headerName     = document.getElementById('header-name')
const headerStatus   = document.getElementById('header-status')
const headerPort     = document.getElementById('header-port')
const btnStart       = document.getElementById('btn-start')
const btnStop        = document.getElementById('btn-stop')
const btnStartAll    = document.getElementById('btn-start-all')
const btnStopAll     = document.getElementById('btn-stop-all')
const modelSelect    = document.getElementById('model-select')
const scanIndicator  = document.getElementById('scan-indicator')
const btnClear           = document.getElementById('btn-clear')
const btnRestart         = document.getElementById('btn-restart')
const btnHelp            = document.getElementById('btn-help')
const shortcutsModal     = document.getElementById('shortcuts-modal')
const shortcutsClose     = document.getElementById('shortcuts-close')
const contentSplit       = document.getElementById('content-split')
const splitHandle        = document.getElementById('split-handle')
const previewPanel       = document.getElementById('preview-panel')
const previewPortTabs    = document.getElementById('preview-port-tabs')
const previewReload      = document.getElementById('preview-reload')
const previewIframe      = document.getElementById('preview-iframe')
const previewEmpty       = document.getElementById('preview-empty')
const btnPreview         = document.getElementById('btn-preview')
const btnPermissions     = document.getElementById('btn-permissions')
const permissionsModal   = document.getElementById('permissions-modal')
const permissionsClose   = document.getElementById('permissions-close')
const permModeSelect     = document.getElementById('perm-mode')
const permAllowList      = document.getElementById('perm-allow-list')
const permDenyList       = document.getElementById('perm-deny-list')
const permAddAllow       = document.getElementById('perm-add-allow')
const permAddDeny        = document.getElementById('perm-add-deny')
const permSave           = document.getElementById('perm-save')

// ── Theme toggle ─────────────────────────────────────────────────────────────

const btnTheme = document.getElementById('btn-theme')
const themeIcon = document.getElementById('theme-icon')

const SUN_ICON = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
const MOON_ICON = '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>'

const LUCIDE_SVG_ATTRS = 'width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const EYE_ICON = `<svg ${LUCIDE_SVG_ATTRS}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`
const EYE_OFF_ICON = `<svg ${LUCIDE_SVG_ATTRS}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

function syncThemeIcon() {
  const theme = getCurrentTheme()
  themeIcon.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON
  btnTheme.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('hive-theme', theme)
  syncThemeIcon()
  updateAllTerminalThemes()
}

function toggleTheme() {
  applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark')
}

function updateAllTerminalThemes() {
  const termTheme = getTermTheme()
  for (const id of projectOrder) {
    const p = projects[id]
    if (!p) continue
    for (const agent of Object.values(p.agents || {})) {
      if (agent.terminal?.term) {
        agent.terminal.term.options.theme = termTheme
      }
    }
  }
}

btnTheme.addEventListener('click', toggleTheme)

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  if (!localStorage.getItem('hive-theme')) {
    applyTheme(e.matches ? 'light' : 'dark')
  }
})

syncThemeIcon()

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  requestNotificationPermission()
  loadPreviewState()

  // Load model info
  try {
    const data = await fetch(`${baseUrl}/api/model`).then(r => r.json())
    currentModel = data.model
    models = data.models
    syncModelSelector()
  } catch (err) {
    console.error('Failed to load model info:', err)
  }

  // Load initial projects
  try {
    const data = await fetch(`${baseUrl}/api/projects`).then(r => r.json())
    updateProjects(data.projects)
  } catch (err) {
    console.error('Failed to load projects:', err)
  }

  // Connect control WebSocket for live updates
  connectControl()

  // Select first project
  if (projectOrder.length > 0) {
    selectProject(projectOrder[0])
  }

  // Restore preview panel if it was open
  if (previewOpen) togglePreview(true)
}

// ── Control WebSocket ────────────────────────────────────────────────────────

let controlWs = null

function connectControl() {
  controlWs = new WebSocket(`${wsBase}/ws/control`)

  controlWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'projects:changed') {
        allDetectedPorts = msg.detectedPorts || []
        updateProjects(msg.projects)
      }
    } catch { /* ignore */ }
  })

  controlWs.addEventListener('close', () => {
    setTimeout(connectControl, 3000)
  })
}

// ── Project management ───────────────────────────────────────────────────────

function updateProjects(projectList) {
  const newIds = new Set(projectList.map(p => p.id))
  const flash = scanIndicator
  if (flash) {
    flash.classList.add('scanning')
    setTimeout(() => flash.classList.remove('scanning'), 800)
  }

  // Add or update projects
  for (const p of projectList) {
    const incomingAgents = p.agents || []

    if (projects[p.id]) {
      const existing = projects[p.id]
      existing.ports = p.ports
      existing.color = p.color

      // Sync agents
      const incomingSessionIds = new Set(incomingAgents.map(a => a.sessionId))

      // Update or add agents
      for (const a of incomingAgents) {
        if (existing.agents[a.sessionId]) {
          const ea = existing.agents[a.sessionId]
          const wasActive = ea.active
          ea.running = a.running
          ea.active = a.active
          ea.waiting = a.waiting

          // Notify on state transitions
          if (wasActive && !a.active && a.running) {
            if (a.waiting) {
              maybeNotify(p.id, `${p.name} needs input`, 'Waiting for your response')
            } else {
              maybeNotify(p.id, `${p.name} finished`, 'Claude is done responding')
            }
          }
        } else {
          existing.agents[a.sessionId] = {
            sessionId: a.sessionId,
            instanceIdx: a.instanceIdx,
            running: a.running,
            active: a.active,
            waiting: a.waiting,
            terminal: null,
          }
        }
      }

      // Remove gone agents
      for (const sid of Object.keys(existing.agents)) {
        if (!incomingSessionIds.has(sid)) {
          const agent = existing.agents[sid]
          if (agent.terminal) {
            agent.terminal.resizeObserver.disconnect()
            agent.terminal.ws.current?.close()
            agent.terminal.div.remove()
          }
          delete existing.agents[sid]
          if (activeSession === sid) {
            activeSession = null
          }
        }
      }

      updateSidebarItem(p.id)
      if (p.id === activeProject) {
        updateHeader()
        if (previewOpen) updatePreviewContent()
      }
    } else {
      // New project
      const agentsObj = {}
      for (const a of incomingAgents) {
        agentsObj[a.sessionId] = {
          sessionId: a.sessionId,
          instanceIdx: a.instanceIdx,
          running: a.running,
          active: a.active,
          waiting: a.waiting,
          terminal: null,
        }
      }
      projects[p.id] = {
        id: p.id,
        name: p.name,
        root: p.root,
        ports: p.ports,
        color: p.color,
        group: p.group,
        groupId: p.groupId,
        agents: agentsObj,
      }
      if (!projectOrder.includes(p.id)) projectOrder.push(p.id)
    }
  }

  // Remove gone projects
  for (const id of [...projectOrder]) {
    if (!newIds.has(id)) {
      const p = projects[id]
      if (p) {
        for (const agent of Object.values(p.agents || {})) {
          if (agent.terminal) {
            agent.terminal.resizeObserver.disconnect()
            agent.terminal.ws.current?.close()
            agent.terminal.div.remove()
          }
        }
      }
      delete projects[id]
      projectOrder = projectOrder.filter(x => x !== id)

      if (activeProject === id) {
        activeProject = null
        activeSession = null
        if (projectOrder.length > 0) selectProject(projectOrder[0])
        else {
          headerName.textContent = 'No projects detected'
          headerPort.style.display = 'none'
        }
      }
    }
  }

  renderSidebar()
  renderTabs()
  updateTabAttention()
}

// ── Agent helpers ──────────────────────────────────────────────────────────

function getProjectAgents(projectId) {
  const p = projects[projectId]
  if (!p) return []
  return Object.values(p.agents).sort((a, b) => a.instanceIdx - b.instanceIdx)
}

function hasRunningAgent(projectId) {
  const p = projects[projectId]
  if (!p) return false
  // Check this project's agents
  if (Object.values(p.agents).some(a => a.running)) return true
  // Check children (monorepo)
  for (const id of projectOrder) {
    if (projects[id]?.groupId === projectId) {
      if (Object.values(projects[id].agents).some(a => a.running)) return true
    }
  }
  return false
}

function hasWaitingAgent(projectId) {
  const p = projects[projectId]
  if (!p) return false
  return Object.values(p.agents).some(a => a.running && a.waiting)
}

function getActiveAgent() {
  if (!activeSession || !activeProject) return null
  return projects[activeProject]?.agents[activeSession] || null
}

// ── Model selector ───────────────────────────────────────────────────────────

function syncModelSelector() {
  modelSelect.innerHTML = ''
  for (const m of models) {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = m.label
    if (m.id === currentModel) opt.selected = true
    modelSelect.appendChild(opt)
  }
}

modelSelect.addEventListener('change', () => {
  currentModel = modelSelect.value
  fetch(`${baseUrl}/api/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelSelect.value }),
  })
})

// ── Tier tabs ───────────────────────────────────────────────────────────────

function renderTabs() {
  renderTier1Tabs()
  renderTier2Tabs()
  renderTier3Tabs()
}

function renderTier1Tabs() {
  tier1El.innerHTML = ''
  // Show top-level projects/monorepo roots with running agents
  for (const id of projectOrder) {
    const p = projects[id]
    if (!p || p.groupId) continue  // skip monorepo children
    if (!hasRunningAgent(id)) continue
    tier1El.appendChild(buildProjectTab(p))
  }
}

function renderTier2Tabs() {
  tier2El.innerHTML = ''
  if (!activeProject) return
  const p = projects[activeProject]
  if (!p) return

  // Find the top-level project for context
  const topId = p.groupId || p.id
  const top = projects[topId]
  if (!top) return

  const isMonorepo = projectOrder.some(id => projects[id]?.groupId === topId)

  if (isMonorepo) {
    // Show child packages
    for (const id of projectOrder) {
      const child = projects[id]
      if (!child || child.groupId !== topId) continue
      const tab = buildPackageTab(child)
      tier2El.appendChild(tab)
    }
  } else {
    // Standalone project: tier 2 is agent instances
    renderAgentInstanceTabs(tier2El, topId)
  }
}

function renderTier3Tabs() {
  tier3El.innerHTML = ''
  if (!activeProject) return
  const p = projects[activeProject]
  if (!p || !p.groupId) return  // only for monorepo children
  renderAgentInstanceTabs(tier3El, activeProject)
}

function renderAgentInstanceTabs(container, projectId) {
  const agentList = getProjectAgents(projectId)
  const p = projects[projectId]
  if (!p) return

  for (const agent of agentList) {
    container.appendChild(buildAgentTab(agent, p))
  }

  // "+" button to spawn new agent
  const addBtn = document.createElement('button')
  addBtn.className = 'agent-add-btn'
  addBtn.textContent = '+'
  addBtn.title = 'New agent instance'
  addBtn.addEventListener('click', () => spawnNewAgent(projectId))
  container.appendChild(addBtn)
}

function buildProjectTab(p) {
  const tab = document.createElement('button')
  tab.className = 'agent-tab'
  tab.dataset.id = p.id
  tab.style.setProperty('--tab-color', p.color)

  const topId = projects[activeProject]?.groupId || activeProject
  if (p.id === topId) tab.classList.add('active')
  if (hasRunningAgent(p.id)) tab.classList.add('running')
  if (hasWaitingAgent(p.id)) tab.classList.add('waiting')

  const dot = document.createElement('span')
  dot.className = 'agent-tab-dot'
  dot.style.background = p.color

  const name = document.createElement('span')
  name.className = 'agent-tab-name'
  name.textContent = p.name

  tab.append(dot, name)

  if (p.ports.length > 0) {
    const port = document.createElement('span')
    port.className = 'agent-tab-port'
    port.textContent = p.ports.map(pt => `:${pt}`).join(' ')
    tab.appendChild(port)
  }

  tab.addEventListener('click', () => selectTier1(p.id))
  return tab
}

function buildPackageTab(p) {
  const tab = document.createElement('button')
  tab.className = 'agent-tab'
  tab.dataset.id = p.id
  tab.style.setProperty('--tab-color', p.color)

  if (p.id === activeProject) tab.classList.add('active')

  const running = Object.values(p.agents).some(a => a.running)
  const waiting = Object.values(p.agents).some(a => a.running && a.waiting)
  const thinking = Object.values(p.agents).some(a => a.running && a.active)

  if (running) tab.classList.add('running')
  if (thinking) tab.classList.add('thinking')
  if (waiting && !thinking) tab.classList.add('waiting')
  if (!running) tab.classList.add('dimmed')

  const dot = document.createElement('span')
  dot.className = 'agent-tab-dot'
  dot.style.background = p.color

  const name = document.createElement('span')
  name.className = 'agent-tab-name'
  name.textContent = p.name

  tab.append(dot, name)

  if (p.ports.length > 0) {
    const port = document.createElement('span')
    port.className = 'agent-tab-port'
    port.textContent = p.ports.map(pt => `:${pt}`).join(' ')
    tab.appendChild(port)
  }

  tab.addEventListener('click', () => selectProject(p.id))
  return tab
}

function buildAgentTab(agent, p) {
  const tab = document.createElement('button')
  tab.className = 'agent-tab agent-instance-tab'
  tab.dataset.session = agent.sessionId
  tab.style.setProperty('--tab-color', p.color)

  if (agent.sessionId === activeSession) tab.classList.add('active')
  if (agent.running) tab.classList.add('running')
  if (agent.running && agent.active) tab.classList.add('thinking')
  if (agent.running && !agent.active && agent.waiting) tab.classList.add('waiting')

  const dot = document.createElement('span')
  dot.className = 'agent-tab-dot'
  dot.style.background = p.color

  const name = document.createElement('span')
  name.className = 'agent-tab-name'
  name.textContent = `Agent ${agent.instanceIdx + 1}`

  const badge = document.createElement('span')
  badge.className = 'agent-tab-badge'
  badge.textContent = '?'

  tab.append(dot, name, badge)

  // Close button
  const closeBtn = document.createElement('span')
  closeBtn.className = 'agent-tab-close'
  closeBtn.textContent = '\u00d7'
  closeBtn.title = 'Remove agent'
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (agent.running) {
      if (!window.confirm('This agent is running. Stop and remove it?')) return
    }
    removeAgentInstance(agent.sessionId)
  })
  tab.appendChild(closeBtn)

  tab.addEventListener('click', () => selectSession(agent.sessionId))
  return tab
}

function updateAllTabsActiveState() {
  for (const container of [tier1El, tier2El, tier3El]) {
    container.querySelectorAll('.agent-tab').forEach(tab => {
      if (tab.dataset.session) {
        tab.classList.toggle('active', tab.dataset.session === activeSession)
      } else {
        tab.classList.toggle('active', tab.dataset.id === activeProject)
      }
    })
  }
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar() {
  agentListEl.innerHTML = ''

  if (projectOrder.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-empty'
    empty.innerHTML = '<span>No projects found</span><span class="sidebar-empty-sub">Run hive from a directory with projects,<br>or use --dir to specify one</span>'
    agentListEl.appendChild(empty)
    return
  }

  // Group: standalone projects + group headers with children
  const standalone = []
  const groups = new Map() // groupId -> { parent, children }

  for (const id of projectOrder) {
    const p = projects[id]
    if (!p) continue
    if (p.group && p.groupId) {
      if (!groups.has(p.groupId)) {
        groups.set(p.groupId, { parent: projects[p.groupId] || null, children: [] })
      }
      groups.get(p.groupId).children.push(p)
    } else if (!groups.has(id)) {
      const hasChildren = projectOrder.some(oid => projects[oid]?.groupId === id)
      if (hasChildren) {
        if (!groups.has(id)) groups.set(id, { parent: p, children: [] })
      } else {
        standalone.push(p)
      }
    }
  }

  // Separate visible vs hidden
  const visibleGroups = []
  const hiddenGroupsList = []
  for (const [groupId, group] of groups) {
    if (group.parent && hiddenProjects.has(group.parent.id)) {
      hiddenGroupsList.push(group)
    } else {
      visibleGroups.push(group)
    }
  }
  const visibleStandalone = standalone.filter(p => !hiddenProjects.has(p.id))
  const hiddenStandalone = standalone.filter(p => hiddenProjects.has(p.id))

  // Render visible groups
  for (const { parent, children } of visibleGroups) {
    agentListEl.appendChild(buildGroupHeader(parent, children))
    if (parent && !collapsedGroups.has(parent.id)) {
      for (const child of children) {
        agentListEl.appendChild(buildProjectItem(child, true, false))
      }
    }
  }

  // Render visible standalone
  for (const p of visibleStandalone) {
    agentListEl.appendChild(buildProjectItem(p, false, false))
  }

  // Render hidden section
  if (hiddenGroupsList.length > 0 || hiddenStandalone.length > 0) {
    const label = document.createElement('div')
    label.className = 'hidden-section-label'
    label.textContent = 'Hidden'
    agentListEl.appendChild(label)

    for (const { parent, children } of hiddenGroupsList) {
      agentListEl.appendChild(buildGroupHeader(parent, children, true))
      if (parent && !collapsedGroups.has(parent.id)) {
        for (const child of children) {
          agentListEl.appendChild(buildProjectItem(child, true, true))
        }
      }
    }
    for (const p of hiddenStandalone) {
      agentListEl.appendChild(buildProjectItem(p, false, true))
    }
  }

  // Render running ports section (collapsed by default, at bottom)
  if (allDetectedPorts.length > 0) {
    const portsCollapsed = collapsedGroups.has('__ports__')

    const portsHeader = document.createElement('div')
    portsHeader.className = 'sidebar-section-label ports-section-header'
    if (portsCollapsed) portsHeader.classList.add('collapsed')

    const chevron = document.createElement('span')
    chevron.className = 'group-chevron'
    chevron.innerHTML = '&#x25BE;'

    const labelText = document.createElement('span')
    labelText.textContent = `Ports (${allDetectedPorts.length})`

    portsHeader.append(chevron, labelText)
    portsHeader.addEventListener('click', () => {
      if (collapsedGroups.has('__ports__')) {
        collapsedGroups.delete('__ports__')
      } else {
        collapsedGroups.add('__ports__')
      }
      saveCollapsed()
      renderSidebar()
    })
    agentListEl.appendChild(portsHeader)

    if (!portsCollapsed) {
      for (const { port, process: proc } of allDetectedPorts) {
        const item = document.createElement('div')
        item.className = 'port-item'
        item.addEventListener('click', () => {
          previewOpen = true
          previewPort = port
          updatePreviewContent()
        })

        const portNum = document.createElement('span')
        portNum.className = 'port-number'
        portNum.textContent = `:${port}`

        const procName = document.createElement('span')
        procName.className = 'port-process'
        procName.textContent = proc

        item.append(portNum, procName)
        agentListEl.appendChild(item)
      }
    }
  }
}

function buildGroupHeader(parent, children, isHidden) {
  const header = document.createElement('div')
  header.className = 'group-header' + (isHidden ? ' hidden-item' : '')
  if (parent) {
    const isCollapsed = collapsedGroups.has(parent.id)
    if (isCollapsed) header.classList.add('collapsed')
    header.dataset.id = parent.id
    header.style.setProperty('--agent-color', parent.color)

    const name = document.createElement('span')
    name.className = 'group-name'
    name.textContent = parent.name

    const eye = buildVisibilityToggle(parent.id)

    header.append(name, eye)
    header.addEventListener('click', () => {
      selectTier1(parent.id)
      if (collapsedGroups.has(parent.id)) {
        collapsedGroups.delete(parent.id)
      } else {
        collapsedGroups.add(parent.id)
      }
      saveCollapsed()
      renderSidebar()
    })
  }
  return header
}

function buildVisibilityToggle(id) {
  const eye = document.createElement('span')
  eye.className = 'visibility-toggle'
  const isHidden = hiddenProjects.has(id)
  eye.innerHTML = isHidden ? EYE_OFF_ICON : EYE_ICON
  eye.title = isHidden ? 'Show' : 'Hide'
  eye.addEventListener('click', (e) => {
    e.stopPropagation()
    if (hiddenProjects.has(id)) {
      hiddenProjects.delete(id)
    } else {
      hiddenProjects.add(id)
    }
    saveHidden()
    renderSidebar()
  })
  return eye
}

function buildProjectItem(p, isChild, isHidden) {
  const item = document.createElement('div')
  item.className = 'agent-item' + (p.id === activeProject ? ' active' : '') + (isChild ? ' child' : '') + (isHidden ? ' hidden-item' : '')
  item.dataset.id = p.id
  item.style.setProperty('--agent-color', p.color)

  const running = hasRunningAgent(p.id)
  const thinking = Object.values(p.agents).some(a => a.running && a.active)
  const waiting = Object.values(p.agents).some(a => a.running && !a.active && a.waiting)

  const dot = document.createElement('span')
  dot.className = 'agent-color-dot'
  if (running) dot.classList.add('running')
  if (thinking) dot.classList.add('thinking')
  if (waiting && !thinking) dot.classList.add('waiting')
  dot.style.background = p.color

  const info = document.createElement('span')
  info.className = 'agent-info'
  const label = document.createElement('span')
  label.className = 'agent-label'
  label.textContent = p.name
  const meta = document.createElement('span')
  meta.className = 'agent-meta'
  const agentCount = Object.keys(p.agents).length
  const metaParts = []
  if (p.ports.length > 0) metaParts.push(p.ports.map(port => `:${port}`).join(' '))
  if (agentCount > 1) metaParts.push(`${agentCount} agents`)
  meta.textContent = metaParts.join(' · ')
  info.append(label, meta)

  const status = document.createElement('span')
  status.className = 'agent-status' + (running ? ' running' : '')

  if (!isChild) {
    const eye = buildVisibilityToggle(p.id)
    item.append(dot, info, status, eye)
  } else {
    item.append(dot, info, status)
  }
  item.addEventListener('click', () => selectProject(p.id))
  return item
}

function updateSidebarItem(id) {
  const item = agentListEl.querySelector(`[data-id="${id}"]`)
  if (!item) return
  const p = projects[id]
  if (!p) return

  const running = hasRunningAgent(id)
  const thinking = Object.values(p.agents).some(a => a.running && a.active)
  const waiting = Object.values(p.agents).some(a => a.running && !a.active && a.waiting)

  const dot = item.querySelector('.agent-color-dot')
  const status = item.querySelector('.agent-status')

  if (dot) {
    dot.classList.toggle('running', running)
    dot.classList.toggle('thinking', thinking)
    dot.classList.toggle('waiting', waiting && !thinking)
  }
  if (status) status.classList.toggle('running', running)

  // Update terminal stopped state for active agent
  const agent = getActiveAgent()
  if (agent?.terminal) agent.terminal.div.classList.toggle('stopped', !agent.running)
}

// ── Selection ───────────────────────────────────────────────────────────────

function selectTier1(projectId) {
  const p = projects[projectId]
  if (!p) return
  const isMonorepo = projectOrder.some(id => projects[id]?.groupId === projectId)

  if (isMonorepo) {
    // Select first child package
    const firstChild = projectOrder.find(id => projects[id]?.groupId === projectId)
    if (firstChild) selectProject(firstChild)
    else selectProject(projectId)
  } else {
    selectProject(projectId)
  }
}

function selectProject(id) {
  const p = projects[id]
  if (!p) return

  // Deactivate previous terminal
  const prevAgent = getActiveAgent()
  if (prevAgent?.terminal) {
    prevAgent.terminal.div.classList.remove('active')
  }

  activeProject = id

  // Select first agent, or null
  const agentList = getProjectAgents(id)
  if (agentList.length > 0) {
    activeSession = agentList[0].sessionId
    selectSession(activeSession, true)
  } else {
    activeSession = null
  }

  // Update sidebar highlights
  agentListEl.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id)
  })

  renderTabs()
  updateHeader()
  updateHeaderButtons()
  updatePreviewContent()
}

function selectSession(sessionId, skipRender) {
  if (!sessionId) return
  const [projectId] = sessionId.split(':')
  const p = projects[projectId]
  if (!p) return
  const agent = p.agents[sessionId]
  if (!agent) return

  // Deactivate previous terminal
  const prevAgent = getActiveAgent()
  if (prevAgent?.terminal) {
    prevAgent.terminal.div.classList.remove('active')
  }

  activeProject = projectId
  activeSession = sessionId

  // Create terminal if needed
  if (!agent.terminal) createTerminal(sessionId)
  agent.terminal.div.classList.add('active')

  if (!skipRender) {
    updateAllTabsActiveState()
    updateHeader()
    updateHeaderButtons()
  }

  requestAnimationFrame(() => {
    if (!agent.terminal) return
    const atBottom = agent.terminal.term.buffer.active.viewportY >= agent.terminal.term.buffer.active.baseY
    agent.terminal.fitAddon.fit()
    if (atBottom) agent.terminal.term.scrollToBottom()
  })
}

async function spawnNewAgent(projectId) {
  try {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/agents`, { method: 'POST' })
    const data = await res.json()
    if (data.sessionId) {
      // The control WS will broadcast the update; select the new agent
      setTimeout(() => selectSession(data.sessionId), 200)
    }
  } catch (err) {
    console.error('Failed to spawn agent:', err)
  }
}

async function removeAgentInstance(sessionId) {
  try {
    await fetch(`${baseUrl}/api/agents/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  } catch (err) {
    console.error('Failed to remove agent:', err)
  }
}

function updateHeader() {
  const p = projects[activeProject]
  if (!p) return
  const agent = getActiveAgent()

  headerColorBar.style.background = p.color
  headerDot.style.background = p.color
  const running = agent?.running ?? false
  const active = agent?.active ?? false
  const waiting = agent?.waiting ?? false
  headerDot.classList.toggle('thinking', running && active)
  headerDot.classList.toggle('waiting', running && !active && waiting)

  const agentCount = Object.keys(p.agents).length
  const agentLabel = agentCount > 1 && agent ? ` — Agent ${agent.instanceIdx + 1}` : ''
  headerName.textContent = p.name + agentLabel
  document.documentElement.style.setProperty('--active-color', p.color)
  updateHeaderStatus(agent)

  if (p.ports.length > 0) {
    headerPort.textContent = p.ports.map(port => `:${port}`).join(' ')
    headerPort.href = `http://localhost:${p.ports[0]}`
    headerPort.classList.add('linkable')
    headerPort.style.display = ''
    headerPort.onclick = (e) => {
      e.preventDefault()
      previewPort = p.ports[0]
      if (!previewOpen) togglePreview(true)
      else updatePreviewContent()
    }
  } else {
    headerPort.style.display = 'none'
    headerPort.onclick = null
  }
}

function updateHeaderStatus(agent) {
  if (!agent) { headerStatus.textContent = ''; headerStatus.className = ''; return }
  if (agent.running && agent.active) {
    headerStatus.textContent = 'Thinking...'
    headerStatus.className = 'header-status thinking'
  } else if (agent.running && agent.waiting) {
    headerStatus.textContent = 'Waiting for input'
    headerStatus.className = 'header-status waiting'
  } else if (agent.running) {
    headerStatus.textContent = 'Idle'
    headerStatus.className = 'header-status idle'
  } else {
    headerStatus.textContent = 'Stopped'
    headerStatus.className = 'header-status stopped'
  }
}

// ── Terminal creation ────────────────────────────────────────────────────────

function createTerminal(sessionId) {
  const [projectId] = sessionId.split(':')
  const p = projects[projectId]
  if (!p) return
  const agent = p.agents[sessionId]
  if (!agent) return

  if (typeof Terminal === 'undefined') {
    console.error('xterm.js failed to load from CDN')
    return
  }

  const div = document.createElement('div')
  div.className = 'terminal-instance active'
  div.dataset.session = sessionId
  termContainer.appendChild(div)

  const term = new Terminal({
    theme: getTermTheme(),
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

  let searchAddon = null
  if (typeof SearchAddon !== 'undefined') {
    searchAddon = new SearchAddon.SearchAddon()
    term.loadAddon(searchAddon)
  }

  term.attachCustomKeyEventHandler((e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'k' || e.key === 'p')) return false
    return true
  })

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

  agent.terminal = { term, fitAddon, searchAddon, div, ws: wsRef, resizeObserver }
  if (!agent.running) div.classList.add('stopped')
  connectAgentWS(sessionId, term, wsRef)
}

// ── WebSocket (agent terminal) ───────────────────────────────────────────────

function connectAgentWS(sessionId, term, wsRef, skipBuffer = false) {
  const wsUrl = `${wsBase}/ws?session=${encodeURIComponent(sessionId)}&skipBuffer=${skipBuffer}`
  const ws = new WebSocket(wsUrl)
  wsRef.current = ws

  const [projectId] = sessionId.split(':')

  ws.addEventListener('message', (e) => {
    const p = projects[projectId]
    if (!p) return
    const agent = p.agents[sessionId]
    if (!agent) return
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'status') {
        const wasRunning = agent.running
        agent.running = msg.running
        updateSidebarItem(projectId)
        renderTabs()
        if (sessionId === activeSession) { updateHeaderButtons(); updateHeaderStatus(agent) }
        if (wasRunning && !msg.running) {
          maybeNotify(projectId, `${p.name} stopped`, 'Agent session ended')
        }
      } else if (msg.type === 'activity') {
        const wasActive = agent.active
        agent.active = msg.active
        agent.waiting = msg.waiting ?? false
        updateSidebarItem(projectId)
        updateTabAttention()
        renderTabs()
        if (sessionId === activeSession) {
          headerDot.classList.toggle('thinking', msg.active)
          headerDot.classList.toggle('waiting', !msg.active && (msg.waiting ?? false))
          updateHeaderStatus(agent)
        }
        if (wasActive && !msg.active && agent.running) {
          if (msg.waiting) {
            maybeNotify(projectId, `${p.name} needs input`, 'Waiting for your response')
          } else {
            maybeNotify(projectId, `${p.name} finished`, 'Claude is done responding')
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
      const p = projects[projectId]
      if (!p?.agents[sessionId]?.terminal) return
      connectAgentWS(sessionId, term, wsRef, true)
    }, 3000)
  })
}

// ── Header buttons ───────────────────────────────────────────────────────────

function updateHeaderButtons() {
  const agent = getActiveAgent()
  const running = agent?.running ?? false
  btnStart.style.opacity = running ? '0.4' : '1'
  btnStop.style.opacity  = running ? '1'   : '0.4'
}

async function agentAction(endpoint) {
  const agent = getActiveAgent()
  if (!agent) return
  try {
    const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.sessionId)}/${endpoint}`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      console.error(`${endpoint} failed:`, data.error ?? res.statusText)
    }
  } catch (err) {
    console.error(`${endpoint} failed:`, err.message)
  }
}

btnStart.addEventListener('click', () => {
  if (activeProject) {
    // Start or spawn agent instance 0 for the active project
    fetch(`${baseUrl}/api/projects/${activeProject}/start`, { method: 'POST' })
  }
})
btnStop.addEventListener('click', () => agentAction('stop'))

btnStartAll.addEventListener('click', async () => {
  for (const id of projectOrder) {
    try {
      await fetch(`${baseUrl}/api/projects/${id}/start`, { method: 'POST' })
    } catch { /* continue */ }
  }
})

btnStopAll.addEventListener('click', async () => {
  for (const id of projectOrder) {
    try {
      await fetch(`${baseUrl}/api/projects/${id}/stop`, { method: 'POST' })
    } catch { /* continue */ }
  }
})

// ── Clear terminal ───────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  const agent = getActiveAgent()
  if (!agent?.terminal) return
  agent.terminal.term.clear()
  if (agent.terminal.ws.current?.readyState === WebSocket.OPEN) {
    agent.terminal.ws.current.send(JSON.stringify({ type: 'clear' }))
  }
})

// ── Restart ──────────────────────────────────────────────────────────────────

btnRestart.addEventListener('click', async () => {
  const agent = getActiveAgent()
  if (!agent) return
  const origHTML = btnRestart.innerHTML
  btnRestart.disabled = true
  btnRestart.innerHTML = '<span style="font-size:11px">...</span>'

  if (agent.terminal) agent.terminal.term.clear()

  try {
    await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agent.sessionId)}/restart`, { method: 'POST' })
  } catch (err) {
    console.error('Restart failed:', err)
  } finally {
    btnRestart.disabled = false
    btnRestart.innerHTML = origHTML
  }
})

// ── Shortcuts modal ──────────────────────────────────────────────────────────

function openShortcutsModal() { shortcutsModal.style.display = '' }
function closeShortcutsModal() { shortcutsModal.style.display = 'none' }

btnHelp.addEventListener('click', openShortcutsModal)
shortcutsClose.addEventListener('click', closeShortcutsModal)
shortcutsModal.addEventListener('click', (e) => {
  if (e.target === shortcutsModal) closeShortcutsModal()
})

// ── Terminal search bar ──────────────────────────────────────────────────────

function openSearchBar() {
  const agent = getActiveAgent()
  if (!agent?.terminal?.searchAddon) return

  const t = agent.terminal
  if (t.div.querySelector('.search-bar')) {
    t.div.querySelector('.search-input').focus()
    return
  }

  const bar = document.createElement('div')
  bar.className = 'search-bar'
  bar.innerHTML = `
    <input type="text" class="search-input" placeholder="Search..." />
    <button class="search-btn search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="search-btn search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="search-btn search-close" title="Close (Esc)">&times;</button>
  `

  const input = bar.querySelector('.search-input')
  const prevBtn = bar.querySelector('.search-prev')
  const nextBtn = bar.querySelector('.search-next')
  const closeBtn = bar.querySelector('.search-close')

  function doSearch(direction) {
    const query = input.value
    if (!query) return
    if (direction === 'prev') t.searchAddon.findPrevious(query)
    else t.searchAddon.findNext(query)
  }

  input.addEventListener('input', () => doSearch('next'))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next') }
    if (e.key === 'Escape') { e.preventDefault(); closeSearchBar() }
  })

  prevBtn.addEventListener('click', () => doSearch('prev'))
  nextBtn.addEventListener('click', () => doSearch('next'))
  closeBtn.addEventListener('click', closeSearchBar)

  t.div.insertBefore(bar, t.div.firstChild)
  input.focus()
}

function closeSearchBar() {
  const agent = getActiveAgent()
  if (!agent?.terminal) return
  const bar = agent.terminal.div.querySelector('.search-bar')
  if (bar) {
    if (agent.terminal.searchAddon) agent.terminal.searchAddon.clearDecorations()
    bar.remove()
  }
  agent.terminal.term.focus()
}

// ── Permissions modal ────────────────────────────────────────────────────────

let permDraft = { defaultMode: 'default', permissions: { allow: [], deny: [] } }

async function loadPermissions() {
  const p = projects[activeProject]
  if (!p) return
  try {
    const res = await fetch(`${baseUrl}/api/projects/${p.id}/permissions`)
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
  for (const rule of permDraft.permissions.allow) permAllowList.appendChild(renderPermRule(rule))
  permDenyList.innerHTML = ''
  for (const rule of permDraft.permissions.deny) permDenyList.appendChild(renderPermRule(rule))
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
  const p = projects[activeProject]
  if (!p) return
  syncDraftFromDOM()
  try {
    const res = await fetch(`${baseUrl}/api/projects/${p.id}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permDraft),
    })
    const data = await res.json()
    if (data.ok) closePermissionsModal()
    else window.alert('Failed to save: ' + (data.error ?? 'Unknown error'))
  } catch (err) {
    window.alert('Failed to save permissions: ' + err.message)
  }
}

async function openPermissionsModal() {
  await loadPermissions()
  renderPermissions()
  permissionsModal.style.display = ''
}

function closePermissionsModal() { permissionsModal.style.display = 'none' }

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

// ── Preview panel ────────────────────────────────────────────────────────────

function loadPreviewState() {
  try {
    const raw = localStorage.getItem('hive:preview')
    if (!raw) return
    const state = JSON.parse(raw)
    previewOpen = !!state.open
    splitWidth = state.splitWidth ?? null
  } catch { /* ignore */ }
}

function savePreviewState() {
  try {
    localStorage.setItem('hive:preview', JSON.stringify({
      open: previewOpen,
      splitWidth,
    }))
  } catch { /* ignore */ }
}

function togglePreview(forceState) {
  previewOpen = forceState !== undefined ? forceState : !previewOpen
  btnPreview.classList.toggle('active', previewOpen)

  previewPanel.style.display = previewOpen ? '' : 'none'
  splitHandle.style.display = previewOpen ? '' : 'none'

  if (previewOpen && splitWidth) {
    previewPanel.style.width = splitWidth + 'px'
  } else if (previewOpen) {
    previewPanel.style.width = '45%'
  }

  savePreviewState()
  updatePreviewContent()

  requestAnimationFrame(() => {
    const agent = getActiveAgent()
    if (agent?.terminal) {
      agent.terminal.fitAddon.fit()
    }
  })
}

function updatePreviewContent() {
  if (!previewOpen) return

  const p = projects[activeProject]
  if (!p || p.ports.length === 0) {
    previewIframe.style.display = 'none'
    previewEmpty.style.display = ''
    previewPortTabs.innerHTML = ''
    previewPort = null
    return
  }

  if (!previewPort || !p.ports.includes(previewPort)) {
    previewPort = p.ports[0]
  }

  renderPortTabs(p.ports)

  previewEmpty.style.display = 'none'
  previewIframe.style.display = ''

  const targetUrl = `http://localhost:${previewPort}`
  if (previewIframe.src !== targetUrl) {
    previewIframe.src = targetUrl
  }
}

function renderPortTabs(ports) {
  previewPortTabs.innerHTML = ''
  for (const port of ports) {
    const tab = document.createElement('button')
    tab.className = 'preview-port-tab' + (port === previewPort ? ' active' : '')
    tab.textContent = `:${port}`
    tab.addEventListener('click', () => {
      previewPort = port
      updatePreviewContent()
    })
    previewPortTabs.appendChild(tab)
  }
}

function reloadPreview() {
  if (previewIframe.src) {
    previewIframe.src = previewIframe.src
  }
}

btnPreview.addEventListener('click', () => togglePreview())
previewReload.addEventListener('click', reloadPreview)

// ── Split handle drag ────────────────────────────────────────────────────────

;(function initSplitResize() {
  let startX = 0
  let startWidth = 0

  function onMouseDown(e) {
    e.preventDefault()
    startX = e.clientX
    startWidth = previewPanel.offsetWidth
    contentSplit.classList.add('resizing')
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e) {
    const delta = startX - e.clientX
    const newWidth = Math.max(200, Math.min(startWidth + delta, contentSplit.offsetWidth - 200))
    previewPanel.style.width = newWidth + 'px'
  }

  function onMouseUp() {
    contentSplit.classList.remove('resizing')
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    splitWidth = previewPanel.offsetWidth
    savePreviewState()

    requestAnimationFrame(() => {
      const agent = getActiveAgent()
      if (agent?.terminal) {
        agent.terminal.fitAddon.fit()
      }
    })
  }

  splitHandle.addEventListener('mousedown', onMouseDown)
})()

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (shortcutsModal.style.display !== 'none') { closeShortcutsModal(); return }
    if (permissionsModal.style.display !== 'none') { closePermissionsModal(); return }
    closeSearchBar()
    return
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault()
    togglePreview()
    return
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    btnClear.click()
    return
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    openSearchBar()
    return
  }

  if (e.key === 'T' && e.shiftKey && !e.target.closest('input, textarea, select, .xterm')) {
    toggleTheme()
    return
  }

  if (e.key === '?' && !e.target.closest('input, textarea, select, .xterm')) {
    openShortcutsModal()
    return
  }

  // Alt+1-9 switch top-level projects
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const idx = parseInt(e.key, 10) - 1
    if (idx >= 0) {
      // Get top-level projects with running agents (matching tier 1)
      const topLevel = projectOrder.filter(id => {
        const p = projects[id]
        return p && !p.groupId && hasRunningAgent(id)
      })
      const id = topLevel[idx]
      if (id) {
        e.preventDefault()
        selectTier1(id)
      }
    }
  }
})

init()
