/**
 * 二进制获取的契约测试。
 *
 * 这段代码决定**哪个文件会被 spawn 执行**，所以测试重点不是"能下载"，
 * 而是三类会让用户装上坏东西的路径：
 *
 *  1. **校验和不匹配必须拒绝安装**（并且不能留下半截文件让人误以为装好了）。
 *  2. **拿不到校验和清单时必须失败**，而不是"下都下了就装吧" —— 那等于没有校验。
 *  3. **平台映射错误要报错**，不能回退到某个相近架构（会装上一个跑不起来的 exe）。
 *
 * 另外钉住一条产品约束：**已存在的二进制不会被覆盖**。用户可能是自己编译的
 * （甚至带本地补丁），插件去覆盖它是不可接受的。
 */

import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assetName,
  assetUrl,
  binaryFileName,
  buildMinimalConfig,
  checksumsUrl,
  currentTarget,
  ensureRuntimeDir,
  GatewayBinaryInstaller,
  parseChecksums,
  readConfigApiKey,
  sha256,
} from '../../src/gateway-binary.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb2a-binary-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言。
    }
  }
})

/** 构造一个只含一个 stored 条目的最小 zip（本用例只关心字节流，不测 deflate）。 */
function buildStoredZip(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const out = new Uint8Array(30 + nameBytes.length + payload.length + 46 + nameBytes.length + 22)
  const view = new DataView(out.buffer)
  let cursor = 0
  // local header
  view.setUint32(cursor, 0x04034b50, true); cursor += 4
  view.setUint16(cursor, 20, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2 // stored
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint32(cursor, 0, true); cursor += 4 // crc (本插件不校验)
  view.setUint32(cursor, payload.length, true); cursor += 4
  view.setUint32(cursor, payload.length, true); cursor += 4
  view.setUint16(cursor, nameBytes.length, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  out.set(nameBytes, cursor); cursor += nameBytes.length
  const localOffset = 0
  out.set(payload, cursor); cursor += payload.length
  const centralOffset = cursor
  // central directory
  view.setUint32(cursor, 0x02014b50, true); cursor += 4
  view.setUint16(cursor, 20, true); cursor += 2
  view.setUint16(cursor, 20, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2 // stored
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint32(cursor, 0, true); cursor += 4
  view.setUint32(cursor, payload.length, true); cursor += 4
  view.setUint32(cursor, payload.length, true); cursor += 4
  view.setUint16(cursor, nameBytes.length, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint32(cursor, 0, true); cursor += 4
  view.setUint32(cursor, localOffset, true); cursor += 4
  out.set(nameBytes, cursor); cursor += nameBytes.length
  // EOCD
  view.setUint32(cursor, 0x06054b50, true); cursor += 4
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 0, true); cursor += 2
  view.setUint16(cursor, 1, true); cursor += 2
  view.setUint16(cursor, 1, true); cursor += 2
  view.setUint32(cursor, cursor - centralOffset, true); cursor += 4
  view.setUint32(cursor, centralOffset, true); cursor += 4
  view.setUint16(cursor, 0, true)
  return out
}

/** 造一个可控的假发布源：真实字节 + 真实 sha256。 */
function fakeRelease(payload: Uint8Array, target: { os: string; arch: string }) {
  const asset = assetName(target)
  const zip = buildStoredZip(binaryFileName(target), payload)
  const checksums = new TextEncoder().encode(`${sha256(zip)}  ${asset}\n`)
  return { asset, zip, checksums }
}

/** 按 URL 末段分发的假 fetch。 */
function fakeFetch(routes: Record<string, Uint8Array>, status = 200): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    const key = Object.keys(routes).find(name => url.endsWith(name))
    if (key === undefined) {
      return new Response('not found', { status: 404 })
    }
    const body = routes[key]!
    return new Response(body, { status })
  }) as unknown as typeof fetch
}

