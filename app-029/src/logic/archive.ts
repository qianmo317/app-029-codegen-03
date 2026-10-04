/**
 * 报价归档（价目版本 + 已出单据冻结 + 逐项差异 + 旧单重算）。
 *
 * ── 为什么整份价目快照（而不是只存改动项/diff 链）──────────────────────────
 * 价目总共约 30 个价项（3 板材 + 3 模组 + 电源分瓦单价 + 5 配件 + 4 加工 + 5 材质估算单价），
 * 整份序列化后每个版本约 2–4KB；按每周调价一次算，十年 ≈ 200KB，对 localStorage 可忽略。
 * 取价是 O(1)：单据记录 versionId，直接拿当时那一版，不用沿 diff 链回放，也不会因为
 * 中间某一版被删掉就整条链断掉（diff 链方案的致命点：断一环则之后所有版本都无法还原）。
 *
 * 「只存改动项」更省的只是每个版本约 2KB 的大头里 90%+ 的空间，但代价是回查必须回放
 * 全部前序版本、且删版本/老数据缺基线时无法还原。本应用价目体量下没有必要，故选择整份快照。
 *
 * ── 什么情况下会退回去看不了（fallback 条件，界面与导出处均会显式标注）────────────
 * 1. 单据上没有任何归档信息（本功能上线前的旧单）：没有 versionId，
 *    原单数字本身可照常显示（单据本身也存了一份行明细快照）；需要按旧用量配「当前价目」
 *    重算一版，标记 recalcKind='legacy-recalc'，不覆盖原单。
 * 2. 单据有 versionId，但该版本快照在本机缺失（清空浏览器数据 / 换机器 / 手动删过存储）：
 *    无法还原当时价目；可用当前价目重算一版（recalcKind='missing-version-recalc'），原单不动。
 * 3. 重算时旧用量引用的某个价项在当前价目里也已被删除（如某板材规格永久下架）：
 *    该行无法取价，列入 missingRefs，金额不计入重算合计并显式列出，而不是静默按 0 算。
 *
 * ── 单位与精度（金额逐分对平）────────────────────────────────────────────
 * - 金额：全程整数「分」；单价为分，电源单价 = round(分/W × 实际档位 W)。
 * - 用量：计件单位（支/套/个/台/张/只/字）向上取整；㎡/米保留 2 位小数；金额只在取整后用量上算。
 * - 两次报价差异拆分：Δ总 = Σ Δ行；每行
 *     Δ用量金额 = round((新用量 − 旧用量) × 旧单价)      （用量差按旧价折算）
 *     Δ单价金额 = Δ行总 − Δ用量金额（含交叉项与四舍五入残差，故逐分必对平，绝不多/少 1 分）
 *   并把新旧用量、新旧单价同时列出。界面文案会注明交叉项（用量与单价同时变动时）归入单价差。
 *
 * ── 兼容性 ─────────────────────────────────────────────────────────────
 * 所有存档对象带 schema: 1；解析时未知字段保留、已知字段缺失补默认值（normalizeXxx），
 * 未来新增字段（schema 2+）旧程序也能打开已知部分。
 */

import type { Material, MaterialKind, Project } from './types'
import { roundQty, type Preset } from './materials'

// ---------- 本机存储（localStorage；自检可注入内存 KV） ----------

export interface KvStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 自检用：纯内存 KV，不碰浏览器 localStorage */
export function createMemoryKv(): KvStore {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v)
  }
}

const defaultKv: KvStore = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // 配额不足等：忽略，不影响本次出单/比价（仅不落盘）
    }
  }
}

export const ARCHIVE_SCHEMA = 1
const KEY_VERSIONS = 'app029.prices.versions.v1'
const KEY_DOCS = 'app029.issuedQuotes.v1'
const KEY_META = 'app029.archiveMeta.v1'

interface ArchiveMeta {
  schema: number
  currentVersionId: string | null
  /** 最近一次已知的价目内容指纹（用于区分「只改了工艺参数」与「改了单价」） */
  lastPriceHash: string | null
  seq: number
}

