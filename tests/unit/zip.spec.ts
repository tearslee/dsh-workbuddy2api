/**
 * 内置 ZIP 读取的契约测试。
 *
 * 这段代码的风险点是**它解出来的字节会被当成可执行文件执行**，所以测试不能只测
 * 「能解出一个文件」，还要钉住三类边界：
 *
 *  1. **两种压缩方式都要走通**（stored / deflate）—— 发布产物由 `Compress-Archive`
 *     生成，默认是 deflate；一旦只支持其中一种，用户会拿到一个 0 字节或损坏的 exe。
 *  2. **损坏与不支持的形态必须报错，不能"尽力而为"** —— 一个静默解出半截内容的
 *     解析器，产出的是一个能通过存在性检查、却在 spawn 时报奇怪的错的文件。
 *  3. **顶层目录要能容忍**（`foo/wb2a-server.exe`），但同名歧义时必须拒绝。
 *
 * 测试用的归档在**测试进程内真实构造**（含正确的 CRC32 与中央目录），不依赖
 * 任何外部 zip 工具 —— 这样在 Windows / macOS / Linux 上语义完全一致。
 */

import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractFile, findEntry, listEntries, readEntry, ZipError } from '../../src/zip.js'

/** 标准 CRC32（表驱动）；归档里写正确值，避免测试固件本身不合规范。 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface EntrySpec {
  name: string
  data: Uint8Array
  /** 用 deflate 压缩（否则 stored）。 */
  deflate?: boolean
  /** 故意写坏的压缩方式，用于测「不支持」分支。 */
  forceMethod?: number
}

/** 构造一个真实合法的 ZIP 归档。 */
function buildZip(entries: EntrySpec[], options: { comment?: string } = {}): Uint8Array {
  const encoder = new TextEncoder()
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const spec of entries) {
    const nameBytes = encoder.encode(spec.name)
    const compressed = spec.deflate === true ? new Uint8Array(deflateRawSync(spec.data)) : spec.data
    const method = spec.forceMethod ?? (spec.deflate === true ? 8 : 0)
    const crc = crc32(spec.data)

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, compressed.length, true)
    localView.setUint32(22, spec.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, compressed.length, true)
    centralView.setUint32(24, spec.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localChunks.push(local, new Uint8Array(compressed))
    centralChunks.push(central)
    offset += local.length + compressed.length
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const commentBytes = encoder.encode(options.comment ?? '')
  const eocd = new Uint8Array(22 + commentBytes.length)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)
  eocdView.setUint16(20, commentBytes.length, true)
  eocd.set(commentBytes, 22)

  const all = [...localChunks, ...centralChunks, eocd]
  const total = all.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of all) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

const BINARY = new TextEncoder().encode('MZ\u0000fake-pe-binary-payload')

describe('listEntries / findEntry', () => {
  it('列出条目并保留压缩方式与尺寸', () => {
    const zip = buildZip([
      { name: 'wb2a-server.exe', data: BINARY, deflate: true },
      { name: 'SHA256SUMS.txt', data: new TextEncoder().encode('abc  wb2a-server.exe\n') },
    ])
    const entries = listEntries(zip)
    expect(entries.map(entry => entry.name)).toEqual(['wb2a-server.exe', 'SHA256SUMS.txt'])
    expect(entries[0]!.compressionMethod).toBe(8)
    expect(entries[0]!.uncompressedSize).toBe(BINARY.length)
    expect(entries[1]!.compressionMethod).toBe(0)
  })

  it('带归档注释时仍能定位中央目录（EOCD 不在文件末尾 22 字节处）', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY, deflate: true }], { comment: 'x'.repeat(500) })
    expect(findEntry(listEntries(zip), 'wb2a-server.exe')).toBeDefined()
  })

  it('归档里带顶层目录时按 basename 唯一命中', () => {
    const zip = buildZip([{ name: 'release/wb2a-server.exe', data: BINARY, deflate: true }])
    expect(findEntry(listEntries(zip), 'wb2a-server.exe')?.name).toBe('release/wb2a-server.exe')
  })

  it('同名多份时拒绝猜测（返回 undefined 而不是随便挑一个）', () => {
    const zip = buildZip([
      { name: 'a/wb2a-server.exe', data: BINARY },
      { name: 'b/wb2a-server.exe', data: BINARY },
    ])
    expect(findEntry(listEntries(zip), 'wb2a-server.exe')).toBeUndefined()
  })

  it('空归档合法（0 个条目）', () => {
    expect(listEntries(buildZip([]))).toEqual([])
  })
})

describe('readEntry / extractFile', () => {
  it('deflate 条目逐字节还原', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY, deflate: true }])
    expect(extractFile(zip, 'wb2a-server.exe')).toEqual(BINARY)
  })

  it('stored 条目逐字节还原', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY }])
    expect(extractFile(zip, 'wb2a-server.exe')).toEqual(BINARY)
  })

  it('大文件（>64KB，跨 deflate 块边界）内容完整', () => {
    // 可执行文件远大于一个 deflate 块；用带重复模式的伪随机内容确保真的被压缩。
    const big = new Uint8Array(300_000)
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31) % 251
    const zip = buildZip([{ name: 'wb2a-server.exe', data: big, deflate: true }])
    const out = extractFile(zip, 'wb2a-server.exe')
    expect(out.length).toBe(big.length)
    expect(out).toEqual(big)
  })

  it('取不存在的条目报错并列出实际内容', () => {
    const zip = buildZip([{ name: 'other.txt', data: BINARY }])
    expect(() => extractFile(zip, 'wb2a-server.exe')).toThrow(ZipError)
    expect(() => extractFile(zip, 'wb2a-server.exe')).toThrow(/other\.txt/)
  })

  it('不支持的压缩方式明确报错（不尝试"尽力解开"）', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY, forceMethod: 12 }])
    expect(() => extractFile(zip, 'wb2a-server.exe')).toThrow(/不支持的压缩方式 12/)
  })

  it('不是 zip 的输入报错而不是返回垃圾', () => {
    expect(() => listEntries(new TextEncoder().encode('this is definitely not a zip archive'))).toThrow(ZipError)
  })

  it('zip64 哨兵值被拒绝（本插件不处理 >4GB 归档）', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY }])
    // EOCD 的条目数字段（偏移 10）置成 0xffff 即 zip64 哨兵。
    const patched = Uint8Array.from(zip)
    const eocdOffset = patched.length - 22
    patched[eocdOffset + 10] = 0xff
    patched[eocdOffset + 11] = 0xff
    expect(() => listEntries(patched)).toThrow(/zip64/)
  })

  it('中央目录签名损坏时报错（不静默跳过条目）', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY }])
    const patched = Uint8Array.from(zip)
    const centralOffset = patched.length - 22 - (46 + 'wb2a-server.exe'.length)
    patched[centralOffset] = 0x00
    expect(() => listEntries(patched)).toThrow(/签名不匹配/)
  })

  it('解压后的数据与声明的尺寸不符时报错（半截 data 不进内存）', () => {
    const zip = buildZip([{ name: 'wb2a-server.exe', data: BINARY, deflate: true }])
    const entries = listEntries(zip)
    // 把压缩数据截断一半：inflate 必然失败。
    const truncated = zip.subarray(0, zip.length - 22 - (46 + 'wb2a-server.exe'.length) - Math.floor(BINARY.length / 2))
    expect(() => readEntry(truncated, entries[0]!)).toThrow(ZipError)
  })
})
