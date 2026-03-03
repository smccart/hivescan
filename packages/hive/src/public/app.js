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

// ── State ────────────────────────────────────────────────────────────────────

const baseUrl = `${location.protocol}//${location.host}`
const wsBase = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`

// { [projectId]: { id, name, root, ports, color, running, active, waiting, terminal } }
const projects = {}
let projectOrder = []   // ordered list of project IDs
let activeProject = null

let currentModel = ''
let models = []

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
    if (p?.waiting) waitingNames.push(p.name)
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
const scanIndicator  = document.getElementById('scan-indicator')
const btnClear           = document.getElementById('btn-clear')
const btnRestart         = document.getElementById('btn-restart')
const btnHelp            = document.getElementById('btn-help')
const shortcutsModal     = document.getElementById('shortcuts-modal')
const shortcutsClose     = document.getElementById('shortcuts-close')
const btnPermissions     = document.getElementById('btn-permissions')
const permissionsModal   = document.getElementById('permissions-modal')
const permissionsClose   = document.getElementById('permissions-close')
const permModeSelect     = document.getElementById('perm-mode')
const permAllowList      = document.getElementById('perm-allow-list')
const permDenyList       = document.getElementById('perm-deny-list')
const permAddAllow       = document.getElementById('perm-add-allow')
const permAddDeny        = document.getElementById('perm-add-deny')
const permSave           = document.getElementById('perm-save')

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  requestNotificationPermission()

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
}

// ── Control WebSocket ────────────────────────────────────────────────────────

let controlWs = null

function connectControl() {
  controlWs = new WebSocket(`${wsBase}/ws/control`)

  controlWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'projects:changed') {
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
    if (projects[p.id]) {
      // Update mutable fields
      const existing = projects[p.id]
      const wasActive = existing.active
      existing.ports = p.ports
      existing.running = p.running
      existing.active = p.active
      existing.waiting = p.waiting
      existing.color = p.color
      updateSidebarItem(p.id)
      if (p.id === activeProject) updateHeader()

      // Notify on state transitions
      if (wasActive && !p.active && existing.running) {
        if (p.waiting) {
          maybeNotify(p.id, `${p.name} needs input`, 'Waiting for your response')
        } else {
          maybeNotify(p.id, `${p.name} finished`, 'Claude is done responding')
        }
      }
    } else {
      // New project
      projects[p.id] = {
        ...p,
        terminal: null,
      }
      if (!projectOrder.includes(p.id)) projectOrder.push(p.id)
    }
  }

  // Remove gone projects
  for (const id of [...projectOrder]) {
    if (!newIds.has(id)) {
      const p = projects[id]
      if (p?.terminal) {
        p.terminal.resizeObserver.disconnect()
        p.terminal.ws.current?.close()
        p.terminal.div.remove()
      }
      delete projects[id]
      projectOrder = projectOrder.filter(x => x !== id)

      if (activeProject === id) {
        activeProject = null
        if (projectOrder.length > 0) selectProject(projectOrder[0])
        else {
          headerName.textContent = 'No projects detected'
          headerPort.style.display = 'none'
        }
      }
    }
  }

  renderSidebar()
  updateTabAttention()
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
      // Could be a group parent or standalone
      const hasChildren = projectOrder.some(oid => projects[oid]?.groupId === id)
      if (hasChildren) {
        if (!groups.has(id)) groups.set(id, { parent: p, children: [] })
      } else {
        standalone.push(p)
      }
    }
  }

  // Render groups first, then standalone
  for (const [, { parent, children }] of groups) {
    // Group header
    const header = document.createElement('div')
    header.className = 'group-header'
    if (parent) {
      header.dataset.id = parent.id
      header.style.setProperty('--agent-color', parent.color)

      const chevron = document.createElement('span')
      chevron.className = 'group-chevron'
      chevron.innerHTML = '&#x25BE;'

      const name = document.createElement('span')
      name.className = 'group-name'
      name.textContent = parent.name

      header.append(chevron, name)
      header.addEventListener('click', () => selectProject(parent.id))
    }
    agentListEl.appendChild(header)

    // Children
    for (const child of children) {
      agentListEl.appendChild(buildProjectItem(child, true))
    }
  }

  // Standalone projects
  for (const p of standalone) {
    agentListEl.appendChild(buildProjectItem(p, false))
  }
}

function buildProjectItem(p, isChild) {
  const item = document.createElement('div')
  item.className = 'agent-item' + (p.id === activeProject ? ' active' : '') + (isChild ? ' child' : '')
  item.dataset.id = p.id
  item.style.setProperty('--agent-color', p.color)

  const dot = document.createElement('span')
  dot.className = 'agent-color-dot'
  if (p.running) dot.classList.add('running')
  if (p.running && p.active) dot.classList.add('thinking')
  if (p.running && !p.active && p.waiting) dot.classList.add('waiting')
  dot.style.background = p.color

  const info = document.createElement('span')
  info.className = 'agent-info'
  const label = document.createElement('span')
  label.className = 'agent-label'
  label.textContent = p.name
  const meta = document.createElement('span')
  meta.className = 'agent-meta'
  meta.textContent = p.ports.length > 0 ? p.ports.map(port => `:${port}`).join(' ') : ''
  info.append(label, meta)

  const status = document.createElement('span')
  status.className = 'agent-status' + (p.running ? ' running' : '')

  item.append(dot, info, status)
  item.addEventListener('click', () => selectProject(p.id))
  return item
}

function updateSidebarItem(id) {
  const item = agentListEl.querySelector(`[data-id="${id}"]`)
  if (!item) return
  const p = projects[id]
  if (!p) return

  const dot = item.querySelector('.agent-color-dot')
  const status = item.querySelector('.agent-status')

  if (dot) {
    dot.classList.toggle('running', p.running)
    dot.classList.toggle('thinking', p.running && p.active)
    dot.classList.toggle('waiting', p.running && !p.active && p.waiting)
  }
  if (status) status.classList.toggle('running', p.running)

  if (p.terminal) p.terminal.div.classList.toggle('stopped', !p.running)
}

// ── Select project ───────────────────────────────────────────────────────────

function selectProject(id) {
  const p = projects[id]
  if (!p) return

  // Deactivate previous terminal
  if (activeProject && projects[activeProject]?.terminal) {
    projects[activeProject].terminal.div.classList.remove('active')
  }

  activeProject = id

  // Update sidebar highlights
  agentListEl.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id)
  })

  updateHeader()
  updateHeaderButtons()

  // Create terminal if needed
  if (!p.terminal) createTerminal(id)
  p.terminal.div.classList.add('active')

  requestAnimationFrame(() => {
    if (!p.terminal) return
    const atBottom = p.terminal.term.buffer.active.viewportY >= p.terminal.term.buffer.active.baseY
    p.terminal.fitAddon.fit()
    if (atBottom) p.terminal.term.scrollToBottom()
  })
}

function updateHeader() {
  const p = projects[activeProject]
  if (!p) return

  headerColorBar.style.background = p.color
  headerDot.style.background = p.color
  headerDot.classList.toggle('thinking', p.active)
  headerDot.classList.toggle('waiting', !p.active && p.waiting)
  headerName.textContent = p.name
  document.documentElement.style.setProperty('--active-color', p.color)

  if (p.ports.length > 0) {
    headerPort.textContent = p.ports.map(port => `:${port}`).join(' ')
    headerPort.href = `http://localhost:${p.ports[0]}`
    headerPort.classList.add('linkable')
    headerPort.style.display = ''
  } else {
    headerPort.style.display = 'none'
  }
}

