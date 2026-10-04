<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  archiveStorageBytes,
  assertDiffSums,
  compareQuotes,
  getIssuedQuote,
  getPriceVersion,
  listIssuedQuotes,
  listPriceVersions,
  queryIssuedQuotes,
  quoteVersionMissing,
  recalcQuote,
  type IssuedQuote,
  type PriceVersion,
  type QuoteDiff,
  type RecalcKind
} from '../logic/archive'
import { loadPreset } from '../logic/store'
import { yuan } from '../logic/materials'
import { bomGroupLabel, exportIssuedQuoteXls, issuedPriceLine, issuedRows } from '../logic/quote'

const route = useRoute()
const router = useRouter()

const customer = ref('')
const from = ref('')
const to = ref('')
const includeRecalc = ref(true)
const tick = ref(0)
const selectedIds = ref<string[]>([])
const detailId = ref<string>((route.query.doc as string) ?? '')
const msg = ref('')

const allDocs = computed<IssuedQuote[]>(() => {
  void tick.value
  return listIssuedQuotes()
})

const filtered = computed<IssuedQuote[]>(() => {
  void tick.value
  const fromTs = from.value ? new Date(from.value + 'T00:00:00').getTime() : undefined
  const toTs = to.value ? new Date(to.value + 'T23:59:59').getTime() : undefined
  return queryIssuedQuotes(
    { customer: customer.value, from: fromTs, to: toTs, includeRecalc: includeRecalc.value },
  )
})

const versions = computed<PriceVersion[]>(() => {
  void tick.value
  return listPriceVersions().slice().reverse()
})

const storageKb = computed(() => {
  void tick.value
  return (archiveStorageBytes() / 1024).toFixed(1)
})

const detail = computed<IssuedQuote | null>(() => (detailId.value ? getIssuedQuote(detailId.value) : null))
const detailVersion = computed<PriceVersion | null>(() => (detail.value ? getPriceVersion(detail.value.priceVersionId) : null))

// 比价：默认「原件 vs 它的重算件」，也可手动勾两单
const cmpAId = ref('')
const cmpBId = ref('')
onMounted(() => {
  const d = detail.value
  if (d && d.recalcKind !== 'original' && d.recalcOfId) {
    cmpAId.value = d.recalcOfId
    cmpBId.value = d.id
  }
})

const cmpDocs = computed(() =>
  selectedIds.value.length === 2 ? selectedIds.value : [cmpAId.value, cmpBId.value].filter(Boolean)
)
const quoteA = computed(() => (cmpDocs.value[0] ? getIssuedQuote(cmpDocs.value[0]) : null))
const quoteB = computed(() => (cmpDocs.value[1] ? getIssuedQuote(cmpDocs.value[1]) : null))
const diff = computed<QuoteDiff | null>(() =>
  quoteA.value && quoteB.value ? compareQuotes(quoteA.value, quoteB.value) : null
)
const diffSum = computed(() => (diff.value ? assertDiffSums(diff.value) : null))

const changedOnly = ref(true)
const diffRows = computed(() =>
  changedOnly.value && diff.value ? diff.value.lines.filter((r) => r.status !== 'same') : diff.value?.lines ?? []
)

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}
function fmtDate(ts: number | null): string {
  return ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
}

function kindTag(d: IssuedQuote): { text: string; cls: string } {
  if (d.recalcKind === 'legacy-recalc') return { text: '旧单重算', cls: 'warn' }
  if (d.recalcKind === 'missing-version-recalc') return { text: '版本缺失重算', cls: 'warn' }
  return { text: '原件', cls: 'ok' }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'price':
      return '单价变'
    case 'qty':
      return '用量变'
    case 'both':
      return '单价+用量'
    case 'added':
      return '新增项'
    case 'removed':
      return '取消项'
    default:
      return '无变化'
  }
}

function centsFmt(c: number): string {
  const s = yuan(Math.abs(c))
  return `${c > 0 ? '+' : c < 0 ? '−' : ''}${s}`
}

function qtyText(v: number | null): string {
  return v === null ? '—' : String(v)
}
function priceText(v: number | null): string {
  return v === null ? '—' : yuan(v)
}

function openDoc(d: IssuedQuote): void {
  detailId.value = d.id
  selectedIds.value = []
  cmpAId.value = ''
  cmpBId.value = ''
  router.replace({ query: { doc: d.id } })
}

