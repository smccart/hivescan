import { NavLink, Outlet } from 'react-router'
import { MDXProvider } from '@/components/mdx/MDXProvider'

const NAV = [
  {
    title: 'Getting Started',
    links: [
      { to: '/docs/introduction',  label: 'Introduction' },
      { to: '/docs/installation',  label: 'Installation' },
      { to: '/docs/configuration', label: 'Configuration' },
    ],
  },
  {
    title: 'Usage',
    links: [
      { to: '/docs/usage',         label: 'Using Hive' },
      { to: '/docs/api-reference', label: 'API Reference' },
    ],
  },
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `block text-sm py-1 transition-colors ${
    isActive
      ? 'text-brand font-medium'
      : 'text-neutral-400 hover:text-neutral-100'
  }`

export default function DocsLayout() {
  return (
    <div className="max-w-6xl mx-auto px-6 pt-20 pb-12 flex gap-12">
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 sticky top-20 self-start">
        {NAV.map((section) => (
          <div key={section.title} className="mb-8">
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-3">
              {section.title}
            </p>
            <nav className="flex flex-col gap-0.5">
              {section.links.map((link) => (
                <NavLink key={link.to} to={link.to} className={linkClass} end>
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 max-w-2xl">
        <MDXProvider>
          <Outlet />
        </MDXProvider>
      </div>
    </div>
  )
}
