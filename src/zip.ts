/**
 * 极简 ZIP 读取：只做「从归档里取出一个文件」。
 *
 * ## 为什么要自己解析，而不是拉 `unzip` / `tar` / `yauzl`
 *
 * 本插件的目标是「别人能直接装上用」。为解压一个文件而引入运行时依赖（或要求
 * 系统里有 `unzip`/`tar`）都会把「开箱即用」变成「先装环境」——Windows 上尤其明显。
 * 这里只实现**读取**所需的两个结构（中央目录 + 本地头），约 100 行、零依赖，
 * 且完全可测（不需要真实网络或真实 zip 工具）。
 *
 * 支持：`stored`(0) 与 `deflate`(8) 两种压缩方式 —— 即 `Compress-Archive`、
 * `zip`、`7z`、`gh release upload` 等常见工具产出的默认形态。
 * 不支持（会**明确报错**而不是猜）：zip64（>4GB 或 >65535 条目）、加密条目、
 * 其他压缩算法。发布产物是我们自己生成的，不需要这些。
 *
 * 安全约束：解压前按**声明的**未压缩尺寸做上限校验，避免恶意归档解出一个
 * 撑爆内存的文件（zip bomb）。这里不做 CRC 校验 —— 完整性由发布侧的
 * SHA256SUMS 负责（见 gateway-binary.ts），CRC 只是传输噪声检测，冗余。
 *
 * @module dsh-workbuddy2api/zip
 */

import { inflateRawSync } from 'node:zlib'

/** 中央目录结尾记录（EOCD）签名 `PK\x05\x06`。 */
const EOCD_SIGNATURE = 0x06054b50
/** 中央目录条目签名 `PK\x01\x02`。 */
const CENTRAL_SIGNATURE = 0x02014b50
/** 本地文件头签名 `PK\x03\x04`。 */
const LOCAL_SIGNATURE = 0x04034b50
/** EOCD 固定长度（22 字节）+ 最大注释长度（65535）→ 从尾部回溯的上限。 */
const EOCD_SEARCH_LIMIT = 22 + 0xffff
/** 单个条目解压后的体积上限（512 MiB）：防 zip bomb，远大于网关二进制的量级。 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

/** 条目的压缩方式。 */
export const STORED = 0
export const DEFLATED = 8

/** 归档解析失败（格式不受支持 / 损坏 / 触达安全上限）。 */
export class ZipError extends Error {
  constructor(message: string) {
    super(`ZIP 解析失败：${message}`)
    this.name = 'ZipError'
  }
}

/** 中央目录里的一个条目（只保留取数据需要的字段）。 */
export interface ZipEntry {
  /** 归档内的路径（正斜杠分隔）。 */
  name: string
  /** 压缩方式：{@link STORED} 或 {@link DEFLATED}。 */
  compressionMethod: number
  /** 压缩后字节数。 */
  compressedSize: number
  /** 解压后字节数（用于上限校验）。 */
  uncompressedSize: number
  /** 本地文件头在归档中的偏移。 */
  localHeaderOffset: number
}

/** 小端读 16 位。 */
function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

/** 小端读 32 位（无符号）。 */
function readUint32(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
    | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) * 0x1000000)) >>> 0
}

/**
 * 从尾部回溯定位 EOCD。
 *
 * 不能假设「EOCD 就在最后 22 字节」：归档允许带任意长度的注释，
 * 因此必须按签名回溯查找（这是所有 zip 实现的标准做法）。
 */
function findEndOfCentralDirectory(data: Uint8Array): number {
  const floor = Math.max(0, data.length - EOCD_SEARCH_LIMIT)
  for (let offset = data.length - 22; offset >= floor; offset -= 1) {
    if (readUint32(data, offset) === EOCD_SIGNATURE) return offset
  }
  throw new ZipError('未找到中央目录结尾记录（不是 zip 文件，或文件被截断）')
}

/**
 * 解析中央目录，列出全部条目。
 *
 * @param data - 完整归档字节。
 * @returns 条目列表（顺序与归档一致）。
 * @throws {ZipError} 格式不受支持（zip64 / 多盘）或结构损坏时。
 */
