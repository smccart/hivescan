import { Link, NavLink } from 'react-router'
import GitHubIcon from './GitHubIcon'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm transition-colors ${isActive ? 'text-white' : 'text-neutral-400 hover:text-white'}`

export default function SiteHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-neutral-800/60 bg-[#0a0a0a]/90 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between gap-8">
        <Link to="/" className="flex items-center gap-2.5 font-semibold text-white">
          <HiveIcon />
          HiveAgents
        </Link>

        <nav className="flex items-center gap-6">
          <NavLink to="/docs" className={linkClass}>Docs</NavLink>
          <a
            href="https://github.com/smccart/hive"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-white transition-colors"
            aria-label="GitHub"
          >
            <GitHubIcon size={18} />
          </a>
        </nav>
      </div>
    </header>
  )
}

function HiveIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>
  )
}