describe('平台映射', () => {
  it('win32/x64 → windows/amd64，且可执行文件名带 .exe', () => {
    expect(currentTarget('win32', 'x64')).toEqual({ os: 'windows', arch: 'amd64' })
    expect(binaryFileName({ os: 'windows', arch: 'amd64' })).toBe('wb2a-server.exe')
  })

  it('darwin/arm64 → darwin/arm64，无扩展名', () => {
    expect(currentTarget('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' })
    expect(binaryFileName({ os: 'darwin', arch: 'arm64' })).toBe('wb2a-server')
  })

  it('linux/arm64 → linux/arm64', () => {
    expect(currentTarget('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' })
  })

  it('不支持的平台返回 undefined（由调用方给出自行编译的指引，不猜架构）', () => {
    expect(currentTarget('aix', 'x64')).toBeUndefined()
    expect(currentTarget('win32', 'ia32')).toBeUndefined()
  })

  it('产物 URL 走 latest/download，无需把版本号烧进包', () => {
    expect(assetUrl('owner/repo', { os: 'windows', arch: 'amd64' }))
      .toBe('https://github.com/owner/repo/releases/latest/download/wb2a-server-windows-amd64.zip')
    expect(checksumsUrl('owner/repo')).toBe('https://github.com/owner/repo/releases/latest/download/SHA256SUMS.txt')
  })

  it('binaryReleaseBase 覆盖时用于自建镜像（结尾斜杠被归一）', () => {
    expect(assetUrl('owner/repo', { os: 'linux', arch: 'amd64' }, 'https://mirror.example/wb2a/'))
      .toBe('https://mirror.example/wb2a/wb2a-server-linux-amd64.zip')
  })
})

describe('parseChecksums', () => {
  it('解析 sha256sum 格式（两空格 / 单空格 / 二进制模式 * 都能读）', () => {
    const table = parseChecksums([
      `${'a'.repeat(64)}  wb2a-server-windows-amd64.zip`,
      `${'b'.repeat(64)} *wb2a-server-darwin-arm64.zip`,
      `${'c'.repeat(64)} wb2a-server-linux-amd64.zip`,
      '',
      '# 注释行被忽略',
      'not-a-hash  file.txt',
    ].join('\n'))
    expect(table.get('wb2a-server-windows-amd64.zip')).toBe('a'.repeat(64))
    expect(table.get('wb2a-server-darwin-arm64.zip')).toBe('b'.repeat(64))
    expect(table.get('wb2a-server-linux-amd64.zip')).toBe('c'.repeat(64))
    expect(table.size).toBe(3)
  })

  it('大小写归一为小写（发布侧写大写也能匹配）', () => {
    const table = parseChecksums(`${'AB'.repeat(32)}  x.zip`)
    expect(table.get('x.zip')).toBe('ab'.repeat(32))
  })
})

