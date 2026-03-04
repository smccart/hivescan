# hivescan

Web-based terminal dashboard for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents across your projects.

## Quick Start

```bash
npx hivescan
```

Or install globally:

```bash
npm install -g hivescan
hivescan
```

HiveScan will scan your current directory for projects, start a local dashboard, and open it in your browser.

## Requirements

- **Node.js 18+**
- **Claude Code** installed and available in your PATH
- macOS or Linux

## Usage

```bash
hivescan                          # Scan current directory for projects
hivescan --dir ~/Sites            # Scan a specific directory
hivescan --dir ~/work --dir ~/oss # Scan multiple directories
hivescan --port 5000              # Use a custom port (default: 4269)
hivescan --poll 10                # Port scan interval in seconds (default: 5)
hivescan --no-open                # Don't open browser automatically
```

## How It Works

1. Scans directory children for projects (`package.json` or `.git`)
2. Shows all discovered projects in a single dashboard UI
3. Start/stop Claude Code agents per project with one click
4. Streams live terminal output via WebSocket + xterm.js
5. Polls for active dev server ports and links them in the UI
6. Persists terminal history across restarts (`~/.hive/`)

## Features

- Real-time terminal streaming with xterm.js
- Model selection (Opus, Sonnet, Haiku)
- Status indicators (Thinking / Waiting / Idle / Stopped)
- Dark/light theme toggle
- Keyboard shortcuts (`Alt+1-9` to switch projects)
- Dev server preview panel
- Claude Code permission management
- Session persistence across restarts

## License

MIT
