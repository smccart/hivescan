import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import GitHubIcon from '../components/GitHubIcon'

export default function CTASection() {
  return (
    <section className="py-24 px-6 border-t border-neutral-800/60">
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="text-3xl font-bold text-white mb-4">
          Ready to wrangle your agents?
        </h2>
        <p className="text-neutral-400 mb-10">
          Open source, MIT licensed. Contributions welcome.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            to="/docs/installation"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-black transition-opacity hover:opacity-90"
            style={{ background: 'var(--color-brand)' }}
          >
            Get started <ArrowRight size={14} />
          </Link>

          <a
            href="https://github.com/smccart/hive"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-neutral-300 bg-neutral-900 border border-neutral-800 hover:border-neutral-700 transition-colors"
          >
            <GitHubIcon size={14} />
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  )
}