function readJson<T>(kv: KvStore, key: string, fallback: T): T {
  const raw = kv.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(kv: KvStore, key: string, value: unknown): void {
  kv.setItem(key, JSON.stringify(value))
}

function loadMeta(kv: KvStore): ArchiveMeta {
  const m = readJson<Partial<ArchiveMeta> | null>(kv, KEY_META, null)
  return {
    schema: ARCHIVE_SCHEMA,
    currentVersionId: m?.currentVersionId ?? null,
    lastPriceHash: m?.lastPriceHash ?? null,
    seq: typeof m?.seq === 'number' ? m.seq : 0
  }
}

function saveMeta(kv: KvStore, m: ArchiveMeta): void {
  writeJson(kv, KEY_META, m)
}

// ---------- 价目版本 ----------

/** 价项类型；panel_estimate 为多材质对照用的估算单价（不进入实际 BOM） */
export type PriceKind = MaterialKind | 'panel_estimate'

export interface PriceItem {
  /** 稳定引用：acrylic=板材id，led_module=模组id，psu 固定 'psu'，glue/labor=各自 id，panel_estimate=`pe:${材质id}` */
  key: string
  kind: PriceKind
  name: string
  /** 单价（整数分）；psu 为分/W，实际行单价再 × 档位 W */
  unitPriceCents: number
  unit: string
  /** panel_estimate 三项（元/㎡、元/米、元/字）；其余 kind 为 null */
  basis?: { areaPerM2: number; perimeterPerM: number; perChar: number } | null
}

export interface PriceChange {
  key: string
  name: string
  kind: PriceKind
  beforeCents: number
  afterCents: number
}

export interface PriceVersion {
  schema: number
  id: string
  /** 生效时间（ms 时间戳） */
  effectiveAt: number
  note: string
  /** 'baseline' 首次建立（当时在用价目的基线）；'change' 一次单价改动后的新版本 */
  reason: 'baseline' | 'change'
  /** 整份价目快照 */
  items: PriceItem[]
  /** 相对上一版改动到的价项（baseline 为空） */
  changes: PriceChange[]
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 从预设抽取「参与取价」的价项（工艺参数、尺寸、系数等非价格字段不纳入） */
export function extractPriceItems(preset: Preset): PriceItem[] {
  const items: PriceItem[] = []
  for (const s of preset.acrylicSheets) {
    items.push({ key: s.id, kind: 'acrylic', name: s.spec, unitPriceCents: s.priceCents, unit: '张' })
  }
  for (const m of preset.ledModules) {
    items.push({ key: m.id, kind: 'led_module', name: m.spec, unitPriceCents: m.priceCents, unit: '只' })
  }
  items.push({
    key: 'psu',
    kind: 'psu',
    name: `${preset.psu.spec}（分/W）`,
    unitPriceCents: preset.psu.pricePerWattCents,
    unit: '台'
  })
  for (const c of preset.consumables) {
    items.push({ key: c.id, kind: 'glue', name: c.spec, unitPriceCents: c.unitPriceCents, unit: c.unit })
  }
  for (const l of preset.labor) {
    items.push({ key: l.id, kind: 'labor', name: l.spec, unitPriceCents: l.unitPriceCents, unit: l.unit })
  }
  for (const pm of preset.panelMaterials) {
    items.push({
      key: `pe:${pm.id}`,
      kind: 'panel_estimate',
      name: `${pm.name}（多材质估算）`,
      unitPriceCents: pm.areaPriceCentsPerM2,
      unit: '㎡',
      basis: { areaPerM2: pm.areaPriceCentsPerM2, perimeterPerM: pm.perimeterPriceCentsPerM, perChar: pm.charLaborCents }
    })
  }
  return items.sort((a, b) => a.key.localeCompare(b.key))
}

/** 价目指纹：只对「取价」内容（key → 单价，含估算三项）做，改尺寸/系数不变指纹 */
export function priceHash(items: PriceItem[]): string {
  const parts = items.map((i) => {
    const b = i.basis ? `${i.basis.areaPerM2}|${i.basis.perimeterPerM}|${i.basis.perChar}` : ''
    return `${i.key}:${i.unitPriceCents}:${b}`
  })
  let h = 5381
  const s = parts.join(';')
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}_${s.length}`
}

export function diffPrices(before: PriceItem[], after: PriceItem[]): PriceChange[] {
  const map = new Map(before.map((i) => [i.key, i]))
  const out: PriceChange[] = []
  for (const a of after) {
    const b = map.get(a.key)
    const beforeCents = b ? b.unitPriceCents : 0
    const basisChanged =
      !!b && !!b.basis && !!a.basis && (b.basis.areaPerM2 !== a.basis.areaPerM2 || b.basis.perimeterPerM !== a.basis.perimeterPerM || b.basis.perChar !== a.basis.perChar)
    // panel_estimate 以「元/㎡」为主单价；三项任一改变都算改动（主单价体现）
    if (!b || beforeCents !== a.unitPriceCents || basisChanged) {
      out.push({ key: a.key, name: a.name, kind: a.kind, beforeCents, afterCents: a.unitPriceCents })
    }
  }
  return out
}

function asPriceKind(v: unknown): PriceKind {
  return v === 'acrylic' || v === 'led_module' || v === 'psu' || v === 'glue' || v === 'panel_estimate' ? v : 'labor'
}

function normalizeVersion(raw: unknown): PriceVersion | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Partial<PriceVersion>
  if (typeof v.id !== 'string' || !Array.isArray(v.items)) return null
  return {
    schema: typeof v.schema === 'number' ? v.schema : ARCHIVE_SCHEMA,
    id: v.id,
    effectiveAt: typeof v.effectiveAt === 'number' ? v.effectiveAt : 0,
    note: typeof v.note === 'string' ? v.note : '',
    reason: v.reason === 'change' ? 'change' : 'baseline',
    items: (v.items as Array<Partial<PriceItem>>)
      .filter((it) => it && typeof it.key === 'string')
      .map((it) => ({
        key: it.key as string,
        kind: asPriceKind(it.kind),
        name: typeof it.name === 'string' ? it.name : (it.key as string),
        unitPriceCents: typeof it.unitPriceCents === 'number' ? it.unitPriceCents : 0,
        unit: typeof it.unit === 'string' ? it.unit : '',
        basis: it.basis
          ? {
              areaPerM2: Number(it.basis.areaPerM2) || 0,
              perimeterPerM: Number(it.basis.perimeterPerM) || 0,
              perChar: Number(it.basis.perChar) || 0
            }
          : null
      })),
    changes: Array.isArray(v.changes)
      ? (v.changes as Array<Partial<PriceChange>>)
          .filter((c) => c && typeof c.key === 'string')
          .map((c) => ({
            key: c.key as string,
            name: typeof c.name === 'string' ? c.name : (c.key as string),
            kind: asPriceKind(c.kind),
            beforeCents: Number(c.beforeCents) || 0,
            afterCents: Number(c.afterCents) || 0
          }))
      : []
  }
}

function loadVersions(kv: KvStore): PriceVersion[] {
  const arr = readJson<unknown[]>(kv, KEY_VERSIONS, [])
  return arr.map(normalizeVersion).filter((v): v is PriceVersion => !!v).sort((a, b) => a.effectiveAt - b.effectiveAt)
}

function saveVersions(kv: KvStore, versions: PriceVersion[]): void {
  writeJson(kv, KEY_VERSIONS, versions)
}

export function listPriceVersions(kv: KvStore = defaultKv): PriceVersion[] {
  return loadVersions(kv)
}

export function getPriceVersion(id: string | null | undefined, kv: KvStore = defaultKv): PriceVersion | null {
  if (!id) return null
  return loadVersions(kv).find((v) => v.id === id) ?? null
}

export function currentPriceVersion(kv: KvStore = defaultKv): PriceVersion | null {
  const meta = loadMeta(kv)
  return getPriceVersion(meta.currentVersionId, kv)
}

/**
 * 确保存在基线版本（幂等）：
 * - 归档为空时，把当前在用价目（已 merge 出厂默认的预设）原样存成第一版 baseline；
 * - 已存在则返回当前版。
 * 这样「从来没调过价」也有一份可被单据引用的价目，且第一次正式调价时能正确拿到「改之前」那一份。
 */
export function ensureBaseline(preset: Preset, now: number = Date.now(), kv: KvStore = defaultKv): PriceVersion {
  const versions = loadVersions(kv)
  const meta = loadMeta(kv)
  if (versions.length) {
    const cur = (meta.currentVersionId && versions.find((v) => v.id === meta.currentVersionId)) || versions[versions.length - 1]
    // 元数据指针丢失（异常/旧数据）时只补指针，不重复建基线
    if (meta.currentVersionId !== cur.id || !meta.lastPriceHash) {
      saveMeta(kv, { schema: ARCHIVE_SCHEMA, currentVersionId: cur.id, lastPriceHash: meta.lastPriceHash ?? priceHash(cur.items), seq: meta.seq })
    }
    return cur
  }
  const items = extractPriceItems(preset)
  const base: PriceVersion = {
    schema: ARCHIVE_SCHEMA,
    id: newId('pv'),
    effectiveAt: now,
    note: '基线价目（开始归档时正在使用的单价）',
    reason: 'baseline',
    items,
    changes: []
  }
  versions.push(base)
  saveVersions(kv, versions)
  saveMeta(kv, { schema: ARCHIVE_SCHEMA, currentVersionId: base.id, lastPriceHash: priceHash(items), seq: meta.seq })
  return base
}

/**
 * 提交一次预设保存：
 * - 只改了工艺参数/尺寸（价目指纹没变）→ 不产生新版本，返回当前版；
 * - 单价有改动 → 先确保基线在（基线本身即「改之前那一份」），再存改动后的新版本为当前生效版。
 * 返回 { version, created }。
 */
export function commitPresetPrices(
  preset: Preset,
  opts: { now?: number; note?: string } = {},
  kv: KvStore = defaultKv
): { version: PriceVersion; created: boolean } {
  const now = opts.now ?? Date.now()
  const cur = ensureBaseline(preset, now, kv)
  const items = extractPriceItems(preset)
  const hash = priceHash(items)
  if (hash === loadMeta(kv).lastPriceHash) return { version: cur, created: false }

  const changes = diffPrices(cur.items, items)
  const next: PriceVersion = {
    schema: ARCHIVE_SCHEMA,
    id: newId('pv'),
    effectiveAt: now,
    note: opts.note ?? `单价调整（${changes.length} 项）`,
    reason: 'change',
    items,
    changes
  }
  const versions = loadVersions(kv)
  versions.push(next)
  saveVersions(kv, versions)
  const meta = loadMeta(kv)
  saveMeta(kv, { ...meta, currentVersionId: next.id, lastPriceHash: hash })
  return { version: next, created: true }
}

/**
 * 某日生效的价目版本：effectiveAt ≤ 当天 23:59:59.999 的最后一版；
 * 当天新建的版本即对当天生效（导出单据「按当天生效的版本取价」）。
 */
export function effectiveVersionOn(date: Date, kv: KvStore = defaultKv): PriceVersion | null {
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
  const versions = loadVersions(kv)
  let hit: PriceVersion | null = null
  for (const v of versions) {
    if (v.effectiveAt <= end) hit = v
  }
  return hit
}

// ---------- 已出报价单据（行明细冻结） ----------

export interface QuoteLine {
  group: MaterialKind
  spec: string
  qty: number
  unit: string
  unitPriceCents: number
  amountCents: number
  /** 取价引用（可能缺失：旧单或手工数据） */
  refId?: string
  refWatts?: number
}

export interface QuoteSnapshot {
  /** 出单时项目/工艺关键参数（随单冻结，仅展示用） */
  projectName: string
  customer: string
  panelText: string
  fontText: string
  layoutText: string
  notes: string[]
}

export type RecalcKind = 'original' | 'legacy-recalc' | 'missing-version-recalc'

export interface IssuedQuote {
  schema: number
  id: string
  /** 单号（人类可读） */
  no: string
  projectId: string
  issuedAt: number
  /** 出单当时生效价目版本 id；旧单为 null */
  priceVersionId: string | null
  /** 取价价目生效时间（便于界面展示，即使版本快照丢失也在） */
  priceEffectiveAt: number | null
  lines: QuoteLine[]
  totalCents: number
  snapshot: QuoteSnapshot
  /** 'original' 出单原件；其余为按旧用量 + 当前价目重算的派生件 */
  recalcKind: RecalcKind
  /** 重算件指向的原件 id；原件为 null */
  recalcOfId: string | null
  recalcAt: number | null
  /** 重算时在当前价目里找不到价的引用（无法取价，金额未计入合计） */
  missingRefs?: string[]
}

export function nextQuoteNo(kv: KvStore = defaultKv): string {
  const meta = loadMeta(kv)
  const seq = meta.seq + 1
  saveMeta(kv, { ...meta, seq })
  const y = new Date().getFullYear()
  return `BJ-${y}-${String(seq).padStart(4, '0')}`
}

function normalizeSnapshot(raw: unknown): QuoteSnapshot {
  const s = (raw ?? {}) as Partial<QuoteSnapshot>
  return {
    projectName: typeof s.projectName === 'string' ? s.projectName : '',
    customer: typeof s.customer === 'string' ? s.customer : '',
    panelText: typeof s.panelText === 'string' ? s.panelText : '',
    fontText: typeof s.fontText === 'string' ? s.fontText : '',
    layoutText: typeof s.layoutText === 'string' ? s.layoutText : '',
    notes: Array.isArray(s.notes) ? s.notes.filter((n): n is string => typeof n === 'string') : []
  }
}

function asMaterialKind(v: unknown): MaterialKind {
  return v === 'acrylic' || v === 'led_module' || v === 'psu' || v === 'glue' ? v : 'labor'
}

function normalizeQuote(raw: unknown): IssuedQuote | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Partial<IssuedQuote>
  if (typeof q.id !== 'string') return null
  const lines = Array.isArray(q.lines)
    ? (q.lines as Array<Partial<QuoteLine>>)
        .filter((l) => l && typeof l.spec === 'string')
        .map((l) => ({
          group: asMaterialKind(l.group),
          spec: l.spec as string,
          qty: typeof l.qty === 'number' ? l.qty : 0,
          unit: typeof l.unit === 'string' ? l.unit : '',
          unitPriceCents: typeof l.unitPriceCents === 'number' ? l.unitPriceCents : 0,
          amountCents: typeof l.amountCents === 'number' ? l.amountCents : 0,
          refId: typeof l.refId === 'string' ? l.refId : undefined,
          refWatts: typeof l.refWatts === 'number' ? l.refWatts : undefined
        }))
    : []
  const recalcKind: RecalcKind =
    q.recalcKind === 'legacy-recalc' || q.recalcKind === 'missing-version-recalc' ? q.recalcKind : 'original'
  return {
    schema: typeof q.schema === 'number' ? q.schema : ARCHIVE_SCHEMA,
    id: q.id,
    no: typeof q.no === 'string' ? q.no : q.id,
    projectId: typeof q.projectId === 'string' ? q.projectId : '',
    issuedAt: typeof q.issuedAt === 'number' ? q.issuedAt : 0,
    // 前向兼容：未知字符串（未来版本新增的类型）不强行当成有效 versionId/recalcKind
    priceVersionId: typeof q.priceVersionId === 'string' ? q.priceVersionId : null,
    priceEffectiveAt: typeof q.priceEffectiveAt === 'number' ? q.priceEffectiveAt : null,
    lines,
    totalCents: typeof q.totalCents === 'number' ? q.totalCents : lines.reduce((s, l) => s + l.amountCents, 0),
    snapshot: normalizeSnapshot(q.snapshot),
    recalcKind,
    recalcOfId: typeof q.recalcOfId === 'string' ? q.recalcOfId : null,
    recalcAt: typeof q.recalcAt === 'number' ? q.recalcAt : null,
    missingRefs: Array.isArray(q.missingRefs) ? q.missingRefs.filter((x): x is string => typeof x === 'string') : []
  }
}

function loadDocs(kv: KvStore): IssuedQuote[] {
  const arr = readJson<unknown[]>(kv, KEY_DOCS, [])
  return arr.map(normalizeQuote).filter((q): q is IssuedQuote => !!q).sort((a, b) => b.issuedAt - a.issuedAt)
}

function saveDocs(kv: KvStore, docs: IssuedQuote[]): void {
  writeJson(kv, KEY_DOCS, docs)
}

export function listIssuedQuotes(kv: KvStore = defaultKv): IssuedQuote[] {
  return loadDocs(kv)
}

export function getIssuedQuote(id: string, kv: KvStore = defaultKv): IssuedQuote | null {
  return loadDocs(kv).find((q) => q.id === id) ?? null
}

export interface IssueInput {
  project: Project
  materials: Material[]
  totalCents: number
  snapshot: QuoteSnapshot
  /** 出单日期（默认现在）；测试可注入 */
  now?: number
  /** 显式指定取价版本（一般不传：自动取当天生效版） */
  version?: PriceVersion | null
}

/** BOM 明细行 → 归档行（冻结单价/金额，并带取价引用） */
export function materialToQuoteLine(m: Material): QuoteLine {
  return {
    group: m.kind,
    spec: m.spec,
    qty: m.qty,
    unit: m.unit,
    unitPriceCents: m.unitPriceCents,
    amountCents: m.amountCents,
    refId: m.refId,
    refWatts: m.refWatts
  }
}

/**
 * 出单归档：冻结行明细 + 记录当天生效价目版本。
 * 金额断言：Σ 行金额必须等于传入合计（逐分对平，不平直接抛错，宁不出单）。
 */
export function issueQuote(input: IssueInput, kv: KvStore = defaultKv): IssuedQuote {
  const now = input.now ?? Date.now()
  const version = input.version !== undefined ? input.version : effectiveVersionOn(new Date(now), kv)
  const lines = input.materials.map(materialToQuoteLine)
  const sum = lines.reduce((s, l) => s + l.amountCents, 0)
  if (sum !== input.totalCents) {
    throw new Error(`报价合计对不平：Σ 明细 ${sum} 分 ≠ 合计 ${input.totalCents} 分，拒绝归档`)
  }
  const doc: IssuedQuote = {
    schema: ARCHIVE_SCHEMA,
    id: newId('bq'),
    no: nextQuoteNo(kv),
    projectId: input.project.id,
    issuedAt: now,
    priceVersionId: version?.id ?? null,
    priceEffectiveAt: version?.effectiveAt ?? null,
    lines,
    totalCents: input.totalCents,
    snapshot: input.snapshot,
    recalcKind: 'original',
    recalcOfId: null,
    recalcAt: null,
    missingRefs: []
  }
  const docs = loadDocs(kv)
  docs.push(doc)
  saveDocs(kv, docs)
  return doc
}

// ---------- 旧单重算：旧用量 × 当前价目 ----------

function priceForLine(line: QuoteLine, items: PriceItem[]): { unitPriceCents: number; found: boolean } {
  if (!line.refId) return { unitPriceCents: 0, found: false }
  const pi = items.find((i) => i.key === line.refId)
  if (!pi) return { unitPriceCents: 0, found: false }
  if (line.refId === 'psu') {
    // 分/W × 原单档位 W（原用量不变），四舍五入到分
    return { unitPriceCents: Math.round(pi.unitPriceCents * (line.refWatts ?? 0)), found: true }
  }
  return { unitPriceCents: pi.unitPriceCents, found: true }
}

export interface RecalcResult {
  quote: IssuedQuote
  lines: QuoteLine[]
  totalCents: number
  missingRefs: string[]
}

/**
 * 按当时用量配指定价目（默认当前价目）重算一版。
 * - 不动原件；返回重算件与无法取价的引用清单；
 * - 用量沿用原单（计件整数/㎡米 2 位小数的精度也沿用原单存储值，不重新取整）；
 * - 金额重算：amount = round(qty × 新单价)，Σ 行 = 合计（逐分对平）。
 */
export function recalcQuote(
  original: IssuedQuote,
  preset: Preset,
  kind: RecalcKind,
  opts: { now?: number; kv?: KvStore; persist?: boolean } = {}
): RecalcResult {
  const kv = opts.kv ?? defaultKv
  const now = opts.now ?? Date.now()
  const items = extractPriceItems(preset)
  const missingRefs: string[] = []
  const lines: QuoteLine[] = original.lines.map((l) => {
    const { unitPriceCents, found } = priceForLine(l, items)
    if (!found) {
      missingRefs.push(`${l.refId ?? '(无引用)'} ${l.spec}`)
      return { ...l, unitPriceCents: 0, amountCents: 0 }
    }
    const qty = roundQty(l.qty, l.unit)
    return { ...l, unitPriceCents, amountCents: Math.round(qty * unitPriceCents) }
  })
  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0)
  const recalc: IssuedQuote = {
    ...original,
    id: newId('bq'),
    issuedAt: now,
    priceVersionId: currentPriceVersion(kv)?.id ?? null,
    priceEffectiveAt: currentPriceVersion(kv)?.effectiveAt ?? null,
    lines,
    totalCents,
    recalcKind: kind,
    recalcOfId: original.id,
    recalcAt: now,
    missingRefs
  }
  if (opts.persist !== false) {
    const docs = loadDocs(kv)
    docs.push(recalc)
    saveDocs(kv, docs)
  }
  return { quote: recalc, lines, totalCents, missingRefs }
}

/** 单据引用的价目版本快照是否还在本机 */
export function quoteVersionMissing(q: IssuedQuote, kv: KvStore = defaultKv): boolean {
  return !!q.priceVersionId && !getPriceVersion(q.priceVersionId, kv)
}

// ---------- 两单逐项比价 ----------

export type DiffStatus = 'same' | 'price' | 'qty' | 'both' | 'added' | 'removed'

export interface QuoteDiffLine {
  key: string
  group: MaterialKind
  spec: string
  unit: string
  status: DiffStatus
  qtyA: number | null
  qtyB: number | null
  unitPriceA: number | null
  unitPriceB: number | null
  amountA: number
  amountB: number
  /** 用量差折算金额（分，有正负；A=旧单，B=新单，正=变贵） */
  qtyDeltaCents: number
  /** 单价差折算金额（分，含交叉项/取整残差） */
  priceDeltaCents: number
  /** 行总差（分）= amountB − amountA = qtyDeltaCents + priceDeltaCents（逐分恒等） */
  deltaCents: number
}

export interface QuoteDiff {
  lines: QuoteDiffLine[]
  totalA: number
  totalB: number
  totalDeltaCents: number
  qtyDeltaTotal: number
  priceDeltaTotal: number
  changedCount: number
}

const QTY_EPS = 1e-9

function lineKey(l: QuoteLine): string {
  return l.refId ? `${l.group}:${l.refId}` : `${l.group}:${l.spec}`
}

/**
 * 逐项比价（A=旧单，B=新单，正差 = B 比 A 贵）。
 * 拆分口径见文件头注释：用量差按 A 的旧单价折算，单价差兜底全部残差，
 * 保证 Σ(用量差+单价差) = B 合计 − A 合计，不差一分。
 */
export function compareQuotes(a: IssuedQuote, b: IssuedQuote): QuoteDiff {
  const mapA = new Map(a.lines.map((l) => [lineKey(l), l]))
  const mapB = new Map(b.lines.map((l) => [lineKey(l), l]))
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])]
  const rows: QuoteDiffLine[] = []
  for (const key of keys) {
    const la = mapA.get(key) ?? null
    const lb = mapB.get(key) ?? null
    if (la && lb) {
      const qtyChanged = Math.abs(lb.qty - la.qty) > QTY_EPS
      const priceChanged = lb.unitPriceCents !== la.unitPriceCents
      const status: DiffStatus = !qtyChanged && !priceChanged ? 'same' : qtyChanged && priceChanged ? 'both' : qtyChanged ? 'qty' : 'price'
      const qtyDeltaCents = qtyChanged ? Math.round((lb.qty - la.qty) * la.unitPriceCents) : 0
      const deltaCents = lb.amountCents - la.amountCents
      const priceDeltaCents = deltaCents - qtyDeltaCents
      rows.push({
        key,
        group: la.group,
        spec: la.spec,
        unit: la.unit,
        status,
        qtyA: la.qty,
        qtyB: lb.qty,
        unitPriceA: la.unitPriceCents,
        unitPriceB: lb.unitPriceCents,
        amountA: la.amountCents,
        amountB: lb.amountCents,
        qtyDeltaCents,
        priceDeltaCents,
        deltaCents
      })
    } else if (la) {
      rows.push({
        key,
        group: la.group,
        spec: la.spec,
        unit: la.unit,
        status: 'removed',
        qtyA: la.qty,
        qtyB: null,
        unitPriceA: la.unitPriceCents,
        unitPriceB: null,
        amountA: la.amountCents,
        amountB: 0,
        qtyDeltaCents: -la.amountCents,
        priceDeltaCents: 0,
        deltaCents: -la.amountCents
      })
    } else if (lb) {
      rows.push({
        key,
        group: lb.group,
        spec: lb.spec,
        unit: lb.unit,
        status: 'added',
        qtyA: null,
        qtyB: lb.qty,
        unitPriceA: null,
        unitPriceB: lb.unitPriceCents,
        amountA: 0,
        amountB: lb.amountCents,
        qtyDeltaCents: lb.amountCents,
        priceDeltaCents: 0,
        deltaCents: lb.amountCents
      })
    }
  }
  const totalDeltaCents = b.totalCents - a.totalCents
  const qtyDeltaTotal = rows.reduce((s, r) => s + r.qtyDeltaCents, 0)
  const priceDeltaTotal = rows.reduce((s, r) => s + r.priceDeltaCents, 0)
  return {
    lines: rows.sort((x, y) => Math.abs(y.deltaCents) - Math.abs(x.deltaCents) || x.key.localeCompare(y.key)),
    totalA: a.totalCents,
    totalB: b.totalCents,
    totalDeltaCents,
    qtyDeltaTotal,
    priceDeltaTotal,
    changedCount: rows.filter((r) => r.status !== 'same').length
  }
}

/** 比价合计自检：Σ 行差 = 总差，且 Σ 行金额两边都等于各自合计（逐分） */
export function assertDiffSums(diff: QuoteDiff): { ok: boolean; message: string } {
  const rowSum = diff.lines.reduce((s, r) => s + r.deltaCents, 0)
  const splitSum = diff.qtyDeltaTotal + diff.priceDeltaTotal
  const lineSumA = diff.lines.reduce((s, r) => s + r.amountA, 0)
  const lineSumB = diff.lines.reduce((s, r) => s + r.amountB, 0)
  const ok =
    rowSum === diff.totalDeltaCents && splitSum === diff.totalDeltaCents && lineSumA === diff.totalA && lineSumB === diff.totalB
  return {
    ok,
    message: ok
      ? `逐分对平：Σ 行差 ${rowSum} = 用量差 ${diff.qtyDeltaTotal} + 单价差 ${diff.priceDeltaTotal} = 总差 ${diff.totalDeltaCents}（分）`
      : `对不平：Σ行差=${rowSum}，拆分合计=${splitSum}，总差=${diff.totalDeltaCents}；行金额 ${lineSumA}/${lineSumB} vs 合计 ${diff.totalA}/${diff.totalB}`
  }
}

// ---------- 查询：按客户 / 时间段 ----------

export interface QuoteQuery {
  customer?: string
  projectId?: string
  from?: number
  to?: number
  /** 是否包含重算派生件（默认只看原件） */
  includeRecalc?: boolean
}

export function queryIssuedQuotes(q: QuoteQuery = {}, kv: KvStore = defaultKv): IssuedQuote[] {
  const cust = q.customer?.trim()
  return loadDocs(kv).filter((d) => {
    if (!q.includeRecalc && d.recalcKind !== 'original') return false
    if (q.projectId && d.projectId !== q.projectId) return false
    if (cust && !d.snapshot.customer.includes(cust)) return false
    if (typeof q.from === 'number' && d.issuedAt < q.from) return false
    if (typeof q.to === 'number' && d.issuedAt > q.to) return false
    return true
  })
}

/** 估算归档占用字节（localStorage 里三个键的 JSON 长度之和） */
export function archiveStorageBytes(kv: KvStore = defaultKv): number {
  return [KEY_VERSIONS, KEY_DOCS, KEY_META].reduce((s, k) => s + (kv.getItem(k)?.length ?? 0), 0)
}
