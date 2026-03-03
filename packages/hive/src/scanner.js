import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { EventEmitter } from 'node:events'

const execFileAsync = promisify(execFile)

// Processes that are never dev servers
const IGNORED_PROCESSES = new Set([
  'postgres', 'postgresql', 'mysql', 'mysqld', 'mariadbd',
  'redis-server', 'mongod', 'mongos',
  'docker-proxy', 'com.docker.backend', 'vpnkit',
  'ssh', 'sshd', 'cupsd', 'rapportd', 'ControlCenter',
  'AirPlayXPCHelper', 'WiFiAgent', 'SystemUIServer',
  'Dropbox', 'Slack', 'Discord', 'Spotify',
  'mDNSResponder', 'identityservicesd', 'sharingd',
])

// Directories that are never project roots
const IGNORED_CWDS = new Set(['/', '/usr', '/var', '/tmp', '/private', '/System'])

/**
 * Create a stable ID from an absolute path.
 */
export function pathToId(absolutePath) {
  return absolutePath
    .replace(/^\//, '')
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
}

/**
 * Check if a directory is a project (has package.json or .git).
 * Returns { root, name } or null.
 */
export function identifyProject(dir) {
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch { return null }

  if (existsSync(join(dir, 'package.json'))) {
    let name = basename(dir)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name) name = pkg.name.replace(/^@[^/]+\//, '') // strip scope
    } catch { /* use dirname */ }
    return { root: dir, name }
  }

  if (existsSync(join(dir, '.git'))) {
    return { root: dir, name: basename(dir) }
  }

  return null
}

/**
 * Walk up from a directory to find the nearest project root.
 */
export function findProjectRoot(dir) {
  let current = dir
  while (current !== '/') {
    const project = identifyProject(current)
    if (project) return project
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

const MONOREPO_DIRS = ['apps', 'packages', 'services', 'libs', 'modules']

/**
 * Scan a project for monorepo workspace children.
 * Returns array of child entries with `group` set to the parent name.
 */
function scanMonorepoChildren(parentRoot, parentName, parentId) {
  const children = []

  for (const sub of MONOREPO_DIRS) {
    const subDir = join(parentRoot, sub)
    if (!existsSync(subDir)) continue

    let entries
    try { entries = readdirSync(subDir).sort() } catch { continue }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const full = join(subDir, entry)
      const project = identifyProject(full)
      if (project) {
        children.push({
          id: pathToId(project.root),
          root: project.root,
          name: project.name,
          group: parentName,
          groupId: parentId,
          ports: [],
        })
      }
    }
  }

  return children
}

function addProjectWithChildren(projectMap, project) {
  const id = pathToId(project.root)
  const children = scanMonorepoChildren(project.root, project.name, id)

  if (children.length > 0) {
    // Parent entry (group header, also a launchable agent)
    if (!projectMap.has(project.root)) {
      projectMap.set(project.root, {
        id,
        root: project.root,
        name: project.name,
        group: null,
        groupId: null,
        ports: [],
      })
    }
    for (const child of children) {
      if (!projectMap.has(child.root)) {
        projectMap.set(child.root, child)
      }
    }
  } else {
    // Standalone project
    if (!projectMap.has(project.root)) {
      projectMap.set(project.root, {
        id,
        root: project.root,
        name: project.name,
        group: null,
        groupId: null,
        ports: [],
      })
    }
  }
}

/**
 * Scan directories for projects.
 * Monorepos get children with `group` pointing to their parent name.
 */
export function discoverProjectsFromDirs(dirs) {
  const projectMap = new Map()

  for (const dir of dirs) {
    if (!existsSync(dir)) continue

    const self = identifyProject(dir)
    if (self) addProjectWithChildren(projectMap, self)

    // Scan immediate children
    let entries
    try { entries = readdirSync(dir).sort() } catch { continue }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const full = join(dir, entry)
      const project = identifyProject(full)
      if (project && !projectMap.has(project.root)) {
        addProjectWithChildren(projectMap, project)
      }
    }
  }

  return Array.from(projectMap.values())
}

// ── Port scanning ──────────────────────────────────────────────────────────────

/**
 * Get all listening TCP ports with their PIDs and process names.
 */
