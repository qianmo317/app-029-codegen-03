<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  deleteQuoteDoc,
  diffQuoteDocs,
  fmtDateTime,
  listPriceVersions,
  listQuoteDocs,
  recomputeQuoteDoc,
  saveQuoteDoc,
  type PriceGroup,
  type QuoteDoc
} from '../logic/archive'
import { loadPreset } from '../logic/store'
import { yuan } from '../logic/materials'
import { exportQuoteDocCsv } from '../logic/quote'

const versions = ref(listPriceVersions())
const docs = ref(listQuoteDocs())
const msg = ref('')
const msgBad = ref(false)

const filterCustomer = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const pickA = ref('')
const pickB = ref('')
const showAllLines = ref(false)
const expanded = ref('')

const groupLabels: Record<PriceGroup, string> = {
  sheet: '亚克力板材',
  led: 'LED 模组',
  psu: '电源',
  consumable: '胶与配件',
  labor: '加工费',
  panelMaterial: '多材质对照'
}

const priceKeyLabels: Record<string, string> = {
  unit: '单价',
  perW: '每 W',
  perM2: '每 ㎡',
  perM: '每米周长',
  perChar: '每字'
}

function refresh(): void {
  versions.value = listPriceVersions()
  docs.value = listQuoteDocs()
}

function say(text: string, bad = false): void {
  msg.value = text
  msgBad.value = bad
}

const storageBytes = computed(() => {
  try {
    return (localStorage.getItem('app029.priceVersions.v1')?.length ?? 0) + (localStorage.getItem('app029.quoteDocs.v1')?.length ?? 0)
  } catch {
    return 0
  }
})

const filteredDocs = computed(() => {
  const kw = filterCustomer.value.trim().toLowerCase()
  const from = filterFrom.value ? new Date(`${filterFrom.value}T00:00:00`).getTime() : null
  const to = filterTo.value ? new Date(`${filterTo.value}T23:59:59`).getTime() : null
  return docs.value.filter((d) => {
    if (kw && !`${d.customer} ${d.projectName}`.toLowerCase().includes(kw)) return false
    if (from !== null && d.issuedAt < from) return false
    if (to !== null && d.issuedAt > to) return false
    return true
  })
})

const docA = computed(() => docs.value.find((d) => d.id === pickA.value) ?? null)
const docB = computed(() => docs.value.find((d) => d.id === pickB.value) ?? null)
const diff = computed(() => (docA.value && docB.value ? diffQuoteDocs(docA.value, docB.value) : null))
const diffLines = computed(() => {
  const d = diff.value
  if (!d) return []
  return showAllLines.value ? d.lines : d.lines.filter((l) => l.status !== 'same')
})

function versionLabel(id: string | null): string {
  if (!id) return '无归档（旧单）'
  const v = versions.value.find((x) => x.id === id)
  return v ? `第 ${v.seq} 版（${fmtDateTime(v.createdAt)}）` : `版本 ${id}（已清理）`
}

function signed(cents: number): string {
  return `${cents > 0 ? '+' : ''}${yuan(cents)}`
}

const statusLabels: Record<string, string> = { same: '不变', changed: '变动', added: '新增', removed: '取消' }

function removeDoc(id: string): void {
  deleteQuoteDoc(id)
  if (pickA.value === id) pickA.value = ''
  if (pickB.value === id) pickB.value = ''
  refresh()
  say(`单据 ${id} 已删除`)
}

function recompute(doc: QuoteDoc): void {
  if (doc.rows.length === 0) {
    say('该旧单没有明细行（既无归档价目也没存用量），无法按用量重算——只能看到原单合计。', true)
    return
  }
  const r = recomputeQuoteDoc(doc, loadPreset())
  if (!saveQuoteDoc(r)) {
    say('归档写入失败：本机存储空间不足，请先在「价目版本」清理旧版本后再试。', true)
    return
  }
  refresh()
  pickA.value = doc.id
  pickB.value = r.id
  say(`已按当前价目重算生成新单 ${r.id}（标注「重算」，原单 ${doc.id} 保留不变），下方已自动选中两单对比。`)
}

function exportCsv(doc: QuoteDoc): void {
  exportQuoteDocCsv(doc, versionLabel(doc.priceVersionId))
  say(`已导出 ${doc.id}（按单据冻结的价目取价）`)
}
</script>