describe('GatewayBinaryInstaller.ensure', () => {
  const target = { os: 'windows', arch: 'amd64' }
  const payload = new TextEncoder().encode('MZ fake gateway binary')

  it('下载 → 校验 → 解压 → 落盘，内容逐字节一致', async () => {
    const dir = tempDir()
    const release = fakeRelease(payload, target)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': release.checksums }),
    })

    const result = await installer.ensure()
    expect(result.downloaded).toBe(true)
    expect(result.path).toBe(join(dir, 'wb2a-server.exe'))
    expect(readFileSync(result.path)).toEqual(Buffer.from(payload))
    expect(result.bytes).toBe(payload.length)
    // 摘要要如实回报（用户可能会拿去和 Release 页对照）。
    expect(result.sha256).toBe(sha256(release.zip))
  })

  it('校验和不匹配 → 拒绝安装，且不留下任何文件', async () => {
    const dir = tempDir()
    const release = fakeRelease(payload, target)
    // 校验和清单指向另一个（正确的）摘要：模拟产物被中间人替换。
    const tampered = new TextEncoder().encode(`${'0'.repeat(64)}  ${release.asset}\n`)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': tampered }),
    })

    await expect(installer.ensure()).rejects.toThrow(/校验和不匹配/)
    expect(existsSync(join(dir, 'wb2a-server.exe'))).toBe(false)
    expect(existsSync(join(dir, 'wb2a-server.exe.part'))).toBe(false)
  })

  it('拿不到校验和清单 → 不下载、不安装，并给出自行编译的替代路径', async () => {
    const dir = tempDir()
    let downloadedAsset = false
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: (async (input: string | URL) => {
        if (String(input).endsWith('.zip')) downloadedAsset = true
        return new Response('nope', { status: 404 })
      }) as unknown as typeof fetch,
    })

    await expect(installer.ensure()).rejects.toThrow(/校验和清单/)
    await expect(installer.ensure()).rejects.toThrow(/自行编译/)
    expect(downloadedAsset).toBe(false)
    expect(existsSync(join(dir, 'wb2a-server.exe'))).toBe(false)
  })

  it('清单里没有本平台条目 → 视为拿不到校验和（不跳过校验）', async () => {
    const dir = tempDir()
    const other = new TextEncoder().encode(`${'a'.repeat(64)}  wb2a-server-linux-amd64.zip\n`)
    const release = fakeRelease(payload, target)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': other }),
    })
    await expect(installer.ensure()).rejects.toThrow(/没有 wb2a-server-windows-amd64\.zip 的记录/)
  })

  it('归档里没有可执行文件 → 报错并说明内容异常', async () => {
    const dir = tempDir()
    const zip = buildStoredZip('README.txt', new TextEncoder().encode('oops'))
    const checksums = new TextEncoder().encode(`${sha256(zip)}  wb2a-server-windows-amd64.zip\n`)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ 'wb2a-server-windows-amd64.zip': zip, 'SHA256SUMS.txt': checksums }),
    })
    await expect(installer.ensure()).rejects.toThrow(/内容异常/)
    expect(existsSync(join(dir, 'wb2a-server.exe'))).toBe(false)
  })

  it('已存在时跳过下载（不覆盖用户自己编译的产物）', async () => {
    const dir = tempDir()
    const existing = join(dir, 'wb2a-server.exe')
    writeFileSync(existing, 'user-built-binary')
    let touched = false
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: (async () => { touched = true; return new Response('x', { status: 200 }) }) as unknown as typeof fetch,
    })

    const result = await installer.ensure()
    expect(result.downloaded).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('user-built-binary')
    expect(touched).toBe(false)
  })

  it('force 时重新下载覆盖（显式要求才覆盖）', async () => {
    const dir = tempDir()
    const existing = join(dir, 'wb2a-server.exe')
    writeFileSync(existing, 'old-binary')
    const release = fakeRelease(payload, target)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      force: true,
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': release.checksums }),
    })
    const result = await installer.ensure()
    expect(result.downloaded).toBe(true)
    expect(readFileSync(existing)).toEqual(Buffer.from(payload))
  })

  it('安装目录不存在时自动创建', async () => {
    const dir = join(tempDir(), 'nested', 'bin')
    const release = fakeRelease(payload, target)
    const installer = new GatewayBinaryInstaller({
      installDir: dir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': release.checksums }),
    })
    await installer.ensure()
    expect(existsSync(join(dir, 'wb2a-server.exe'))).toBe(true)
  })

  it('默认目标取当前进程平台（本机为 windows/amd64）', () => {
    const installer = new GatewayBinaryInstaller({ logger: silentLogger })
    // CI 上可能不是 windows；只断言「不抛错且与 process 平台一致」。
    if (process.platform === 'win32' && process.arch === 'x64') {
      expect(installer.target()).toEqual({ os: 'windows', arch: 'amd64' })
    }
  })

  it('不支持的平台给出明确的自行编译指引', () => {
    const installer = new GatewayBinaryInstaller({ target: undefined, logger: silentLogger })
    // 直接构造一个不可能的目标平台：走的是 currentTarget 的 undefined 分支。
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
    try {
      expect(() => installer.target()).toThrow(/没有适配 aix/)
      expect(() => installer.target()).toThrow(/go build -o wb2a-server/)
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })
})

