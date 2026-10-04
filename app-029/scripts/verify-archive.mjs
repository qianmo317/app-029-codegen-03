// 归档核心逻辑端到端验证（不依赖浏览器/字体）：用 esbuild 即时打包到 ESM 再跑。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const virtual = `
import {
  createMemoryKv, ensureBaseline, commitPresetPrices, effectiveVersionOn,
  issueQuote, compareQuotes, assertDiffSums, recalcQuote, queryIssuedQuotes,
  listIssuedQuotes, listPriceVersions, getPriceVersion, quoteVersionMissing,
  archiveStorageBytes, extractPriceItems
} from '/workspace/app-029/src/logic/archive.ts'
import { defaultPresetDeep } from '/workspace/app-029/src/logic/store.ts'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS:', msg) } else { fail++; console.log('FAIL:', msg) } }

const kv = createMemoryKv()
const preset0 = defaultPresetDeep()
const t1 = Date.parse('2026-09-01T10:00:00')
const base = ensureBaseline(preset0, t1, kv)
ok(base.reason === 'baseline' && listPriceVersions(kv).length === 1, '首次载入建立基线版本')
ok(commitPresetPrices(preset0, { now: t1 + 1 }, kv).created === false, '同价目不重复建版')

// 当天生效版本：9-10 当天取基线，10-15 调价后取新版
ok(effectiveVersionOn(new Date('2026-09-10T08:00:00'), kv)?.id === base.id, '调价前日期取基线版')

// 造一张最小 BOM：板材 2 张 + 一个加工费
const mkMaterials = (sheetPrice, laborPrice) => [
  { kind: 'acrylic', spec: '板A', qty: 2, unit: '张', unitPriceCents: sheetPrice, amountCents: 2 * sheetPrice, refId: preset0.acrylicSheets[0].id },
  { kind: 'labor', spec: '切割', qty: 3, unit: '字', unitPriceCents: laborPrice, amountCents: 3 * laborPrice, refId: 'cut' }
]
const proj = { id: 'p1', name: '测试项目', customer: '张三便利店', layout: {}, led: {}, panelMaterialId: 'x', sheetId: 'x', ledModuleId: 'x', createdAt: t1, updatedAt: t1 }
const snap = { projectName: '测试项目', customer: '张三便利店', panelText: '', fontText: '', layoutText: '', notes: [] }

const m0 = mkMaterials(28000, 18000)
const d0 = issueQuote({ project: proj, materials: m0, totalCents: m0.reduce((s, x) => s + x.amountCents, 0), now: t1 + 3600e3, snapshot: snap }, kv)
ok(d0.totalCents === 2 * 28000 + 3 * 18000, '出单合计正确（110000 分）')

// 对不平必须拒绝归档
let threw = false
try { issueQuote({ project: proj, materials: m0, totalCents: 1, now: t1, snapshot: snap }, kv) } catch { threw = true }
ok(threw, 'Σ明细≠合计 时拒绝出单')

// 调价：板材 +500 分，加工 +200 分
const preset1 = defaultPresetDeep()
preset1.acrylicSheets[0].priceCents = 28500
preset1.labor.find(l => l.id === 'cut').unitPriceCents = 18200
const t2 = Date.parse('2026-10-15T10:00:00')
const v2 = commitPresetPrices(preset1, { now: t2 }, kv).version
ok(v2.changes.length === 2, '调价版本记录 2 项改动')
ok(effectiveVersionOn(new Date('2026-10-15T09:00:00'), kv)?.id === v2.id, '调价当天取新版')
ok(effectiveVersionOn(new Date('2026-10-14T09:00:00'), kv)?.id === base.id, '调价前一天仍取旧版')

const m1 = mkMaterials(28500, 18200)
const d1 = issueQuote({ project: proj, materials: m1, totalCents: m1.reduce((s, x) => s + x.amountCents, 0), now: t2 + 3600e3, snapshot: snap }, kv)
const d0stored = listIssuedQuotes(kv).find(d => d.id === d0.id)
ok(d0stored.totalCents === 110000, '调价后旧单金额未被影响')

const diff1 = compareQuotes(d0, d1)
ok(assertDiffSums(diff1).ok, '比价1 逐分对平')
ok(diff1.qtyDeltaTotal === 0 && diff1.priceDeltaTotal === diff1.totalDeltaCents, '同用量：用量差 0，总差全归单价差')
ok(diff1.totalDeltaCents === 2 * 500 + 3 * 200, '总差 = 板材1000 + 加工600 = 1600')

// 用量+单价同时变：胶 3800→4000，用量 3→5
const t3 = Date.parse('2026-11-01T10:00:00')
const preset2 = defaultPresetDeep()
preset2.acrylicSheets[0].priceCents = 28500
preset2.labor.find(l => l.id === 'cut').unitPriceCents = 18200
preset2.consumables.find(c => c.id === 'glue').unitPriceCents = 4000
commitPresetPrices(preset2, { now: t3 }, kv)
const dA = issueQuote({ project: proj, now: t3, snapshot: snap, materials: [
  { kind: 'glue', spec: '结构胶', qty: 3, unit: '支', unitPriceCents: 3800, amountCents: 11400, refId: 'glue' }
], totalCents: 11400 }, kv)
const dB = issueQuote({ project: proj, now: t3 + 1000, snapshot: snap, materials: [
  { kind: 'glue', spec: '结构胶', qty: 5, unit: '支', unitPriceCents: 4000, amountCents: 20000, refId: 'glue' }
], totalCents: 20000 }, kv)
const diff2 = compareQuotes(dA, dB)
ok(assertDiffSums(diff2).ok, '比价2 逐分对平（交叉项场景）')
const row = diff2.lines[0]
ok(row.qtyDeltaCents === 2 * 3800, '用量差按旧价折 = +7600')
ok(row.priceDeltaCents === 8600 - 7600, '单价差 = 行差8600 − 用量差7600 = 1000（含交叉400+旧量3×200=600）')
ok(row.status === 'both', '标记为 单价+用量 双变')

