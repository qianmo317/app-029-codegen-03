<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { findFont } from '../logic/fontLoader'
import {
  buildQuoteDoc,
  exportQuoteXls,
  exportProcessCardCsv,
  exportIssuedQuoteXls,
  issuedRows
} from '../logic/quote'
import { assertBomSum, buildBom, compareMaterials, yuan } from '../logic/materials'
import { alignLabel, mountingLabel } from '../logic/layout'
import { getProject, saveProject } from '../logic/store'
import {
  currentPriceVersion,
  effectiveVersionOn,
  issueQuote,
  listIssuedQuotes,
  quoteVersionMissing,
  type IssuedQuote
} from '../logic/archive'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)
const mode = ref<'quote' | 'card'>('quote')
const printed = ref(false)
const issueMsg = ref('')
const docsTick = ref(0)

const bom = computed(() =>
  project.value && layout.value ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value }) : null
)
const fontLabel = computed(() => {
  const p = project.value
  if (!p) return ''
  const f = findFont(p.layout.settings.fontId)
  return f ? `${f.label}（${f.family}）` : ''
})
const doc = computed(() =>
  project.value && layout.value && bom.value ? buildQuoteDoc(project.value, layout.value, bom.value, fontLabel.value) : null
)
const sum = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)

const curVersion = computed(() => {
  void docsTick.value
  return currentPriceVersion()
})
const todayVersion = computed(() => {
  void docsTick.value
  return effectiveVersionOn(new Date())
})
const versionDrift = computed(() => curVersion.value?.id !== todayVersion.value?.id)

const issuedDocs = computed<IssuedQuote[]>(() => {
  void docsTick.value
  if (!project.value) return []
  return listIssuedQuotes().filter((d) => d.projectId === project.value!.id)
})

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

function saveCustomer(v: string): void {
  if (project.value) {
    project.value.customer = v
    saveProject(project.value)
  }
}

function issue(): void {
  if (!project.value || !layout.value || !bom.value) return
  if (bom.value.blocked) return
  const d = issueQuote({
    project: project.value,
    materials: bom.value.materials,
    totalCents: bom.value.totalCents,
    snapshot: {
      projectName: project.value.name,
      customer: project.value.customer ?? '',
      panelText: doc.value?.panelText ?? '',
      fontText: doc.value?.fontText ?? '',
      layoutText: doc.value?.layoutText ?? '',
      notes: doc.value?.notes ?? []
    }
  })
  issueMsg.value = `已归档：单号 ${d.no}，取价版本生效日 ${fmtDate(d.priceEffectiveAt)}；之后再调价不影响本单。`
  docsTick.value++
}

function printNow(): void {
  printed.value = true
  window.print()
}

function toExcel(): void {
  if (project.value && layout.value && bom.value) {
    exportQuoteXls(project.value, layout.value, bom.value, fontLabel.value, compare.value)
  }
}

function toCsv(): void {
  if (project.value && layout.value && bom.value) {
    exportProcessCardCsv(project.value, layout.value, bom.value, fontLabel.value)
  }
}

function exportIssued(d: IssuedQuote): void {
  if (!project.value) return
  exportIssuedQuoteXls(d, issuedRows(d), {
    customer: d.snapshot.customer,
    projectName: d.snapshot.projectName,
    panelText: d.snapshot.panelText,
    fontText: d.snapshot.fontText,
    layoutText: d.snapshot.layoutText
  })
}

