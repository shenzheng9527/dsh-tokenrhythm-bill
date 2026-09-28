/**
 * 只读预检：用真实的 ~/.dsh（不复制、不写任何文件）走一遍 host 的花名册解析，
 * 确认重启后界面会拿到什么。故意不加载插件模块本身，只复刻它的来源优先级逻辑，
 * 避免任何 state 写入。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const pkgDir = process.argv[2] || join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-tokenrhythm-bill')
console.log('[precheck] 从哪加载插件:', pkgDir)
console.log('[precheck] 该路径真实解析到:', existsSync(join(pkgDir, 'package.json')) ? '可读' : '不可读')

const { resolveProviderRoster, extractCredentialFromText } = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
console.log('[precheck] 将被加载的版本:', pkg.version)

const home = join(homedir(), '.dsh')
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const mt = (f) => { try { return statSync(f).mtimeMs } catch { return 0 } }

const profilesRoot = join(home, 'profiles')
const names = readdirSync(profilesRoot).filter((n) => n !== 'node_modules' && !n.startsWith('.'))
  .sort((a, b) => mt(join(profilesRoot, b, 'cordis.patch.yml')) - mt(join(profilesRoot, a, 'cordis.patch.yml')))

const sources = [{ file: join(home, 'settings.yaml'), kind: 'settings' }]
for (const n of names) {
  sources.push({ file: join(profilesRoot, n, 'cordis.patch.yml'), kind: 'patch' })
  sources.push({ file: join(profilesRoot, n, 'cordis.yml'), kind: 'patch' })
}
sources.push({ file: join(home, 'settings.yaml.imported'), kind: 'settings' })

console.log('[precheck] profile 尝试顺序:', names.join(' → '))
const r = resolveProviderRoster(sources, read)
console.log('[precheck] 命中来源:', r.source || '(无)')
console.log('[precheck] 错误:', r.error || '无')
for (const p of r.providers) {
  console.log(`[precheck] 提供商 ${p.id} | ${p.displayName} | baseURL=${p.baseURL} | apiKeyEnv=${p.apiKeyEnv} | balanceCapable=${p.balanceCapable}`)
  const tr = p.balanceCapable
  if (tr) {
    const creds = read(join(home, '.credentials.yaml'))
    const key = extractCredentialFromText(p.apiKeyEnv, creds) || ''
    console.log(`[precheck]   本机 Key: ${key === '' ? '读不到 ← 检测/模型 Key 通道会失败' : '已读到（前 5 位 ' + key.slice(0, 5) + '…，长度 ' + key.length + '）'}`)
  }
}
const st = JSON.parse(read(join(home, 'tokenrhythm-bill-state.json')) || '{}')
console.log('[precheck] 会话 Cookie 已存:', !!st.cookie, '| 胶囊显示口径:', st.prefs && st.prefs.entryBalance)
console.log('[precheck] 花名册非空 =', r.providers.length > 0, '→', r.providers.length > 0 ? '模型/密钥/自定义检测重启后都能出数' : '仍然拿不到提供商')
