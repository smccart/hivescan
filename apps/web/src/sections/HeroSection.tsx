import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import GitHubIcon from '../components/GitHubIcon'

export default function HeroSection() {
  return (
    <section className="pt-40 pb-24 px-6 text-center relative overflow-hidden">
      {/* Background glows */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full blur-3xl opacity-10 pointer-events-none"
        style={{ background: 'var(--color-brand)' }}
      />
      <div
        className="absolute top-20 right-[10%] w-75 h-62.5 rounded-full blur-3xl opacity-6 pointer-events-none"
        style={{ background: 'var(--color-purple)' }}
      />
      <div
        className="absolute top-32 left-[8%] w-62.5 h-50 rounded-full blur-3xl opacity-6 pointer-events-none"
        style={{ background: 'var(--color-blue)' }}
      />

      <div className="relative max-w-3xl mx-auto">
        <div className="inline-flex items-center gap-2 text-xs text-neutral-400 border border-neutral-800 rounded-full px-3 py-1.5 mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
          Open source · MIT License
        </div>

        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-white mb-6 leading-[1.1]">
          All your Claude agents.<br />
          <span style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-blue))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>One tab.</span>
        </h1>

        <p className="text-lg text-neutral-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Drop HiveAgents into any monorepo. Get a real-time web dashboard for managing multiple{' '}
          <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer" className="text-neutral-300 hover:text-white transition-colors">
            Claude Code
          </a>{' '}
          agents — terminals, status indicators, session persistence, model switching, and permissions management.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-lg px-4 py-3 font-mono text-sm text-neutral-300">
            <span className="text-neutral-600">$</span>
            npm install -D hive-agents
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/docs/introduction"
              className="inline-flex items-center gap-2 text-sm font-medium text-white hover:text-brand transition-colors"
            >
              Read the docs <ArrowRight size={14} />
            </Link>

            <a
              href="https://github.com/smccart/hive"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors"
            >
              <GitHubIcon size={14} />
              GitHub
            </a>
          </div>
        </div>
      </div>

      {/* Terminal preview */}
      <div className="relative max-w-4xl mx-auto mt-20">
        <div className="rounded-xl border border-neutral-800 overflow-hidden shadow-2xl">
          <div className="bg-neutral-900 border-b border-neutral-800 px-4 py-3 flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-neutral-700" />
            <span className="w-3 h-3 rounded-full bg-neutral-700" />
            <span className="w-3 h-3 rounded-full bg-neutral-700" />
            <span className="ml-3 text-xs text-neutral-500 font-mono">localhost:4199</span>
          </div>
          <TerminalMockup />
        </div>
      </div>
    </section>
  )
}

function TerminalMockup() {
  const agents = [
    { name: 'web',   color: '#4ade80', running: true,  active: true  },
    { name: 'api',   color: '#60a5fa', running: true,  active: false },
    { name: 'admin', color: '#c084fc', running: false, active: false },
    { name: 'worker',color: '#fb923c', running: true,  active: false },
  ]

  return (
    <div className="bg-[#0a0a0a] flex" style={{ minHeight: 280 }}>
      {/* Sidebar */}
      <div className="w-44 bg-[#111] border-r border-[#1e1e1e] flex flex-col py-2 flex-shrink-0">
        <div className="px-3 py-2.5 flex items-center gap-2 border-b border-[#1e1e1e] mb-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <span className="text-xs font-semibold text-neutral-300">HiveAgents</span>
        </div>
        <div className="flex-1">
          {agents.map((a, i) => (
            <div
              key={a.name}
              className={`flex items-center gap-2 px-3 py-2 text-xs ${i === 0 ? 'bg-[#1c1c1c] border-l-2' : ''}`}
              style={{ borderColor: i === 0 ? a.color : 'transparent' }}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: a.running ? a.color : '#3f3f46' }}
              />
              <span className={i === 0 ? 'text-white' : 'text-neutral-400'}>{a.name}</span>
              {a.active && (
                <span className="ml-auto text-[10px]" style={{ color: a.color }}>●</span>
              )}
            </div>
          ))}
        </div>
        {/* Sidebar footer */}
        <div className="px-3 pt-2 mt-auto border-t border-[#1e1e1e] flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 px-1 py-1 rounded" style={{ background: '#161616', border: '1px solid #1e1e1e' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
            Permissions
          </div>
        </div>
      </div>

      {/* Terminal area */}
      <div className="flex-1 p-4 font-mono text-xs text-neutral-400 overflow-hidden">
        <div className="text-[#4ade80] mb-1">✓ Task complete: added dark mode toggle</div>
        <div className="text-neutral-500 mb-1">Reading src/components/Header.tsx...</div>
        <div className="text-neutral-300 mb-1">
          {'> '}I'll add the toggle to the header. Let me check the theme config first.
        </div>
        <div className="text-neutral-500 mb-1">Reading src/theme/index.ts...</div>
        <div className="text-neutral-300 mb-1">
          {'> '}Found ThemeProvider. Adding a Sun/Moon button that toggles the dark class.
        </div>
        <div className="text-neutral-500 mb-1">Writing src/components/Header.tsx...</div>
        <div className="text-[#4ade80] mb-1">✓ Dark mode toggle added successfully</div>
        <div className="text-neutral-600 mb-4">
          Run <span className="text-neutral-400">npm run dev</span> to preview the changes.
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[#4ade80]">◆</span>
          <span className="text-white">claude</span>
          <span className="text-neutral-600">web ›</span>
          <span className="w-2 h-4 bg-neutral-300 animate-pulse ml-1 inline-block" />
        </div>
      </div>
    </div>
  )
}