// 新增/取消项
const dC = issueQuote({ project: proj, now: t3 + 2000, snapshot: { ...snap, customer: '李四' }, materials: [
  { kind: 'glue', spec: '结构胶', qty: 5, unit: '支', unitPriceCents: 4000, amountCents: 20000, refId: 'glue' },
  { kind: 'psu', spec: '电源', qty: 1, unit: '台', unitPriceCents: 9000, amountCents: 9000, refId: 'psu', refWatts: 60 }
], totalCents: 29000 }, kv)
const diff3 = compareQuotes(dB, dC)
ok(assertDiffSums(diff3).ok, '比价3（新增项）逐分对平')
ok(diff3.lines.some(r => r.status === 'added' && r.deltaCents === 9000), '新增电源行 +9000')

// 旧单（无 versionId）重算：用当前价目，原单不动
const legacy = JSON.parse(JSON.stringify(d0))
legacy.id = 'bqlegacy'; legacy.priceVersionId = null; legacy.priceEffectiveAt = null
const docs = JSON.parse(kv.getItem('app029.issuedQuotes.v1'))
docs.push(legacy); kv.setItem('app029.issuedQuotes.v1', JSON.stringify(docs))
const legacyLoaded = listIssuedQuotes(kv).find(d => d.id === 'bqlegacy')
const r1 = recalcQuote(legacyLoaded, preset2, 'legacy-recalc', { kv, now: t3 + 999 })
ok(legacyLoaded.totalCents === 110000 && r1.quote.recalcOfId === 'bqlegacy', '重算不覆盖原件，新件指向原件')
// 当前板材28500、切割18200 → 2*28500+3*18200=111600
ok(r1.totalCents === 2 * 28500 + 3 * 18200, '重算金额=旧用量×当前价（111600）')
ok(r1.quote.recalcKind === 'legacy-recalc', '标记为旧单重算')

// 缺失价项：当前价目删掉 glue
const preset3 = JSON.parse(JSON.stringify(preset2))
preset3.consumables = preset3.consumables.filter(c => c.id !== 'glue')
const r2 = recalcQuote(dA, preset3, 'missing-version-recalc', { kv, now: t3 + 888, persist: false })
ok(r2.missingRefs.length === 1 && r2.missingRefs[0].includes('glue'), '缺失价项列入 missingRefs')
ok(r2.totalCents === 0, '缺失行金额不计入合计')

// 版本缺失检测
ok(quoteVersionMissing({ ...d0, priceVersionId: 'pv_x' }, kv) === true, '引用不存在版本 → 缺失')
ok(quoteVersionMissing(d0, kv) === false, '引用存在版本 → 不缺失')

// 查询
const q1 = queryIssuedQuotes({ customer: '张三' }, kv)
ok(q1.every(d => d.snapshot.customer.includes('张三')) && q1.length >= 4, '按客户模糊查询（原件）')
const q2 = queryIssuedQuotes({ customer: '李四', includeRecalc: true }, kv)
ok(q2.length === 1 && q2[0].snapshot.customer === '李四', '客户「李四」1 张')
const q3 = queryIssuedQuotes({ from: t2, to: t2 + 100000e3, includeRecalc: true }, kv)
ok(q3.every(d => d.issuedAt >= t2), '时间段过滤')

// 旧存档兼容：缺 schema/customer/refId 的老对象
const docs2 = JSON.parse(kv.getItem('app029.issuedQuotes.v1'))
docs2.push({ id: 'old1', no: 'X', projectId: 'p1', issuedAt: t1, lines: [{ group: 'labor', spec: '老项', qty: 1, unit: '字', unitPriceCents: 50, amountCents: 50 }], totalCents: 50, snapshot: { projectName: '老项目' }, futureField: { a: 1 } })
kv.setItem('app029.issuedQuotes.v1', JSON.stringify(docs2))
const oldParsed = listIssuedQuotes(kv).find(d => d.id === 'old1')
ok(!!oldParsed && oldParsed.recalcKind === 'original' && oldParsed.snapshot.customer === '' && oldParsed.totalCents === 50, '旧格式缺字段补默认值可打开')

// 电源分瓦折算
const preset4 = defaultPresetDeep()
preset4.psu.pricePerWattCents = 200 // 180→200
const rp = recalcQuote({ ...dC, id: 'bqpsu', recalcKind: 'original', recalcOfId: null, recalcAt: null, priceVersionId: null, priceEffectiveAt: null }, preset4, 'legacy-recalc', { kv, persist: false })
const psuLine = rp.lines.find(l => l.refId === 'psu')
ok(psuLine && psuLine.unitPriceCents === Math.round(200 * 60) && psuLine.amountCents === 12000, '电源按 分/W×档位W 重取价（200×60=12000）')

console.log('\\n归档占用', (archiveStorageBytes(kv) / 1024).toFixed(1), 'KB；版本数', listPriceVersions(kv).length)
console.log('价项数', extractPriceItems(preset0).length)
console.log('\\n结果:', pass, 'passed,', fail, 'failed')
if (fail) process.exit(1)
`

writeFileSync('/tmp/archive-entry.ts', virtual)
const result = await build({
  entryPoints: ['/tmp/archive-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  absWorkingDir: process.cwd()
})
writeFileSync('/tmp/archive-bundle.mjs', result.outputFiles[0].text)
await import('/tmp/archive-bundle.mjs')