describe('ensureRuntimeDir / buildMinimalConfig', () => {
  it('生成监听 127.0.0.1 的配置（不是上游示例的 :7863 —— 那会暴露到局域网）', () => {
    const config = buildMinimalConfig(7863)
    expect(config.listen).toBe('127.0.0.1:7863')
    expect(config.auth_dir).toBe('./auths')
    expect(config.state_file).toBe('./data/state.json')
  })

  it('生成随机 api_key（绝不能为空：网关在 api_key 为空时完全不鉴权）', () => {
    const first = buildMinimalConfig(7863).api_key as string
    const second = buildMinimalConfig(7863).api_key as string
    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(first).not.toBe(second)
  })

  it('创建 config.json 与 auths/、data/ 三个必要物', () => {
    const dir = join(tempDir(), 'runtime')
    const result = ensureRuntimeDir(dir, 7863)
    expect(result.created).toBe(true)
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
    expect(existsSync(join(dir, 'auths'))).toBe(true)
    expect(existsSync(join(dir, 'data'))).toBe(true)
    expect(result.dirsCreated).toHaveLength(2)
    // auths/ 必须预先存在：网关只在启动时探测它，缺失就永久跳过热加载（实测）。
    expect(readConfigApiKey(dir)).toMatch(/^[0-9a-f]{48}$/)
  })

  it('已存在的 config.json 绝不被覆盖（可能含用户的池调参与 auth_dir）', () => {
    const dir = join(tempDir(), 'runtime')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), '{"listen":"127.0.0.1:9999","api_key":"user-key","auth_dir":"./my-auths"}')
    const result = ensureRuntimeDir(dir, 7863)
    expect(result.created).toBe(false)
    expect(readConfigApiKey(dir)).toBe('user-key')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toContain('my-auths')
  })

  it('重复调用幂等（第二次不再报告新建）', () => {
    const dir = join(tempDir(), 'runtime')
    ensureRuntimeDir(dir, 7863)
    const second = ensureRuntimeDir(dir, 7863)
    expect(second.created).toBe(false)
    expect(second.dirsCreated).toHaveLength(0)
  })

  it('readConfigApiKey 对缺失/坏文件返回 undefined 而不是抛错', () => {
    const dir = join(tempDir(), 'runtime')
    mkdirSync(dir, { recursive: true })
    expect(readConfigApiKey(dir)).toBeUndefined()
    writeFileSync(join(dir, 'config.json'), '{ not json')
    expect(readConfigApiKey(dir)).toBeUndefined()
  })
})

describe('GatewayBinaryInstaller：运行目录', () => {
  const target = { os: 'windows', arch: 'amd64' }
  const payload = new TextEncoder().encode('MZ fake')

  it('下载成功时同时准备好运行目录，并把路径回报出来', async () => {
    const installDir = join(tempDir(), 'bin')
    const runtimeDir = join(tempDir(), 'runtime')
    const release = fakeRelease(payload, target)
    const installer = new GatewayBinaryInstaller({
      installDir,
      runtimeDir,
      listenPort: 7863,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({ [release.asset]: release.zip, 'SHA256SUMS.txt': release.checksums }),
    })

    const result = await installer.ensure()
    expect(result.configCreated).toBe(true)
    expect(result.runtimeDir).toBe(runtimeDir)
    expect(existsSync(result.configPath)).toBe(true)
    expect(existsSync(join(runtimeDir, 'auths'))).toBe(true)
  })

  it('二进制已在位时也照样补齐运行目录（老版本插件留下的坑）', async () => {
    const installDir = join(tempDir(), 'bin')
    const runtimeDir = join(tempDir(), 'runtime')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'wb2a-server.exe'), 'existing')
    const installer = new GatewayBinaryInstaller({
      installDir,
      runtimeDir,
      target,
      repo: 'owner/repo',
      logger: silentLogger,
      fetchImpl: fakeFetch({}),
    })

    const result = await installer.ensure()
    expect(result.downloaded).toBe(false)
    expect(result.configCreated).toBe(true)
    expect(existsSync(join(runtimeDir, 'config.json'))).toBe(true)
  })

  it('prepareRuntime 可单独调用（只补目录，不碰二进制）', () => {
    const runtimeDir = join(tempDir(), 'runtime')
    const installer = new GatewayBinaryInstaller({ runtimeDir, target, logger: silentLogger })
    const result = installer.prepareRuntime()
    expect(result.created).toBe(true)
    expect(existsSync(join(runtimeDir, 'auths'))).toBe(true)
  })
})

describe('sha256', () => {
  it('与 node:crypto 的独立计算一致（空输入与已知向量）', () => {
    expect(sha256(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const data = new TextEncoder().encode('abc')
    expect(sha256(data)).toBe(createHash('sha256').update(data).digest('hex'))
  })
})
