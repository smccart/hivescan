#!/usr/bin/env node

import { readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ── CLI flags ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { port: null, poll: null, dirs: [] }
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
  }
  return args
}

function printHelp() {
  const v = getVersion()
  console.log(`
  HiveAgents v${v}
  Centralized dashboard for managing Claude Code agents across projects

  Hive automatically detects running dev servers on your system,
  identifies which project they belong to, and lets you manage
  Claude Code agents for each one from a single UI.

  Usage:
    hive                     Start Hive (scans current directory for projects)
    hive --dir ~/Sites       Scan a specific directory for projects
    hive --port 5000         Override the default UI port (4269)
    hive --poll 10           Set port scan interval in seconds (default: 5)

  Options:
    -d, --dir <path>         Directory to scan for projects (repeatable)
    -p, --port <number>      Server port (default: 4269)
        --poll <seconds>     Port scan interval (default: 5)
    -v, --version            Show version
    -h, --help               Show this help

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

// ── Start ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv)

const port = args.port ?? 4269
const pollInterval = (args.poll ?? 5) * 1000
const scanDirs = args.dirs.length > 0 ? args.dirs : [process.cwd()]
const dataDir = join(homedir(), '.hive')

// Ensure data directory exists
mkdirSync(dataDir, { recursive: true })

try {
  const { startServer } = await import('./server.js')
  startServer({ port, pollInterval, scanDirs, dataDir })
} catch (err) {
  console.error(`\n  Error: ${err.message}\n`)
  process.exit(1)
}
