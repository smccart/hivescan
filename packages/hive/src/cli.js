#!/usr/bin/env node

import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'

// ── CLI flags ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { port: null, poll: null, dirs: [], noOpen: false }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--version' || arg === '-v') {
      printVersion()
      process.exit(0)
    }
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10)
      if (isNaN(args.port)) {
        console.error('  Error: --port requires a number\n')
        process.exit(1)
      }
    }
    if (arg === '--poll' && argv[i + 1]) {
      args.poll = parseInt(argv[++i], 10)
      if (isNaN(args.poll) || args.poll < 1) {
        console.error('  Error: --poll requires a positive number (seconds)\n')
        process.exit(1)
      }
    }
    if ((arg === '--dir' || arg === '-d') && argv[i + 1]) {
      args.dirs.push(resolve(argv[++i]))
    }
    if (arg === '--no-open') {
      args.noOpen = true
    }
  }
  return args
}

function printHelp() {
  const v = getVersion()
  console.log(`
  HiveScan v${v}
  Centralized dashboard for managing Claude Code agents across projects

  HiveScan automatically detects running dev servers on your system,
  identifies which project they belong to, and lets you manage
  Claude Code agents for each one from a single UI.

  Usage:
    hivescan                     Start HiveScan (scans current directory for projects)
    hivescan --dir ~/Sites       Scan a specific directory for projects
    hivescan --port 5000         Override the default UI port (4269)
    hivescan --poll 10           Set port scan interval in seconds (default: 5)

  Options:
    -d, --dir <path>             Directory to scan for projects (repeatable)
    -p, --port <number>          Server port (default: 4269)
        --poll <seconds>         Port scan interval (default: 5)
        --no-open                Don't open the browser automatically
    -v, --version                Show version
    -h, --help                   Show this help

  How it works:
    1. Scans directory children for projects (package.json or .git)
    2. Shows all discovered projects in the UI with one Claude agent each
    3. Polls for active TCP ports and annotates projects with live ports
    4. If a dir itself is a project, it's included directly

  Data is stored in ~/.hive/ (terminal history, project state).
`)
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.version
  } catch {
    return '0.0.0'
  }
}

function printVersion() {
  console.log(getVersion())
}

// ── Update check ─────────────────────────────────────────────────────────────

async function checkForUpdate() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const { name, version: current } = pkg
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: AbortSignal.timeout(3000),
    })
    const { version: latest } = await res.json()
    if (latest && latest !== current) {
      console.log(`  Update available: ${current} → ${latest}`)
      console.log(`  Run: npm update -g ${name}\n`)
    }
  } catch { /* silent — don't block startup */ }
}

// ── Port helpers ──────────────────────────────────────────────────────────────

function isPortFree(p) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(p, () => srv.close(() => resolve(true)))
  })
}

async function isHiveRunning(p) {
  try {
    const res = await fetch(`http://localhost:${p}/api/info`)
    return res.ok
  } catch {
    return false
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} ${url}`)
}

// ── Directory helpers ─────────────────────────────────────────────────────────

/** Walk up from dir to find the nearest .git root. */
function findRepoRoot(dir) {
  let current = dir
  while (current !== '/') {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

// ── Start ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv)

let port = args.port ?? 4269
const pollInterval = (args.poll ?? 5) * 1000

// Default scan dir: parent of the repo root (so sibling repos are included)
const defaultScanDir = dirname(findRepoRoot(process.cwd()) || process.cwd())
const scanDirs = args.dirs.length > 0 ? args.dirs : [defaultScanDir]
const dataDir = join(homedir(), '.hive')

// Ensure data directory exists
mkdirSync(dataDir, { recursive: true })

// Resolve port conflicts before starting the server
if (!(await isPortFree(port))) {
  if (await isHiveRunning(port)) {
    console.log(`\n  Hive is already running at http://localhost:${port}`)
    console.log(`  Opening in browser...\n`)
    openBrowser(`http://localhost:${port}`)
    process.exit(0)
  }

  // Port taken by something else — find next available
  const original = port
  while (!(await isPortFree(++port))) {
    if (port > original + 20) {
      console.error(`\n  Error: could not find a free port (tried ${original}–${port})\n`)
      process.exit(1)
    }
  }
  console.log(`  Port ${original} in use, using ${port}`)
}

console.log(`  Scanning: ${scanDirs.join(', ')}`)

try {
  const { startServer } = await import('./server.js')
  startServer({ port, pollInterval, scanDirs, dataDir, noOpen: args.noOpen })
  checkForUpdate()
} catch (err) {
  console.error(`\n  Error: ${err.message}\n`)
  process.exit(1)
}
