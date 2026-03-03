import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'

const pages = [
  { to: '/docs/introduction',  title: 'Introduction',  desc: 'What Hive is and how it works.' },
  { to: '/docs/installation',  title: 'Installation',  desc: 'Add Hive to your monorepo in under a minute.' },
  { to: '/docs/configuration', title: 'Configuration', desc: 'Customize agents with hive.config.js.' },
  { to: '/docs/usage',         title: 'Using Hive',    desc: 'Keyboard shortcuts, model switching, and tips.' },
  { to: '/docs/api-reference', title: 'API Reference', desc: 'REST endpoints and WebSocket protocol.' },
]

export default function DocsIndexPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-white mb-2">Documentation</h1>
      <p className="text-neutral-400 mb-10">Everything you need to get Hive running in your monorepo.</p>

      <div className="grid gap-3">
        {pages.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            className="flex items-center justify-between p-4 rounded-lg border border-neutral-800 bg-neutral-900/30 hover:border-neutral-700 transition-colors group no-underline"
          >
            <div>
              <div className="font-medium text-white group-hover:text-brand transition-colors">{p.title}</div>
              <div className="text-sm text-neutral-500 mt-0.5">{p.desc}</div>
            </div>
            <ArrowRight size={16} className="text-neutral-600 group-hover:text-brand transition-colors flex-shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  )
}