function recalcKindLabel(d: IssuedQuote): string {
  if (d.recalcKind === 'legacy-recalc') return '旧单重算'
  if (d.recalcKind === 'missing-version-recalc') return '版本缺失重算'
  return '原件'
}
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div class="row no-print" style="margin-bottom: 12px">
        <button class="primary" :disabled="bom?.blocked" @click="printNow">打印 / 导出 PDF</button>
        <button :disabled="bom?.blocked" @click="toExcel">导出 Excel（.xls）</button>
        <button :disabled="bom?.blocked" @click="toCsv">导出工艺卡（CSV）</button>
        <button class="primary" :disabled="bom?.blocked" @click="issue">出单并归档（冻结本单价格）</button>
        <div class="tabs" style="margin: 0 0 0 12px; border: none">
          <button :class="{ active: mode === 'quote' }" @click="mode = 'quote'">报价单</button>
          <button :class="{ active: mode === 'card' }" @click="mode = 'card'">工艺卡</button>
        </div>
        <router-link to="/archive"><button>报价归档</button></router-link>
      </div>

      <div v-if="issueMsg" class="banner ok no-print">{{ issueMsg }}</div>

      <div class="card no-print" style="margin-bottom: 12px">
        <div class="field" style="margin: 0">
          <label>客户名称（归档按客户检索）</label>
          <div class="ctl">
            <input type="text" :value="project.customer ?? ''" style="width: 240px" placeholder="如：张三便利店" @change="saveCustomer(($event.target as HTMLInputElement).value)" />
          </div>
        </div>
        <p class="muted" style="margin: 6px 0 0">
          当前取价：<b>{{ fmtDate(curVersion?.effectiveAt ?? null) }}</b> 生效的价目版本
          <span class="mono">({{ curVersion?.id.slice(-6) ?? '无版本' }})</span>
          <span v-if="versionDrift" class="tag warn">当天生效版本与已提交版本不一致</span>
          ；点「出单并归档」后本单即按该版价格冻结。
        </p>
      </div>

      <div v-if="bom?.blocked" class="banner bad no-print">
        <b>工艺风险拦截：</b>{{ bom.blockReasons.join('；') }}
        <button class="primary" style="margin-left: 8px" @click="ack = true">已确认风险，继续出报价</button>
      </div>
      <div v-else-if="ack" class="banner warn no-print">已确认工艺风险：最细笔画低于工艺下限的字符按加粗/换字体处理后再下单。</div>

      <section v-if="doc && bom && layout" class="card">
        <template v-if="mode === 'quote'">
          <header>
            <h1>{{ doc.title }}</h1>
            <span class="hint">报价日期 {{ doc.date }} · 有效期至 {{ doc.validUntil }}</span>
          </header>
          <p class="banner info" style="margin: 8px 0">{{ doc.priceLine }}</p>
          <div class="grid cols-3" style="margin-bottom: 10px">
            <div>
              <h3>客户</h3>
              <p class="mono">{{ project.customer || '（未填）' }}</p>
            </div>
            <div>
              <h3>项目</h3>
              <p class="mono">{{ doc.projectName }}</p>
            </div>
            <div>
              <h3>门头</h3>
              <p class="mono">{{ doc.panelText }}</p>
            </div>
          </div>
          <p class="mono muted">字体：{{ doc.fontText }}</p>
          <p class="mono muted">排版结果：{{ doc.layoutText }}</p>
          <table style="margin-top: 8px">
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
              <tr v-for="(r, i) in doc.rows" :key="i">
                <td>{{ r.group }}</td>
                <td>{{ r.spec }}</td>
                <td class="num">{{ r.qty }}</td>
                <td>{{ r.unit }}</td>
                <td class="num">{{ r.unitPrice }}</td>
                <td class="num">{{ r.amount }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="5">合计</td>
                <td class="num">¥{{ doc.total }}</td>
              </tr>
            </tfoot>
          </table>
          <h3 style="margin-top: 12px">工艺说明</h3>
          <ul class="notes">
            <li v-for="(n, i) in doc.notes" :key="i">{{ n }}</li>
          </ul>
          <h3 style="margin-top: 12px">多材质对照（元）</h3>
          <table>
            <thead>
              <tr><th>材质</th><th class="num">面板</th><th class="num">LED+电源</th><th class="num">配件+加工</th><th class="num">合计</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in compare" :key="c.id">
                <td>{{ c.name }}</td>
                <td class="num">{{ yuan(c.panelCents) }}</td>
                <td class="num">{{ yuan(c.ledCents + c.psuCents) }}</td>
                <td class="num">{{ yuan(c.accessoryCents + c.laborCents) }}</td>
                <td class="num"><b>{{ yuan(c.totalCents) }}</b></td>
              </tr>
            </tbody>
          </table>
          <p class="muted" style="margin-top: 10px">{{ doc.footer }}</p>
          <p class="muted">{{ sum?.message }}</p>
        </template>

        <template v-else>
          <header>
            <h1>招牌字工艺卡</h1>
            <span class="hint">{{ project.name }} · {{ doc.date }}</span>
          </header>
          <div class="kv-list">
            <span class="muted">客户</span><span>{{ project.customer || '（未填）' }}</span>
            <span class="muted">门头</span><span class="mono">{{ doc.panelText }}</span>
            <span class="muted">安装方式</span><span>{{ mountingLabel(project.layout.panel.mounting) }}</span>
            <span class="muted">字体</span><span>{{ fontLabel }} · 字重 {{ project.layout.settings.weight }} · 字号 {{ layout.sizeMm }}mm</span>
            <span class="muted">对齐</span><span>{{ alignLabel(project.layout.settings.align) }}</span>
            <span class="muted">排版</span><span class="mono">{{ doc.layoutText }}</span>
            <span class="muted">LED</span>
            <span class="mono">
              布点 {{ bom.led.perimeterTotalMm }}mm · 模组 {{ bom.led.modules }} 只 · 额定 {{ bom.led.ratedW }}W · 电源
              {{ bom.led.suggestedPsu }}
            </span>
            <span class="muted">亚克力</span>
            <span class="mono">{{ bom.sheet.spec }} · {{ bom.nesting.sheetCount }} 张 · 利用率 {{ (bom.nesting.utilization * 100).toFixed(1) }}%</span>
          </div>

          <h3 style="margin-top: 12px">字形工艺分析</h3>
          <table>
            <thead>
              <tr>
                <th>字符</th>
                <th class="num">字号 mm</th>
                <th class="num">笔画块</th>
                <th class="num">外轮廓周长 mm</th>
                <th class="num">最细笔画 mm</th>
                <th>警告</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(g, i) in layout.glyphs" :key="i">
                <td>{{ g.char }}</td>
                <td class="num">{{ g.sizeMm }}</td>
                <td class="num">{{ g.strokeBlocks }}</td>
                <td class="num">{{ g.contours.filter((c) => !c.isHole).reduce((s, c) => s + c.perimeterMm, 0).toFixed(1) }}</td>
                <td class="num" :class="{ 'cell-bad': g.minStrokeMm < project.layout.settings.strokeLimitMm }">{{ g.minStrokeMm }}</td>
                <td class="muted">{{ g.warnings.join('；') || '—' }}</td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin-top: 12px">裁切清单</h3>
          <table>
            <thead>
              <tr><th>料件</th><th class="num">宽 mm</th><th class="num">高 mm</th><th class="num">数量</th></tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in bom.cutList" :key="i">
                <td>{{ c.label }}</td>
                <td class="num">{{ c.wMm }}</td>
                <td class="num">{{ c.hMm }}</td>
                <td class="num">{{ c.count }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted" style="margin-top: 10px">
            工艺要求：异形面板按外接矩形下料；笔画块数量决定分件数量；最细笔画低于工艺下限的字符需加粗或换字体；LED 布点沿外轮廓均匀分布。
          </p>
        </template>
      </section>

      <section class="card no-print" style="margin-top: 14px">
        <header>
          <h2>本项目已归档单据（{{ issuedDocs.length }}）</h2>
          <span class="hint">原件金额冻结；调价不影响。可去「报价归档」页按客户/时间检索与两单比价</span>
        </header>
        <p class="muted" v-if="issuedDocs.length === 0">还没有出过单。确认上面价格后点「出单并归档」。</p>
        <table v-else>
          <thead>
            <tr><th>单号</th><th>客户</th><th>出单时间</th><th>价目生效</th><th class="num">合计（元）</th><th>类型</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="d in issuedDocs" :key="d.id">
              <td class="mono">{{ d.no }}</td>
              <td>{{ d.snapshot.customer || '—' }}</td>
              <td class="muted">{{ fmtTime(d.issuedAt) }}</td>
              <td class="muted">{{ fmtDate(d.priceEffectiveAt) }}</td>
              <td class="num"><b>{{ yuan(d.totalCents) }}</b></td>
              <td>
                <span class="tag" :class="d.recalcKind === 'original' ? 'ok' : 'warn'">{{ recalcKindLabel(d) }}</span>
                <span v-if="quoteVersionMissing(d)" class="tag bad">版本缺失</span>
              </td>
              <td>
                <router-link :to="`/archive?doc=${d.id}`"><button>查看/比价</button></router-link>
                <button @click="exportIssued(d)">导出 Excel</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="muted no-print" v-if="printed">已触发打印对话框（选择「另存为 PDF」即导出报价单 PDF）。</p>
    </template>
  </div>
</template>

<style scoped>
.cell-bad {
  color: var(--danger);
  font-weight: 700;
}
</style>