export function listEntries(data: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data)
  const entryCount = readUint16(data, eocd + 10)
  const directorySize = readUint32(data, eocd + 12)
  const directoryOffset = readUint32(data, eocd + 16)

  // 三个哨兵值同时出现即 zip64；本插件只处理自己发布的小归档，明确拒绝而不是猜。
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError('归档使用 zip64 扩展（>4GB 或 >65535 条目），本插件不支持')
  }

  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length) throw new ZipError('中央目录条目越界（文件损坏）')
    if (readUint32(data, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`第 ${index + 1} 个中央目录条目签名不匹配（文件损坏）`)
    }
    const compressionMethod = readUint16(data, cursor + 10)
    const compressedSize = readUint32(data, cursor + 20)
    const uncompressedSize = readUint32(data, cursor + 24)
    const nameLength = readUint16(data, cursor + 28)
    const extraLength = readUint16(data, cursor + 30)
    const commentLength = readUint16(data, cursor + 32)
    const localHeaderOffset = readUint32(data, cursor + 42)
    const nameStart = cursor + 46
    if (nameStart + nameLength > data.length) throw new ZipError('条目名越界（文件损坏）')
    const name = new TextDecoder().decode(data.subarray(nameStart, nameStart + nameLength))
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 按名字取条目；找不到时返回 undefined（调用方决定如何报错）。
 *
 * 名字按**精确匹配**语义（发布产物由我们自己生成，无需模糊）。额外容忍一种
 * 常见形态：归档里带了顶层目录（`foo/wb2a-server.exe`），此时用 basename 兜底，
 * 但只在**唯一命中**时返回，避免同名文件歧义。
 */
export function findEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  const exact = entries.find(entry => entry.name === name)
  if (exact !== undefined) return exact
  const matches = entries.filter(entry => entry.name.split('/').pop() === name)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 解出一个条目的内容。
 *
 * @param data - 完整归档字节。
 * @param entry - {@link listEntries} 给出的条目。
 * @returns 解压后的字节。
 * @throws {ZipError} 压缩方式不支持、尺寸越界、或数据损坏（inflate 失败）时。
 */
export function readEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError(`条目 ${entry.name} 解压后 ${entry.uncompressedSize} 字节，超过 ${MAX_ENTRY_BYTES} 上限`)
  }
  const header = entry.localHeaderOffset
  if (header + 30 > data.length) throw new ZipError(`条目 ${entry.name} 的本地头越界（文件损坏）`)
  if (readUint32(data, header) !== LOCAL_SIGNATURE) {
    throw new ZipError(`条目 ${entry.name} 的本地头签名不匹配（文件损坏）`)
  }
  // 本地头的 name/extra 长度未必与中央目录一致（规范允许），必须以本地头为准。
  const nameLength = readUint16(data, header + 26)
  const extraLength = readUint16(data, header + 28)
  const start = header + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > data.length) throw new ZipError(`条目 ${entry.name} 的数据越界（文件损坏）`)
  const payload = data.subarray(start, end)

  if (entry.compressionMethod === STORED) return payload
  if (entry.compressionMethod === DEFLATED) {
    let inflated: Buffer
    try {
      inflated = inflateRawSync(payload)
    } catch (error) {
      throw new ZipError(`条目 ${entry.name} 解压失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // zlib 返回 Buffer（Uint8Array 的子类）。这里统一成**普通 Uint8Array 视图**：
    // 否则「返回什么类型」会随压缩方式变化，调用方一个 Buffer.isBuffer() 就会得到
    // 两种答案。零拷贝，不复制数据。
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength)
  }
  throw new ZipError(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.compressionMethod}（仅支持 stored/deflate）`)
}

/**
 * 一步取出归档里的某个文件。
 *
 * @param data - 完整归档字节。
 * @param name - 目标文件名（可带顶层目录，见 {@link findEntry}）。
 * @returns 文件字节。
 * @throws {ZipError} 归档里没有该文件时。
 */
export function extractFile(data: Uint8Array, name: string): Uint8Array {
  const entry = findEntry(listEntries(data), name)
  if (entry === undefined) {
    const names = listEntries(data).map(item => item.name).join('、')
    throw new ZipError(`归档里没有 ${name}（实际内容：${names || '空'}）`)
  }
  return readEntry(data, entry)
}
