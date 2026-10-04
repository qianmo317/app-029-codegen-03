/**
 * 报价归档：改价留痕 + 历史单据冻结 + 逐项对比 + 旧单重算。
 *
 * ==================== 存储策略（二选一，本实现选「整份快照」） ====================
 * 方案 A：只存改动到的那几项（差量链）
 *   - 省空间，但回查某一天的价目必须从未知初始版起逐条重放全部差量，版本越多越慢；
 *   - 致命弱点：任何一条差量记录损坏/丢失，它之后的所有版本全部重建不出来
 *     ——退回去看不了的是「该记录之后的整条历史链」。
 * 方案 B：每次改价存一整份价目（本实现）
 *   - 一份价目只有几十条单价（约 2~4KB），localStorage 5MB 足够存上千次改价，空间不是瓶颈；
 *   - 回查是 O(1)：直接读那一版，不用重放；哪一版坏了只影响哪一版，其余版本照常可看。
 *   - 退化（看不了）的场景，在这里明说：
 *     ① localStorage 写满（约 5MB）后新版本写不进去——此时改价本身仍生效，但留痕中断，
 *        界面会提示「归档写入失败」，需先清理旧版本才能继续留痕；
 *     ② 用户清空浏览器站点数据，全部归档一起丢失（方案 A 同样如此，不是本方案特有）；
 *     ③ 单据引用的价目版本若被手工清理，单据本身仍完整（单据内冻结了明细行），
 *        看不了的是「当时整份价目里未用到的其它条目」。
 *
 * ==================== 取价与折算的单位 / 精度约定 ====================
 * - 金额一律整数「分」；单价为「分 / 单位」：板材 分/张、LED 模组 分/只、电源 分/W、
 *   配件与加工费 分/各自单位（支/套/米/㎡/字/台）。
 * - 用量 qty：张/只/台/字/套/支 为整数；米、㎡ 保留两位小数（BOM 中已按 0.01 取整）。
 * - 行金额 = Math.round(qty × 单价分)；合计 = Σ 行金额（整数分求和，无浮点误差）。
 * - 电源单价折算：单价分/台 = Math.round(分/W × 电源档位 W)，档位 W 随单据冻结在 refQty 里。
 * - 两次报价的差值分解（同样精确到分，不差一分）：
 *     用量差 = round(新用量 × 旧单价) − 旧金额
 *     单价差 = 新金额 − round(新用量 × 旧单价)
 *   二者之和恒等于「新金额 − 旧金额」，故 Σ用量差 + Σ单价差 = 总价差，逐行与合计都配平。
 * - 整项新增 / 取消视为「用量差」（相当于用量从 0 变来 / 变到 0）。
 *
 * ==================== 兼容约定 ====================
 * 所有归档记录带 schema 版本号；往后新增字段只能是「可选字段」，
 * 读取一律经 normalize 填默认值、不认识的字段原样保留（读-改-写不丢字段），
 * 保证旧存档在新版本下能打开，新存档在旧版本下也不崩。
 */

import type { BomResult, Preset } from './materials'
import type { MaterialKind, Project } from './types'

export const ARCHIVE_SCHEMA = 1

const KEY_VERSIONS = 'app029.priceVersions.v1'
const KEY_DOCS = 'app029.quoteDocs.v1'

// ---------------------------------------------------------------------------
// 价目（PriceBook）与价目版本（PriceVersion）
// ---------------------------------------------------------------------------

export type PriceGroup = 'sheet' | 'led' | 'psu' | 'consumable' | 'labor' | 'panelMaterial'

/** 一条价目：prices 的键为单位口径（unit=每单位、perW=每瓦、perM2=每㎡、perM=每米周长、perChar=每字），值为整数分 */
export interface PriceEntry {
  id: string
  group: PriceGroup
  /** 当时的规格/名称快照（防以后改名或删项后历史价目读不出名字） */
  label: string
  prices: Record<string, number>
}

export interface PriceBook {
  schema: number
  entries: PriceEntry[]
}

export interface PriceChange {
  id: string
  label: string
  /** prices 里的口径键（unit / perW / perM2 / perM / perChar） */
  key: string
  fromCents: number | null
  toCents: number | null
}

export interface PriceVersion {
  schema: number
  id: string
  /** 第几版（从 1 起，单调递增，展示用） */
  seq: number
  createdAt: number
  reason: string
  /** 整份价目快照（全量，不是差量） */
  book: PriceBook
  /** 相对上一版的改动明细（仅展示用，重建价目不依赖它） */
  changes: PriceChange[]
}

// ---------------------------------------------------------------------------
// 归档单据（QuoteDoc）
// ---------------------------------------------------------------------------