// ── Terminal creation ────────────────────────────────────────────────────────

function createTerminal(id) {
  const p = projects[id]
  if (!p) return

  if (typeof Terminal === 'undefined') {
    console.error('xterm.js failed to load from CDN')
    return
  }

  const div = document.createElement('div')
  div.className = 'terminal-instance active'
  div.dataset.project = id
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

  let searchAddon = null
  if (typeof SearchAddon !== 'undefined') {
    searchAddon = new SearchAddon.SearchAddon()
    term.loadAddon(searchAddon)
  }

  term.attachCustomKeyEventHandler((e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'k')) return false
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

  p.terminal = { term, fitAddon, searchAddon, div, ws: wsRef, resizeObserver }
  if (!p.running) div.classList.add('stopped')
  connectProjectWS(id, term, wsRef)
}

// ── WebSocket (project terminal) ─────────────────────────────────────────────

function connectProjectWS(id, term, wsRef, skipBuffer = false) {
  const wsUrl = `${wsBase}/ws?project=${id}&skipBuffer=${skipBuffer}`
  const ws = new WebSocket(wsUrl)
  wsRef.current = ws

  ws.addEventListener('message', (e) => {
    const p = projects[id]
    if (!p) return
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'status') {
        const wasRunning = p.running
        p.running = msg.running
        updateSidebarItem(id)
        if (id === activeProject) updateHeaderButtons()
        if (wasRunning && !msg.running) {
          maybeNotify(id, `${p.name} stopped`, 'Agent session ended')
        }
      } else if (msg.type === 'activity') {
        const wasActive = p.active
        p.active = msg.active
        p.waiting = msg.waiting ?? false
        updateSidebarItem(id)
        updateTabAttention()
        if (id === activeProject) {
          headerDot.classList.toggle('thinking', msg.active)
          headerDot.classList.toggle('waiting', !msg.active && (msg.waiting ?? false))
        }
        if (wasActive && !msg.active && p.running) {
          if (msg.waiting) {
            maybeNotify(id, `${p.name} needs input`, 'Waiting for your response')
          } else {
            maybeNotify(id, `${p.name} finished`, 'Claude is done responding')
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
      if (!projects[id]?.terminal) return
      connectProjectWS(id, term, wsRef, true)
    }, 3000)
  })
}