function toggleSelect(id: string): void {
  const i = selectedIds.value.indexOf(id)
  if (i >= 0) selectedIds.value.splice(i, 1)
  else if (selectedIds.value.length < 2) selectedIds.value.push(id)
  else selectedIds.value = [selectedIds.value[1], id]
}

function doRecalc(d: IssuedQuote, kind: RecalcKind): void {
  const preset = loadPreset()
  const r = recalcQuote(d, preset, kind)
  tick.value++
  const miss = r.missingRefs.length ? `；${r.missingRefs.length} 项在当前价目缺失未计价：${r.missingRefs.join('；')}` : ''
  msg.value = `已生成重算件（单号沿用 ${r.quote.no} 的用量，重算合计 ${yuan(r.totalCents)} 元），原件保留未动${miss}`
  detailId.value = r.quote.id
  cmpAId.value = d.id
  cmpBId.value = r.quote.id
  router.replace({ query: { doc: r.quote.id } })
}

function exportXls(d: IssuedQuote): void {
  exportIssuedQuoteXls(d, issuedRows(d), {
    customer: d.snapshot.customer,
    projectName: d.snapshot.projectName,
    panelText: d.snapshot.panelText,
    fontText: d.snapshot.fontText,
    layoutText: d.snapshot.layoutText
  })
}

function printDetail(): void {
  window.print()
}
</script>