export interface QuoteRow {
  /** 价目条目 id（sheet:xxx / led:xxx / psu / cons:xxx / labor:xxx），两单逐行对齐与重算取价都靠它 */
  priceId: string
  kind: MaterialKind | ''
  spec: string
  qty: number
  unit: string
  unitPriceCents: number
  amountCents: number
  /** 单价折算参考量：仅电源用（= 电源档位 W），重算时 单价 = 分/W × refQty */
  refQty?: number
  /** 重算时当前价目里已没有该条目：保留原单价并标注（看不了新价，但原数不丢） */
  stale?: boolean
}

export interface QuoteDoc {
  schema: number
  id: string
  projectId: string
  projectName: string
  customer: string
  issuedAt: number
  /** 出单时生效的价目版本 id；null = 旧单据，没有归档信息 */
  priceVersionId: string | null
  /** issued=正式出单（冻结当时价目）；recomputed=按原用量 × 重算时价目重算（不盖原单） */
  source: 'issued' | 'recomputed'
  recomputedFromId?: string
  rows: QuoteRow[]
  totalCents: number
  note?: string
}

// ---------------------------------------------------------------------------
// 本地存储（容错读取：单条损坏只丢单条，不认识的字段原样保留）
// ---------------------------------------------------------------------------

function readArray(key: string): unknown[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 返回是否写入成功（存储空间不足时 false，调用方需提示「归档写入失败」） */
function writeArray(key: string, value: unknown[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function newDocId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// 价目提取与对比
// ---------------------------------------------------------------------------

/** 从预设提取整份价目（只取与金额相关的字段；工艺参数不影响取价，不归入价目） */
export function priceBookFromPreset(preset: Preset): PriceBook {
  const entries: PriceEntry[] = []
  for (const s of preset.acrylicSheets) {
    entries.push({ id: `sheet:${s.id}`, group: 'sheet', label: s.spec, prices: { unit: s.priceCents } })
  }
  for (const m of preset.ledModules) {
    entries.push({ id: `led:${m.id}`, group: 'led', label: m.spec, prices: { unit: m.priceCents } })
  }
  entries.push({ id: 'psu', group: 'psu', label: `${preset.psu.spec}（分/W）`, prices: { perW: preset.psu.pricePerWattCents } })
  for (const c of preset.consumables) {
    entries.push({ id: `cons:${c.id}`, group: 'consumable', label: `${c.spec}（分/${c.unit}）`, prices: { unit: c.unitPriceCents } })
  }
  for (const l of preset.labor) {
    entries.push({ id: `labor:${l.id}`, group: 'labor', label: `${l.spec}（分/${l.unit}）`, prices: { unit: l.unitPriceCents } })
  }
  for (const pm of preset.panelMaterials) {
    entries.push({
      id: `pm:${pm.id}`,
      group: 'panelMaterial',
      label: pm.name,
      prices: { perM2: pm.areaPriceCentsPerM2, perM: pm.perimeterPriceCentsPerM, perChar: pm.charLaborCents }
    })
  }
  return { schema: ARCHIVE_SCHEMA, entries }
}

/** 两份价目的逐项差异（按条目 id + 口径键对齐；新增/删除的条目也算） */
export function diffPriceBooks(a: PriceBook, b: PriceBook): PriceChange[] {
  const out: PriceChange[] = []
  const mapA = new Map(a.entries.map((e) => [e.id, e]))
  const mapB = new Map(b.entries.map((e) => [e.id, e]))
  const ids = new Set([...mapA.keys(), ...mapB.keys()])
  for (const id of ids) {
    const ea = mapA.get(id)
    const eb = mapB.get(id)
    const label = eb?.label ?? ea?.label ?? id
    const keys = new Set([...Object.keys(ea?.prices ?? {}), ...Object.keys(eb?.prices ?? {})])
    for (const key of keys) {
      const from = ea?.prices[key] ?? null
      const to = eb?.prices[key] ?? null
      if (from !== to) out.push({ id, label, key, fromCents: from, toCents: to })
    }
  }
  return out
}

function normalizeBook(raw: unknown): PriceBook {
  const b = (raw ?? {}) as Partial<PriceBook>
  const entries = Array.isArray(b.entries) ? b.entries : []
  return {
    ...(b as object),
    schema: typeof b.schema === 'number' ? b.schema : ARCHIVE_SCHEMA,
    entries: entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => {
        const x = e as Partial<PriceEntry>
        return {
          ...(x as object),
          id: String(x.id ?? ''),
          group: (x.group ?? 'consumable') as PriceGroup,
          label: String(x.label ?? x.id ?? ''),
          prices: x.prices && typeof x.prices === 'object' ? x.prices : {}
        }
      })
  }
}

function normalizeVersion(raw: unknown, seqFallback: number): PriceVersion {
  const v = (raw ?? {}) as Partial<PriceVersion>
  return {
    ...(v as object),
    schema: typeof v.schema === 'number' ? v.schema : ARCHIVE_SCHEMA,
    id: String(v.id ?? newDocId('pv')),
    seq: typeof v.seq === 'number' ? v.seq : seqFallback,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    reason: String(v.reason ?? ''),
    book: normalizeBook(v.book),
    changes: Array.isArray(v.changes) ? (v.changes as PriceChange[]) : []
  }
}

export function listPriceVersions(key: string = KEY_VERSIONS): PriceVersion[] {
  return readArray(key).map((v, i) => normalizeVersion(v, i + 1)).sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

/**
 * 改价留痕：先把「当时那一份」存下来，改完再存一份新的。
 * - 首次改价：补存改前价目作为第 1 版，再存改后价目作为第 2 版；
 * - 之后的改价：改前价目就是已归档的最新一版，只需追加改后价目；
 * - 价目没有实际变化（只动了工艺参数等）：首次会建立基线版，之后不产生新版本。
 * 返回新归档的版本（无新变化时返回 null）。
 */
export function recordPriceChange(prev: Preset, next: Preset, key: string = KEY_VERSIONS): PriceVersion | null {
  const prevBook = priceBookFromPreset(prev)
  const nextBook = priceBookFromPreset(next)
  const versions = listPriceVersions(key)
  let dirty = false
  if (versions.length === 0) {
    versions.push({
      schema: ARCHIVE_SCHEMA,
      id: newDocId('pv'),
      seq: 1,
      createdAt: Date.now(),
      reason: '改前价目（首次归档基线）',
      book: prevBook,
      changes: []
    })
    dirty = true
  }
  const latest = versions[versions.length - 1]
  const changes = diffPriceBooks(latest.book, nextBook)
  if (changes.length === 0) {
    if (dirty) writeArray(key, versions)
    return null
  }
  const version: PriceVersion = {
    schema: ARCHIVE_SCHEMA,
    id: newDocId('pv'),
    seq: latest.seq + 1,
    createdAt: Date.now(),
    reason: '改后价目',
    book: nextBook,
    changes
  }
  versions.push(version)
  writeArray(key, versions)
  return version
}

/** 出单/导出时取「当天生效的价目版本」：还没有归档就建立基线；预设与最新版不一致就补一版 */
export function ensureCurrentVersion(preset: Preset, key: string = KEY_VERSIONS): PriceVersion {
  const versions = listPriceVersions(key)
  const book = priceBookFromPreset(preset)
  if (versions.length > 0) {
    const latest = versions[versions.length - 1]
    if (diffPriceBooks(latest.book, book).length === 0) return latest
  }
  const version: PriceVersion = {
    schema: ARCHIVE_SCHEMA,
    id: newDocId('pv'),
    seq: versions.length > 0 ? versions[versions.length - 1].seq + 1 : 1,
    createdAt: Date.now(),
    reason: versions.length === 0 ? '首次出单归档基线' : '改后价目',
    book,
    changes: versions.length === 0 ? [] : diffPriceBooks(versions[versions.length - 1].book, book)
  }
  versions.push(version)
  writeArray(key, versions)
  return version
}

// ---------------------------------------------------------------------------
// 单据：出单冻结 / 查询 / 删除
// ---------------------------------------------------------------------------

function normalizeRow(raw: unknown): QuoteRow {
  const r = (raw ?? {}) as Partial<QuoteRow>
  const qty = typeof r.qty === 'number' && Number.isFinite(r.qty) ? r.qty : 0
  const unitPriceCents = Number.isInteger(r.unitPriceCents) ? (r.unitPriceCents as number) : 0
  return {
    ...(r as object),
    priceId: String(r.priceId ?? ''),
    kind: (r.kind ?? '') as MaterialKind | '',
    spec: String(r.spec ?? ''),
    qty,
    unit: String(r.unit ?? ''),
    unitPriceCents,
    amountCents: Number.isInteger(r.amountCents) ? (r.amountCents as number) : Math.round(qty * unitPriceCents)
  }
}

export function normalizeDoc(raw: unknown): QuoteDoc {
  const d = (raw ?? {}) as Partial<QuoteDoc>
  const rows = Array.isArray(d.rows) ? d.rows.map(normalizeRow) : []
  return {
    ...(d as object),
    schema: typeof d.schema === 'number' ? d.schema : ARCHIVE_SCHEMA,
    id: String(d.id ?? newDocId('doc')),
    projectId: String(d.projectId ?? ''),
    projectName: String(d.projectName ?? ''),
    customer: String(d.customer ?? ''),
    issuedAt: typeof d.issuedAt === 'number' ? d.issuedAt : 0,
    priceVersionId: typeof d.priceVersionId === 'string' ? d.priceVersionId : null,
    source: d.source === 'recomputed' ? 'recomputed' : 'issued',
    recomputedFromId: typeof d.recomputedFromId === 'string' ? d.recomputedFromId : undefined,
    rows,
    totalCents: Number.isInteger(d.totalCents) ? (d.totalCents as number) : rows.reduce((s, r) => s + r.amountCents, 0),
    note: typeof d.note === 'string' ? d.note : undefined
  }
}

export function listQuoteDocs(key: string = KEY_DOCS): QuoteDoc[] {
  return readArray(key)
    .map(normalizeDoc)
    .sort((a, b) => b.issuedAt - a.issuedAt)
}

/** 出单归档：把当前 BOM 明细连同「当天生效的价目版本」一起冻结（纯函数，不落库） */
export function issueQuoteDoc(project: Project, bom: BomResult, preset: Preset, key: string = KEY_VERSIONS): QuoteDoc {
  const version = ensureCurrentVersion(preset, key)
  const rows: QuoteRow[] = bom.materials.map((m) => ({
    priceId: m.priceId ?? '',
    kind: m.kind,
    spec: m.spec,
    qty: m.qty,
    unit: m.unit,
    unitPriceCents: m.unitPriceCents,
    amountCents: m.amountCents,
    ...(m.kind === 'psu' ? { refQty: bom.led.psuUnitW } : {})
  }))
  return {
    schema: ARCHIVE_SCHEMA,
    id: newDocId('doc'),
    projectId: project.id,
    projectName: project.name,
    customer: project.customer ?? '',
    issuedAt: Date.now(),
    priceVersionId: version.id,
    source: 'issued',
    rows,
    totalCents: rows.reduce((s, r) => s + r.amountCents, 0)
  }
}

/** 返回是否写入成功 */
export function saveQuoteDoc(doc: QuoteDoc, key: string = KEY_DOCS): boolean {
  const docs = listQuoteDocs(key)
  const idx = docs.findIndex((d) => d.id === doc.id)
  if (idx >= 0) docs[idx] = doc
  else docs.unshift(doc)
  return writeArray(key, docs)
}

export function deleteQuoteDoc(id: string, key: string = KEY_DOCS): void {
  writeArray(
    key,
    listQuoteDocs(key).filter((d) => d.id !== id)
  )
}

// ---------------------------------------------------------------------------
// 两单逐项对比：差在哪几条、差多少钱；用量差与单价差分开，且合计配平到分
// ---------------------------------------------------------------------------

export interface QuoteDiffLine {
  key: string
  spec: string
  unit: string
  status: 'same' | 'changed' | 'added' | 'removed'
  qtyA: number | null
  qtyB: number | null
  unitPriceA: number | null
  unitPriceB: number | null
  amountA: number
  amountB: number
  /** 用量差（分）= round(新用量 × 旧单价) − 旧金额 */
  qtyEffectCents: number
  /** 单价差（分）= 新金额 − round(新用量 × 旧单价) */
  priceEffectCents: number
}

export interface QuoteDiff {
  lines: QuoteDiffLine[]
  qtyEffectTotalCents: number
  priceEffectTotalCents: number
  /** 总价差（分）= B 合计 − A 合计 */
  amountDiffTotalCents: number
  /** 配平校验：Σ用量差 + Σ单价差 === 总价差（必须一分不差） */
  balanced: boolean
}

function rowKey(r: QuoteRow): string {
  return r.priceId || `spec:${r.spec}`
}

export function diffQuoteDocs(a: QuoteDoc, b: QuoteDoc): QuoteDiff {
  const mapA = new Map(a.rows.map((r) => [rowKey(r), r]))
  const mapB = new Map(b.rows.map((r) => [rowKey(r), r]))
  const keys: string[] = []
  for (const k of mapA.keys()) if (!keys.includes(k)) keys.push(k)
  for (const k of mapB.keys()) if (!keys.includes(k)) keys.push(k)

  const lines: QuoteDiffLine[] = []
  for (const key of keys) {
    const ra = mapA.get(key)
    const rb = mapB.get(key)
    if (ra && rb) {
      // 中间量：新用量 × 旧单价（分，取整）——差值分解的支点
      const mid = Math.round(rb.qty * ra.unitPriceCents)
      const qtyEffect = mid - ra.amountCents
      const priceEffect = rb.amountCents - mid
      const changed = ra.qty !== rb.qty || ra.unitPriceCents !== rb.unitPriceCents || ra.amountCents !== rb.amountCents
      lines.push({
        key,
        spec: rb.spec || ra.spec,
        unit: rb.unit || ra.unit,
        status: changed ? 'changed' : 'same',
        qtyA: ra.qty,
        qtyB: rb.qty,
        unitPriceA: ra.unitPriceCents,
        unitPriceB: rb.unitPriceCents,
        amountA: ra.amountCents,
        amountB: rb.amountCents,
        qtyEffectCents: qtyEffect,
        priceEffectCents: priceEffect
      })
    } else if (rb) {
      // 整项新增：视为用量从 0 变来，全部计入用量差
      lines.push({
        key,
        spec: rb.spec,
        unit: rb.unit,
        status: 'added',
        qtyA: null,
        qtyB: rb.qty,
        unitPriceA: null,
        unitPriceB: rb.unitPriceCents,
        amountA: 0,
        amountB: rb.amountCents,
        qtyEffectCents: rb.amountCents,
        priceEffectCents: 0
      })
    } else if (ra) {
      // 整项取消：视为用量变到 0，全部计入用量差
      lines.push({
        key,
        spec: ra.spec,
        unit: ra.unit,
        status: 'removed',
        qtyA: ra.qty,
        qtyB: null,
        unitPriceA: ra.unitPriceCents,
        unitPriceB: null,
        amountA: ra.amountCents,
        amountB: 0,
        qtyEffectCents: -ra.amountCents,
        priceEffectCents: 0
      })
    }
  }

  const qtyEffectTotalCents = lines.reduce((s, l) => s + l.qtyEffectCents, 0)
  const priceEffectTotalCents = lines.reduce((s, l) => s + l.priceEffectCents, 0)
  const amountDiffTotalCents = b.totalCents - a.totalCents
  return {
    lines,
    qtyEffectTotalCents,
    priceEffectTotalCents,
    amountDiffTotalCents,
    balanced: qtyEffectTotalCents + priceEffectTotalCents === amountDiffTotalCents
  }
}

// ---------------------------------------------------------------------------
// 旧单重算：按当时的用量 × 当前价目重算一版（新单据，原单不动）
// ---------------------------------------------------------------------------

/**
 * 重算一版：用量照抄原单，单价按「重算时生效的价目」重新取。
 * - 生成一张 source='recomputed' 的新单据（标注 recomputedFromId），原单一个字节都不改；
 * - 原单没有明细行（既无归档价目也没存用量）时返回空行单据——这种旧单退回去看不了明细，
 *   调用方应提示「无法重算」而不是默默出一张空单；
 * - 某条目在当前价目里已删除：保留原单价并标 stale=true，在 note 里说明。
 */
export function recomputeQuoteDoc(doc: QuoteDoc, preset: Preset, key: string = KEY_VERSIONS): QuoteDoc {
  const book = priceBookFromPreset(preset)
  const version = ensureCurrentVersion(preset, key)
  const staleSpecs: string[] = []
  const rows: QuoteRow[] = doc.rows.map((r) => {
    const entry = book.entries.find((e) => e.id === r.priceId)
    let unitPriceCents = r.unitPriceCents
    let stale = false
    if (!entry) {
      stale = true
    } else if (r.priceId === 'psu') {
      unitPriceCents = Math.round((entry.prices.perW ?? 0) * (r.refQty ?? 0))
    } else if (Number.isInteger(entry.prices.unit)) {
      unitPriceCents = entry.prices.unit
    } else {
      stale = true
    }
    if (stale) staleSpecs.push(r.spec || r.priceId)
    return { ...r, unitPriceCents, amountCents: Math.round(r.qty * unitPriceCents), stale }
  })
  return {
    schema: ARCHIVE_SCHEMA,
    id: newDocId('doc'),
    projectId: doc.projectId,
    projectName: doc.projectName,
    customer: doc.customer,
    issuedAt: Date.now(),
    priceVersionId: version.id,
    source: 'recomputed',
    recomputedFromId: doc.id,
    rows,
    totalCents: rows.reduce((s, r) => s + r.amountCents, 0),
    note:
      `按原单（${doc.id}）用量 × 第 ${version.seq} 版价目重算；原单保留不变。` +
      (staleSpecs.length > 0 ? `以下条目当前价目已删除，保留原单价：${staleSpecs.join('、')}` : '')
  }
}
