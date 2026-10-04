<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { findFont } from '../logic/fontLoader'
import { buildQuoteDoc, exportQuoteXls, exportProcessCardCsv } from '../logic/quote'
import { assertBomSum, buildBom, compareMaterials, yuan } from '../logic/materials'
import { alignLabel, mountingLabel } from '../logic/layout'
import { getProject } from '../logic/store'
import { ensureCurrentVersion, fmtDateTime, issueQuoteDoc, listPriceVersions, saveQuoteDoc, type QuoteDoc as ArchivedQuoteDoc } from '../logic/archive'
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
const issued = ref<ArchivedQuoteDoc | null>(null)
const issueError = ref('')
const versionTick = ref(0)

const customer = computed({
  get: () => loaded.value?.customer ?? '',
  set: (v: string) => {
    if (loaded.value) loaded.value.customer = v
  }
})

const bom = computed(() =>
  project.value && layout.value ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value }) : null
)
const fontLabel = computed(() => {
  const p = project.value
  if (!p) return ''
  const f = findFont(p.layout.settings.fontId)
  return f ? `${f.label}（${f.family}）` : ''
})
/** 当前生效的价目版本说明（只读；出单/导出时会确保版本存在） */
const priceNote = computed(() => {
  void versionTick.value
  const vs = listPriceVersions()
  const latest = vs[vs.length - 1]
  return latest ? `第 ${latest.seq} 版价目（${fmtDateTime(latest.createdAt)} 生效）` : ''
})
const doc = computed(() =>
  project.value && layout.value && bom.value ? buildQuoteDoc(project.value, layout.value, bom.value, fontLabel.value, priceNote.value) : null
)
const sum = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)

/** 导出/出单前确保「当天生效的价目版本」已归档，并刷新界面上的版本说明 */
function ensureVersion(): void {
  ensureCurrentVersion(preset.value)
  versionTick.value++
}

function printNow(): void {
  ensureVersion()
  printed.value = true
  window.print()
}

function toExcel(): void {
  if (project.value && layout.value && bom.value) {
    ensureVersion()
    exportQuoteXls(project.value, layout.value, bom.value, fontLabel.value, compare.value, priceNote.value)
  }
}

function toCsv(): void {
  if (project.value && layout.value && bom.value) {
    ensureVersion()
    exportProcessCardCsv(project.value, layout.value, bom.value, fontLabel.value, priceNote.value)
  }
}

/** 出单归档：把当前报价连同「当天生效的价目版本」一起冻结，之后改价不影响它 */
function issue(): void {
  issueError.value = ''
  if (!project.value || !bom.value || bom.value.blocked) return
  const archived = issueQuoteDoc(project.value, bom.value, preset.value)
  if (!saveQuoteDoc(archived)) {
    issueError.value = '归档写入失败：本机存储空间不足，请先在「报价归档」页清理旧版本后再试。'
    return
  }
  issued.value = archived
  versionTick.value++
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
        <div class="tabs" style="margin: 0 0 0 12px; border: none">
          <button :class="{ active: mode === 'quote' }" @click="mode = 'quote'">报价单</button>
          <button :class="{ active: mode === 'card' }" @click="mode = 'card'">工艺卡</button>
        </div>
        <span class="muted">打印时只输出下方单据（页眉导航自动隐藏）</span>
      </div>

      <div class="row no-print" style="margin-bottom: 12px">
        <label class="muted">客户名称</label>
        <input type="text" v-model="customer" placeholder="归档后按客户检索" style="width: 160px" />
        <button class="primary" :disabled="bom?.blocked" @click="issue">出单归档（冻结当前价目）</button>
        <router-link to="/archive"><button>报价归档 / 历史单据对比 →</button></router-link>
        <span class="muted" v-if="priceNote">当前取价：{{ priceNote }}</span>
        <span class="muted" v-else>尚未建立价目归档（首次改价或出单时自动建立）</span>
      </div>
      <div v-if="issued" class="banner ok no-print">
        已归档为单据 {{ issued.id }}（{{ fmtDateTime(issued.issuedAt) }}，合计 ¥{{ yuan(issued.totalCents) }}）；
        之后改价不影响该单，可到「报价归档」页按客户/时间段查询并与其他单据逐项对比。
      </div>
      <div v-if="issueError" class="banner bad no-print">{{ issueError }}</div>

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
          <div class="grid cols-3" style="margin-bottom: 10px">
            <div>
              <h3>项目</h3>
              <p class="mono">{{ doc.projectName }}</p>
            </div>
            <div>
              <h3>门头</h3>
              <p class="mono">{{ doc.panelText }}</p>
            </div>
            <div>
              <h3>字体与排版</h3>
              <p class="mono">{{ doc.fontText }}</p>
            </div>
          </div>
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