<template>
  <div class="page">
    <div class="grid cols-2" style="align-items: start">
      <!-- 左：检索 + 单据列表 -->
      <section class="card no-print">
        <header>
          <h1>报价归档</h1>
          <span class="hint">{{ allDocs.length }} 张单据 · {{ versions.length }} 个价目版本 · 本机占用约 {{ storageKb }} KB</span>
        </header>
        <div class="field">
          <label>客户（模糊匹配）</label>
          <div class="ctl"><input v-model="customer" type="text" placeholder="客户名称" style="width: 180px" /></div>
        </div>
        <div class="field">
          <label>出单时间</label>
          <div class="ctl">
            <input v-model="from" type="date" />
            <span class="muted">至</span>
            <input v-model="to" type="date" />
          </div>
        </div>
        <div class="field">
          <label></label>
          <div class="ctl">
            <label class="muted"><input v-model="includeRecalc" type="checkbox" /> 包含重算派生件</label>
          </div>
        </div>

        <p class="muted" v-if="msg" style="color: var(--ok)">{{ msg }}</p>

        <table>
          <thead>
            <tr>
              <th style="width: 30px"></th>
              <th>单号 / 客户</th>
              <th>出单时间</th>
              <th class="num">合计（元）</th>
              <th>类型</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in filtered" :key="d.id" :class="{ 'row-active': d.id === detailId }">
              <td><input type="checkbox" :checked="selectedIds.includes(d.id)" @change="toggleSelect(d.id)" /></td>
              <td>
                <a href="#" @click.prevent="openDoc(d)">{{ d.no }}</a>
                <div class="muted">{{ d.snapshot.customer || '（无客户）' }} · {{ d.snapshot.projectName }}</div>
              </td>
              <td class="muted">{{ fmtTime(d.issuedAt) }}</td>
              <td class="num"><b>{{ yuan(d.totalCents) }}</b></td>
              <td>
                <span class="tag" :class="kindTag(d).cls">{{ kindTag(d).text }}</span>
                <span v-if="quoteVersionMissing(d)" class="tag bad">价目缺失</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="muted" v-if="filtered.length === 0">没有符合条件的单据。</p>
        <p class="muted" v-else>勾选两张单据可逐项比价（用量差 / 单价差分开列，逐分对平）。</p>
      </section>

      <!-- 右：详情 / 比价 -->
      <section>
        <div v-if="!detail" class="card">
          <h2>单据详情与比价</h2>
          <p class="muted" style="margin-top: 8px">
            从左侧选一张单据查看原件；勾选两张单据做逐项比价。
            旧单（无归档信息）或价目版本缺失的单据，可用「按当时用量 × 当前价目重算」生成一份标记为「重算」的派生件，原件不动。
          </p>
        </div>

        <div v-else class="card" id="print-area">
          <header>
            <h1>招牌字制作报价单<span v-if="detail.recalcKind !== 'original'" class="tag warn" style="margin-left: 8px">重算</span></h1>
            <span class="hint">单号 {{ detail.no }} · {{ fmtTime(detail.issuedAt) }}</span>
          </header>
          <p class="banner" :class="detail.recalcKind === 'original' ? 'info' : 'warn'">{{ issuedPriceLine(detail) }}</p>

          <div class="kv-list">
            <span class="muted">客户</span><span>{{ detail.snapshot.customer || '（未填）' }}</span>
            <span class="muted">项目</span><span>{{ detail.snapshot.projectName }}</span>
            <span class="muted">门头</span><span class="mono">{{ detail.snapshot.panelText }}</span>
            <span class="muted">字体排版</span><span class="mono">{{ detail.snapshot.fontText }}</span>
            <span class="muted">价目版本</span>
            <span class="mono">
              {{ detailVersion ? `${fmtDate(detailVersion.effectiveAt)} 生效（${detailVersion.note}）` : '版本快照本机缺失' }}
            </span>
          </div>

          <table style="margin-top: 10px">
            <thead>
              <tr>
                <th>类别</th>
                <th>规格 / 说明</th>
                <th class="num">数量</th>
                <th>单位</th>
                <th class="num">单价（元）</th>
                <th class="num">金额（元）</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in detail.lines" :key="i">
                <td>{{ bomGroupLabel(l.group) }}</td>
                <td>{{ l.spec }}</td>
                <td class="num">{{ l.qty }}</td>
                <td>{{ l.unit }}</td>
                <td class="num">{{ yuan(l.unitPriceCents) }}</td>
                <td class="num">{{ yuan(l.amountCents) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="5">合计</td>
                <td class="num">¥{{ yuan(detail.totalCents) }}</td>
              </tr>
            </tfoot>
          </table>

          <div v-if="detail.missingRefs?.length" class="banner bad" style="margin-top: 8px">
            重算时以下条目在当前价目中已删除，未取价、未计入合计：{{ detail.missingRefs.join('；') }}
          </div>

          <div class="row no-print" style="margin-top: 10px">
            <button @click="printDetail">打印 / PDF</button>
            <button @click="exportXls(detail)">导出 Excel</button>
            <button v-if="!detail.priceVersionId" class="primary" @click="doRecalc(detail, 'legacy-recalc')">
              按当时用量 × 当前价目重算
            </button>
            <button v-else-if="quoteVersionMissing(detail)" class="primary" @click="doRecalc(detail, 'missing-version-recalc')">
              版本缺失：按当前价目重算
            </button>
            <router-link v-if="detail.projectId" :to="`/quote/${detail.projectId}`"><button>回到项目报价页</button></router-link>
          </div>
        </div>

        <!-- 比价 -->
        <div v-if="quoteA && quoteB" class="card no-print" style="margin-top: 14px">
          <header>
            <h2>逐项比价</h2>
            <span class="hint">
              A {{ quoteA.no }}（{{ fmtDate(quoteA.issuedAt) }}） → B {{ quoteB.no }}（{{ fmtDate(quoteB.issuedAt) }}）
            </span>
          </header>
          <p class="muted">
            A 合计 ¥{{ yuan(diff?.totalA ?? 0) }}；B 合计 ¥{{ yuan(diff?.totalB ?? 0) }}；总差
            <b :class="(diff?.totalDeltaCents ?? 0) > 0 ? 'cell-up' : (diff?.totalDeltaCents ?? 0) < 0 ? 'cell-down' : ''">
              {{ centsFmt(diff?.totalDeltaCents ?? 0) }} 元
            </b>
            ＝ 用量差合计 <b>{{ centsFmt(diff?.qtyDeltaTotal ?? 0) }}</b> ＋ 单价差合计
            <b>{{ centsFmt(diff?.priceDeltaTotal ?? 0) }}</b>（元）
          </p>
          <p class="muted">
            口径：用量差按 A（旧单）单价折算；单价差 = 行总差 − 用量差，因此用量与单价同时变动的交叉项及四舍五入残差归入单价差，
            保证逐分对平。计件数量向上取整、㎡/米 2 位小数；金额整数分。
          </p>
          <div class="row">
            <label class="muted"><input v-model="changedOnly" type="checkbox" /> 只看有差异的行（{{ diff?.changedCount ?? 0 }} 行）</label>
          </div>
          <table>
            <thead>
              <tr>
                <th>类别 / 规格</th>
                <th>差异</th>
                <th class="num">用量 A→B</th>
                <th class="num">单价(元) A→B</th>
                <th class="num">金额 A→B（元）</th>
                <th class="num">用量差</th>
                <th class="num">单价差</th>
                <th class="num">行差</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in diffRows" :key="r.key" :class="{ 'row-dim': r.status === 'same' }">
                <td>
                  {{ bomGroupLabel(r.group) }}
                  <div class="muted">{{ r.spec }}</div>
                </td>
                <td><span class="tag" :class="r.status === 'same' ? '' : 'warn'">{{ statusLabel(r.status) }}</span></td>
                <td class="num mono">{{ qtyText(r.qtyA) }} → {{ qtyText(r.qtyB) }}</td>
                <td class="num mono">{{ priceText(r.unitPriceA) }} → {{ priceText(r.unitPriceB) }}</td>
                <td class="num mono">{{ yuan(r.amountA) }} → {{ yuan(r.amountB) }}</td>
                <td class="num" :class="r.qtyDeltaCents > 0 ? 'cell-up' : r.qtyDeltaCents < 0 ? 'cell-down' : ''">
                  {{ centsFmt(r.qtyDeltaCents) }}
                </td>
                <td class="num" :class="r.priceDeltaCents > 0 ? 'cell-up' : r.priceDeltaCents < 0 ? 'cell-down' : ''">
                  {{ centsFmt(r.priceDeltaCents) }}
                </td>
                <td class="num"><b :class="r.deltaCents > 0 ? 'cell-up' : r.deltaCents < 0 ? 'cell-down' : ''">{{ centsFmt(r.deltaCents) }}</b></td>
              </tr>
            </tbody>
          </table>
          <p class="muted" style="margin-top: 6px">{{ diffSum?.message }}</p>
        </div>
      </section>
    </div>

    <!-- 价目版本历史 + 存储说明 -->
    <section class="card no-print" style="margin-top: 14px">
      <header>
        <h2>价目版本（整份快照）与归档存储</h2>
        <span class="hint">改单价并在「材质与工艺」页点保存时，改动后的整份价目存为新版本</span>
      </header>
      <table>
        <thead>
          <tr><th>生效时间</th><th>类型</th><th>说明</th><th class="num">改动项</th><th>改动明细</th></tr>
        </thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id">
            <td class="mono">{{ fmtTime(v.effectiveAt) }}</td>
            <td><span class="tag" :class="v.reason === 'baseline' ? '' : 'ok'">{{ v.reason === 'baseline' ? '基线' : '调价' }}</span></td>
            <td>{{ v.note }}</td>
            <td class="num">{{ v.changes.length }}</td>
            <td class="muted">
              <span v-for="(c, i) in v.changes.slice(0, 6)" :key="c.key">
                {{ c.name }} {{ yuan(c.beforeCents) }}→{{ yuan(c.afterCents) }}元{{ i < Math.min(5, v.changes.length - 1) ? '；' : '' }}
              </span>
              <span v-if="v.changes.length > 6"> 等 {{ v.changes.length }} 项</span>
            </td>
          </tr>
        </tbody>
      </table>
      <ul class="notes" style="margin-top: 10px">
        <li>
          <b>为什么整份存：</b>价目只有约 30 个价项，每版约 2–4KB，一年按周调价也只占约 100–200KB；回查任何一单都是
          O(1) 直接取版，不用沿改动链回放。若改为「只存改动项 + 链式回放」，省的空间很小，但删错任一中间版本（或老数据缺基线），
          之后所有版本都会断链无法还原。
        </li>
        <li>
          <b>什么情况下退回去看不了原价：</b>① 本功能上线前的旧单没有 versionId（可按旧用量 × 当前价目重算，标注「旧单重算」，不盖原件）；
          ② 单据引用的版本快照在本机缺失（清空浏览器数据 / 换机器 / 手动删 localStorage），可重算并标注「版本缺失重算」；
          ③ 重算时旧条目在当前价目中也已删除，该行无法取价，会被列出且不计入重算合计。
        </li>
        <li>
          <b>单位与精度：</b>金额一律整数「分」（元 = 分 ÷ 100，两位小数展示）；计件单位（支/套/个/台/张/只/字）用量向上取整，
          ㎡/米保留 2 位小数；金额只在取整后用量上算 round(qty × 单价)。每次出单与比价都断言 Σ 分项差 = 总价差，不差一分。
        </li>
        <li>
          <b>兼容：</b>归档对象带 schema 版本号；旧存档缺字段按默认值补齐、未知字段原样保留，将来新增字段（schema 升级）旧程序也能打开。
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cell-up {
  color: var(--danger);
}
.cell-down {
  color: var(--ok);
}
.row-dim {
  opacity: 0.55;
}
@media print {
  .no-print {
    display: none !important;
  }
}
</style>