// ── Header buttons ───────────────────────────────────────────────────────────

function updateHeaderButtons() {
  const p = projects[activeProject]
  if (!p) return
  btnStart.style.opacity = p.running ? '0.4' : '1'
  btnStop.style.opacity  = p.running ? '1'   : '0.4'
}

async function projectAction(endpoint) {
  const p = projects[activeProject]
  if (!p) return
  try {
    const res = await fetch(`${baseUrl}/api/projects/${p.id}/${endpoint}`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      console.error(`${endpoint} failed:`, data.error ?? res.statusText)
    }
  } catch (err) {
    console.error(`${endpoint} failed:`, err.message)
  }
}

btnStart.addEventListener('click', () => projectAction('start'))
btnStop.addEventListener('click', () => projectAction('stop'))

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
  const p = projects[activeProject]
  if (!p?.terminal) return
  p.terminal.term.clear()
  if (p.terminal.ws.current?.readyState === WebSocket.OPEN) {
    p.terminal.ws.current.send(JSON.stringify({ type: 'clear' }))
  }
})

// ── Restart ──────────────────────────────────────────────────────────────────

btnRestart.addEventListener('click', async () => {
  const p = projects[activeProject]
  if (!p) return
  const origHTML = btnRestart.innerHTML
  btnRestart.disabled = true
  btnRestart.innerHTML = '<span style="font-size:11px">...</span>'

  if (p.terminal) p.terminal.term.clear()

  try {
    await fetch(`${baseUrl}/api/projects/${p.id}/restart`, { method: 'POST' })
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
  const p = projects[activeProject]
  if (!p?.terminal?.searchAddon) return

  const t = p.terminal
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
  const p = projects[activeProject]
  if (!p?.terminal) return
  const bar = p.terminal.div.querySelector('.search-bar')
  if (bar) {
    if (p.terminal.searchAddon) p.terminal.searchAddon.clearDecorations()
    bar.remove()
  }
  p.terminal.term.focus()
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

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (shortcutsModal.style.display !== 'none') { closeShortcutsModal(); return }
    if (permissionsModal.style.display !== 'none') { closePermissionsModal(); return }
    closeSearchBar()
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

  if (e.key === '?' && !e.target.closest('input, textarea, select, .xterm')) {
    openShortcutsModal()
    return
  }

  // Alt+1-9 switch projects
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const idx = parseInt(e.key, 10) - 1
    const id = projectOrder[idx]
    if (id && projects[id]) {
      e.preventDefault()
      selectProject(id)
    }
  }
})

init()