export async function getListeningPorts() {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn',
    ], { timeout: 10000 })

    const entries = []
    let current = {}

    for (const line of stdout.split('\n')) {
      if (!line) continue
      const tag = line[0]
      const value = line.slice(1)

      if (tag === 'p') {
        if (current.pid) entries.push(current)
        current = { pid: parseInt(value, 10), name: '', ports: [] }
      } else if (tag === 'c') {
        current.name = value
      } else if (tag === 'n') {
        const match = value.match(/:(\d+)$/)
        if (match) {
          const port = parseInt(match[1], 10)
          if (!current.ports.includes(port)) current.ports.push(port)
        }
      }
    }
    if (current.pid) entries.push(current)

    const results = []
    for (const entry of entries) {
      for (const port of entry.ports) {
        results.push({ port, pid: entry.pid, name: entry.name })
      }
    }
    return results
  } catch {
    return []
  }
}

/**
 * Resolve the current working directory for a given PID.
 */
export async function getCwdForPid(pid) {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', [
        '-a', '-p', String(pid), '-d', 'cwd', '-F', 'n',
      ], { timeout: 5000 })
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n/')) return line.slice(1)
      }
    } else {
      const { stdout } = await execFileAsync('readlink', [
        `/proc/${pid}/cwd`,
      ], { timeout: 5000 })
      return stdout.trim()
    }
  } catch { /* pid may have exited */ }
  return null
}

/**
 * Scan ports and return a map of projectRoot -> [ports].
 */
export async function scanPortsForProjects(hivePort = 4269) {
  const ports = await getListeningPorts()

  const candidates = ports.filter(p => {
    if (p.port < 1024) return false
    if (p.port === hivePort) return false
    if (IGNORED_PROCESSES.has(p.name)) return false
    return true
  })

  // root path -> Set of ports
  const portMap = new Map()

  await Promise.all(candidates.map(async (entry) => {
    const cwd = await getCwdForPid(entry.pid)
    if (!cwd || IGNORED_CWDS.has(cwd)) return

    const project = findProjectRoot(cwd)
    if (!project) return

    if (!portMap.has(project.root)) portMap.set(project.root, new Set())
    portMap.get(project.root).add(entry.port)
  }))

  // Convert sets to arrays
  const result = new Map()
  for (const [root, portSet] of portMap) {
    result.set(root, Array.from(portSet))
  }
  return result
}

// ── Project watcher ────────────────────────────────────────────────────────────

/**
 * Watches for project and port changes.
 * Directory scanning provides stable project list.
 * Port scanning overlays live port info.
 *
 * Emits: 'projects:updated' with full project list on every scan cycle.
 */
export class ProjectWatcher extends EventEmitter {
  constructor({ scanDirs = [], hivePort = 4269 } = {}) {
    super()
    this.scanDirs = scanDirs
    this.hivePort = hivePort
    this.interval = null
    this.projects = new Map() // id -> project
  }

  /** Initial directory scan — returns discovered projects immediately. */
  discoverFromDirs() {
    const found = discoverProjectsFromDirs(this.scanDirs)
    for (const project of found) {
      if (!this.projects.has(project.id)) {
        this.projects.set(project.id, project)
      }
    }
    return Array.from(this.projects.values())
  }

  /** Scan ports and merge into known projects. */
  async scanPorts() {
    const portMap = await scanPortsForProjects(this.hivePort)

    let changed = false

    for (const [id, project] of this.projects) {
      const livePorts = portMap.get(project.root) ?? []
      const prev = project.ports

      const portsChanged =
        prev.length !== livePorts.length ||
        prev.some(p => !livePorts.includes(p))

      if (portsChanged) {
        project.ports = livePorts
        changed = true
      }
    }

    // Also check for port-only projects not found by dir scan
    for (const [root, ports] of portMap) {
      const id = pathToId(root)
      if (!this.projects.has(id)) {
        const project = findProjectRoot(root)
        if (project) {
          this.projects.set(id, {
            id,
            root: project.root,
            name: project.name,
            ports,
          })
          changed = true
        }
      }
    }

    if (changed) {
      this.emit('projects:updated', Array.from(this.projects.values()))
    }
  }

  start(intervalMs = 5000) {
    // Scan ports immediately, then poll
    this.scanPorts()
    this.interval = setInterval(() => this.scanPorts(), intervalMs)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}
