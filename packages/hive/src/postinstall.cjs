const { chmodSync, existsSync, readdirSync } = require('fs')
const { join } = require('path')

const prebuildsDir = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuildsDir)) {
  for (const platform of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, platform, 'spawn-helper')
    if (existsSync(helper)) {
      chmodSync(helper, '755')
    }
  }
}
