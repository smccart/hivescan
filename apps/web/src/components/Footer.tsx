import { Link } from 'react-router'

export default function Footer() {
  return (
    <footer className="border-t border-neutral-800/60 py-8 mt-24">
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between text-sm text-neutral-500">
        <span>HiveAgents — MIT License</span>
        <div className="flex items-center gap-6">
          <Link to="/docs" className="hover:text-neutral-300 transition-colors">Docs</Link>
          <a href="https://github.com/smccart/hive" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-300 transition-colors">GitHub</a>
          <a href="https://www.npmjs.com/package/hive-agents" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-300 transition-colors">npm</a>
        </div>
      </div>
    </footer>
  )
}
