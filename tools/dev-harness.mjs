/**
 * 本地验证 harness：不重启正在运行的 DSH，就把 host 半边挂到一个临时端口上跑真接口。
 *
 *   node tools/dev-harness.mjs [--port 19487] [--home <DSH_HOME>]
 *
 * --home 默认复制一份真实的 ~/.dsh（含 .credentials.yaml 与 state 里的会话 Cookie）到
 * 临时目录，这样插件读的是真配置、发的是真请求，但它写 state 只会写到临时副本，
 * 不会污染正在运行的那份安装。
 *
 * 只跑只读接口（manifest / models / balance / usage / keys）。
 * 故意不碰 /model-check——那是真花钱的 1-token 计费，要试请在界面里自己点。
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(HERE, '..')

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const port = Number(arg('port', 19487))

// ---- 1) 造一个隔离的 DSH_HOME（复制真实配置，插件写不脏本机）----
const realHome = join(homedir(), '.dsh')
const home = arg('home', join(tmpdir(), 'dsh-tokenrhythm-harness-' + Date.now().toString(36)))
mkdirSync(home, { recursive: true })
const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const a = join(from, name)
    const b = join(to, name)
    if (statSync(a).isDirectory()) {
      if (name === 'node_modules' || name === 'sessions' || name === 'attachments' || name === 'cache') continue
      copyTree(a, b)
    } else if (name === 'settings.yaml' || name === 'settings.yaml.imported' || name === '.credentials.yaml'
      || name === 'tokenrhythm-bill-state.json' || name === 'cordis.patch.yml' || name === 'cordis.yml'
      || name === 'package.json') {
      copyFileSync(a, b)
    }
  }
}
copyTree(realHome, home)
console.log('[harness] 隔离 DSH_HOME =', home)

// 复制出来的临时目录里有真凭据（API Key / 会话 Cookie / 账号密码），退出时删掉，
// 不把秘密留在临时目录里。
const cleanup = () => {
  try { rmSync(home, { recursive: true, force: true }); console.log('[harness] 已清理临时 DSH_HOME') }
  catch (e) { console.log('[harness] 临时目录清理失败，请手动删除 ' + home + '：' + e.message) }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

process.env.DSH_HOME = home

// ---- 2) 用假 ctx 挂 host 插件，截获它注册的 handler ----
let handler = null
const ctx = {
  effect: (fn) => { try { fn() } catch (e) { console.log('[harness] effect 失败:', e.message) } },
  webServer: { register: (r) => { handler = r.handler } },
}
const mod = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)
mod.apply(ctx)
if (handler === null) { console.error('[harness] 插件没注册任何路由'); process.exit(1) }

const server = createServer(async (req, res) => {
  try { await handler(req, res) } catch (e) { res.writeHead(500); res.end(String(e && e.message)) }
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))
console.log('[harness] 已挂载 http://127.0.0.1:' + port + '/dsh-tokenrhythm-bill\n')

// ---- 3) 只读接口逐个过一遍 ----
const get = async (path) => {
  const res = await fetch('http://127.0.0.1:' + port + '/dsh-tokenrhythm-bill' + path)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
const brief = (o, n) => JSON.stringify(o, null, 1).slice(0, n)

const m = await get('/manifest')
console.log('== GET /manifest ->', m.status)
console.log(brief(m.body, 1200))

const pid = m.body && m.body.providers && m.body.providers[0] ? m.body.providers[0].id : null
if (pid) {
  const mo = await get('/models?provider=' + encodeURIComponent(pid))
  const list = mo.body && mo.body.models ? mo.body.models : []
  console.log('\n== GET /models?provider=' + pid + ' ->', mo.status, '| 模型数 =', list.length, '| 来源 =', mo.body && mo.body.source)
  console.log('   前 5 个:', list.slice(0, 5).map((x) => x.id).join(', '))
  const withPrice = list.filter((x) => x.inPrice !== null && x.inPrice !== undefined).length
  console.log('   带单价的:', withPrice, '| 分类计数:', JSON.stringify(mo.body && mo.body.categories))

  const k = await get('/key?provider=' + encodeURIComponent(pid))
  console.log('\n== GET /key ->', k.status, '| 拿到本机 API Key:', k.body && k.body.ok === true ? '是（长度 ' + String(k.body.key || '').length + '）' : '否 ' + (k.body && k.body.error))
}

const b = await get('/balance')
console.log('\n== GET /balance ->', b.status)
console.log(brief(b.body && b.body.balance ? { balance: b.body.balance, expiringCount: (b.body.expiringItems || []).length } : b.body, 900))

const u = await get('/usage')
console.log('\n== GET /usage ->', u.status, u.body && u.body.ok ? '有用量数据' : JSON.stringify(u.body).slice(0, 200))

const ks = await get('/keys')
console.log('\n== GET /keys ->', ks.status, ks.body && ks.body.keys ? '平台密钥 ' + ks.body.keys.length + ' 把' : JSON.stringify(ks.body).slice(0, 200))

console.log('\n[harness] 验证完毕。Ctrl-C 退出。保持运行可按提示逐个请求。')
if (!process.argv.includes('--keep-alive')) {
  server.close()
  process.exit(0)
}