<template>
  <div class="page">
    <div v-if="msg" class="banner no-print" :class="msgBad ? 'bad' : 'ok'">{{ msg }}</div>

    <section class="card">
      <header>
        <h1>价目版本（改价留痕）</h1>
        <span class="hint">共 {{ versions.length }} 版 · 归档占用 {{ (storageBytes / 1024).toFixed(1) }} KB（localStorage 上限约 5MB）</span>
      </header>
      <p class="muted" style="margin-top: 0">
        每次材料/加工单价改动：先把当时那一份价目存下来，改完再存一份新的。<b>存储策略选「每版存整份价目」</b>——
        一份仅几十条单价（约 2–4KB），回查直接读那一版（O(1)，不用逐条重放差量）；某版损坏只影响该版。
        若只存改动项（差量链），任何一条差量丢失，其后的所有版本都重建不出来。
        本策略看不了的情形：① 本机存储写满（约 5MB）后新版本写不进，会提示「归档写入失败」，需清理旧版本；
        ② 清空浏览器站点数据则全部归档丢失。
      </p>
      <p class="muted" v-if="versions.length === 0">还没有价目归档：在「材质与工艺」页改单价并保存，或在报价单页出单，都会自动建立版本。</p>
      <table v-else>
        <thead>
          <tr><th>版本</th><th>生效时间</th><th>说明</th><th>单价改动</th><th></th></tr>
        </thead>
        <tbody>
          <template v-for="v in [...versions].reverse()" :key="v.id">
            <tr>
              <td><b>第 {{ v.seq }} 版</b></td>
              <td class="mono">{{ fmtDateTime(v.createdAt) }}</td>
              <td class="muted">{{ v.reason }}</td>
              <td>
                <span v-if="v.changes.length === 0" class="muted">（基线，无改动）</span>
                <ul v-else class="notes" style="margin: 0">
                  <li v-for="(c, i) in v.changes" :key="i" class="mono" style="font-size: 12px">
                    {{ c.label }} · {{ priceKeyLabels[c.key] ?? c.key }}：
                    {{ c.fromCents === null ? '（新增）' : `${yuan(c.fromCents)} 元` }} →
                    {{ c.toCents === null ? '（删除）' : `${yuan(c.toCents)} 元` }}
                  </li>
                </ul>
              </td>
              <td><button @click="expanded = expanded === v.id ? '' : v.id">{{ expanded === v.id ? '收起' : '整份价目' }}</button></td>
            </tr>
            <tr v-if="expanded === v.id">
              <td colspan="5">
                <table>
                  <thead>
                    <tr><th>分组</th><th>条目</th><th>价格（元）</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="e in v.book.entries" :key="e.id">
                      <td>{{ groupLabels[e.group] ?? e.group }}</td>
                      <td>{{ e.label }}</td>
                      <td class="mono">
                        <span v-for="(val, key) in e.prices" :key="key" style="margin-right: 10px">
                          {{ priceKeyLabels[key] ?? key }} {{ yuan(val) }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <section class="card" style="margin-top: 14px">
      <header>
        <h2>历史单据</h2>
        <span class="hint">{{ filteredDocs.length }} / {{ docs.length }} 张</span>
      </header>
      <div class="row no-print" style="margin-bottom: 10px">
        <input type="text" v-model="filterCustomer" placeholder="按客户 / 项目名检索" style="width: 180px" />
        <input type="date" v-model="filterFrom" />
        <span class="muted">至</span>
        <input type="date" v-model="filterTo" />
        <span class="muted">选 A、B 两张单据，下方逐项对比</span>
      </div>
      <p class="muted" v-if="docs.length === 0">还没有归档单据：到「报价单」页点「出单归档」。</p>
      <table v-else>
        <thead>
          <tr>
            <th style="width: 34px">A</th>
            <th style="width: 34px">B</th>
            <th>出单时间</th>
            <th>客户</th>
            <th>项目</th>
            <th>取价版本</th>
            <th>来源</th>
            <th class="num">合计（元）</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in filteredDocs" :key="d.id">
            <td><input type="radio" name="pickA" :value="d.id" v-model="pickA" /></td>
            <td><input type="radio" name="pickB" :value="d.id" v-model="pickB" /></td>
            <td class="mono">{{ fmtDateTime(d.issuedAt) }}</td>
            <td>{{ d.customer || '—' }}</td>
            <td>
              {{ d.projectName }}
              <div class="muted mono" style="font-size: 11px">{{ d.id }}</div>
            </td>
            <td class="muted">{{ versionLabel(d.priceVersionId) }}</td>
            <td>
              <span v-if="d.source === 'recomputed'" class="tag bad">重算</span>
              <span v-else class="tag ok">正式出单</span>
            </td>
            <td class="num">{{ yuan(d.totalCents) }}</td>
            <td>
              <div class="row">
                <button @click="exportCsv(d)">导出 CSV</button>
                <button :disabled="d.rows.length === 0" :title="d.rows.length === 0 ? '该旧单没有明细行，无法重算' : '按原单用量 × 当前价目重算一版（原单保留）'" @click="recompute(d)">
                  按当前价目重算
                </button>
                <button class="danger" @click="removeDoc(d.id)">删</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="diff && docA && docB" class="card" style="margin-top: 14px">
      <header>
        <h2>报价对比：A → B</h2>
        <span class="hint">差值分解到「用量差 / 单价差」，合计配平到分</span>
      </header>
      <div class="kv-list" style="margin-bottom: 10px">
        <span class="muted">A（基准）</span>
        <span class="mono">{{ docA.projectName }} · {{ docA.customer || '—' }} · {{ fmtDateTime(docA.issuedAt) }} · {{ versionLabel(docA.priceVersionId) }} · ¥{{ yuan(docA.totalCents) }}</span>
        <span class="muted">B（对照）</span>
        <span class="mono">{{ docB.projectName }} · {{ docB.customer || '—' }} · {{ fmtDateTime(docB.issuedAt) }} · {{ versionLabel(docB.priceVersionId) }} · ¥{{ yuan(docB.totalCents) }}</span>
        <span class="muted">总价差</span>
        <span class="mono">
          <b>{{ signed(diff.amountDiffTotalCents) }} 元</b> = 用量差 {{ signed(diff.qtyEffectTotalCents) }} + 单价差 {{ signed(diff.priceEffectTotalCents) }}
          <span class="tag" :class="diff.balanced ? 'ok' : 'bad'" style="margin-left: 8px">
            {{ diff.balanced ? '配平：一分不差' : '不配平（旧单数据不完整）' }}
          </span>
        </span>
      </div>
      <div class="row no-print" style="margin-bottom: 8px">
        <label class="muted"><input type="checkbox" v-model="showAllLines" /> 显示未变动的行</label>
        <span class="muted">差值口径：用量差 = 新用量 × 旧单价 − 旧金额；单价差 = 新金额 − 新用量 × 旧单价（整数分，二者之和恒等于该行金额差）</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>项目</th>
            <th>状态</th>
            <th class="num">用量 A→B</th>
            <th class="num">单价 A→B（元）</th>
            <th class="num">金额 A→B（元）</th>
            <th class="num">用量差（元）</th>
            <th class="num">单价差（元）</th>
            <th class="num">差值小计（元）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in diffLines" :key="l.key">
            <td>{{ l.spec }}<span class="muted" v-if="l.unit">（{{ l.unit }}）</span></td>
            <td><span class="tag" :class="l.status === 'same' ? '' : l.status === 'changed' ? 'bad' : 'ok'">{{ statusLabels[l.status] }}</span></td>
            <td class="num mono">{{ l.qtyA ?? '—' }} → {{ l.qtyB ?? '—' }}</td>
            <td class="num mono">{{ l.unitPriceA === null ? '—' : yuan(l.unitPriceA) }} → {{ l.unitPriceB === null ? '—' : yuan(l.unitPriceB) }}</td>
            <td class="num mono">{{ yuan(l.amountA) }} → {{ yuan(l.amountB) }}</td>
            <td class="num mono">{{ signed(l.qtyEffectCents) }}</td>
            <td class="num mono">{{ signed(l.priceEffectCents) }}</td>
            <td class="num mono"><b>{{ signed(l.qtyEffectCents + l.priceEffectCents) }}</b></td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="5">合计（{{ diffLines.length }} 行）</td>
            <td class="num mono">{{ signed(diff.qtyEffectTotalCents) }}</td>
            <td class="num mono">{{ signed(diff.priceEffectTotalCents) }}</td>
            <td class="num mono"><b>{{ signed(diff.amountDiffTotalCents) }}</b></td>
          </tr>
        </tfoot>
      </table>
    </section>
    <section v-else class="card" style="margin-top: 14px">
      <p class="muted" style="margin: 0">在上方单据列表的 A / B 列各选一张，即可逐项比出两次报价差在哪几条、差多少钱（用量差与单价差分开列）。</p>
    </section>
  </div>
</template>
