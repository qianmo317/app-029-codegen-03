# 招牌字排版与材料清单（Signage Letter Layout）

广告店做门头招牌的排版与工艺核算工具：按门头宽度把字排开（字号、字距、留边都算准），
从**字体轮廓解析**出发做字形工艺分析（连通域笔画块、轮廓周长、最细笔画），
据此算出亚克力板用量、LED 模组数量与电源功率，最后出一张材料清单与报价单。

纯前端、**断网可用**、无后端依赖，所有数据（项目、预设）保存在浏览器本地。

## 技术栈

- Vue 3 + TypeScript + Vite（`<script setup>` 单文件组件，一个 `.vue` 里写完 template/script/style scoped）
- 手写 CSS（无 UI 组件库、无图表库、无游戏/物理引擎）
- 状态：Vue 自带 `ref / reactive / computed / watch`（无 Pinia / Vuex）
- 路由：`vue-router`（规格书第 6 节的 7 个页面）
- 字形几何：`opentype.js`（解析本地 TTF/OTF → glyph path → 转 mm 坐标）
- 字体、数据全部本地打包，运行期**不请求任何外网地址**（无 CDN、无外网字体）

## 启动与构建

```bash
npm install
npm run dev        # 开发：http://localhost:8109
npm run build      # 类型检查 + 生产构建（vue-tsc --noEmit && vite build）
npm run preview    # 预览生产构建：http://localhost:8109
npm run typecheck  # 仅类型检查
```

Docker（多阶段：node:20-alpine 构建 → nginx:1.27-alpine 运行）：

```bash
docker compose build          # 构建镜像（自测用）
docker compose up -d --build  # 启动：http://localhost:8109
curl http://localhost:8109/healthz
docker compose down
```

## 目录结构

```
app-029/
├── Dockerfile / docker-compose.yml / nginx.conf   # 容器化（端口 8109:80、/healthz、SPA 回退）
├── .dockerignore / .gitignore
├── index.html / vite.config.ts / tsconfig.json / package.json
├── public/fonts/                                  # 本地字体（子集化，随镜像打包）
│   ├── hei-400.otf / hei-700.otf                  # 黑体 Regular/Bold（Noto Sans SC）
│   ├── song-400.otf / song-700.otf                # 宋体 Regular/Bold（Noto Serif SC）
│   ├── kai-400.ttf                                # 楷体（Ma Shan Zheng）
│   ├── round-400.ttf                              # 圆体（ZCOOL QingKe HuangYou）
│   ├── art-400.ttf                                # 艺术体（ZCOOL KuaiLe）
│   └── FONT-LICENSES.txt                          # 字体授权（SIL OFL 1.1）
└── src/
    ├── main.ts / App.vue / router/index.ts / styles/main.css
    ├── data/           fonts.json（字库登记）、materials.json（材料与工艺参数库）、testchars.json（20 字基准）
    ├── logic/
    │   ├── geometry.ts        曲线离散化、环几何量、环绕数、形状最近距离（热路径用类型化数组）
    │   ├── glyphAnalysis.ts   轮廓→环→嵌套/连通域（扫描线并查集）→最细笔画（法线射线法）
    │   ├── fontLoader.ts      本地字体加载/解析/缓存（失败即提示「该字体不可用」）
    │   ├── layout.ts          排版引擎（视觉间距求解、两端对齐、自动字号、逐字微调）
    │   ├── led.ts             LED 与电源计算（含档位与多电源提示）
    │   ├── nesting.ts         亚克力板材分层装箱（guillotine）与利用率
    │   ├── materials.ts       材料清单（BOM，整数「分」）与多材质对照
    │   ├── archive.ts         报价归档：价目版本快照、出单冻结、逐项比价（用量差/单价差）、旧单重算
    │   ├── quote.ts           报价单/工艺卡导出（打印 PDF、.xls、CSV；冻结单取存档价）
    │   ├── selftest.ts        第 10 节验收自检（浏览器内真实运行全部断言，含 A11 归档用例）
    │   ├── testRunner.ts      连通域独立复算（光栅洪泛，与扫描线并查集互验）
    │   ├── store.ts           localStorage 项目与预设
    │   └── useSession.ts      页面会话（字体就绪 → 排版/BOM 派生、自动保存）
    ├── components/     PanelPreview.vue（按真实比例预览/标注/着色/布点）、SheetDiagram.vue（拼版图）
    └── views/          HomeView（新建+批量）、EditView（排版）、LightView、MaterialsView、
                        QuoteView、FontsView（本地字库）、PresetsView（材质工艺+验收自检）
```

页面路由：`/`、`/edit/:id`、`/light/:id`、`/materials/:id`、`/quote/:id`、`/archive`、`/fonts`、`/presets`。

## 关键实现说明

- **视觉间距**：字距 = 相邻两字形**轮廓最近距离**（不是 `advanceWidth`/文本框宽度相减，也不是包围盒相减）。
  界面同时列出「包围盒间距」与偏差，可直观看到两者不同。两端对齐时按视觉间距平均分配，同一行内极差 ≈ 0。
- **连通域（笔画块）**：对字形轮廓做扫描线 + 并查集标记填充区连通域；另用「环嵌套深度」独立推一遍块数做互验，
  自检中还有第二套**光栅洪泛填充**算法交叉验证，两套结果完全一致。
- **最细笔画**：沿轮廓法线做射线求交取局部宽度（环绕数判定材料侧），并对宽度序列做窗口最大值滤波，
  滤掉毛笔字收锋/尖角造成的非工艺性极小值；低于工艺下限（默认 8mm）时警告并**拦截报价**（确认后方可出单）。
- **LED 模组数**：`N = ceil(L / 模组间距)`（向上取整显式提示「因布点不足补足 N 个」），
  `额定功率 = N × 单模组功率 × 安全系数`，`电源功率 = 额定功率 / 效率` 再按标准档位（60/100/150/200/300/400W）向上取，
  超出档位提示「需多电源并联/分区供电」。公式在界面上同步展示，可复算。
- **板材拼版**：异形字按**外接矩形**下料（每个连通域一件，不用轮廓面积），料层横向贯通的一刀切分层装箱，
  输出板数、利用率与裁切清单；单件超板显式报错。
- **金额**：内部一律整数「分」，`Σ 明细金额 = 合计`（自检断言，无浮点误差）。
- **报价归档**：每次在「材质与工艺」页保存且**单价**有改动时，自动把**改后整份价目**存为一个新版本（改之前那一份已在归档中）；
  已出单据在出单当时冻结行明细与所引用的价目版本，之后再调价不影响。`/archive` 页可按客户/时间段检索单据、
  两单逐项比价（**用量差 / 单价差分开列，逐分对平**），旧单（无归档信息）可「按当时用量 × 当前价目」重算一版并标注，不覆盖原件。
- **性能**：字形几何按「本地单位（1000 em）」缓存，改字号只做线性缩放；字距求解按归一化间距缓存，
  调字距只重算受影响的相邻对；环绕数与射线求交复用 Y 分带边索引与复用缓冲区。

### 相对规格书数据模型的小幅扩展

字段以规格书第 7 节为准，为实现第 4/5 节功能补充了少量字段：`SignPanel.frameMm`（有效安装区边框）、
`CharItem.line / trackTouched / seq`（多行、逐字微调是否手动改过、字序）、`LayoutSettings.weight / strokeLimitMm /
trackRatio / marginRatio / lineGapRatio`、`Project` 增 `sheetId / ledModuleId / panelMaterialId`。

### 报价归档（价目版本 + 单据冻结 + 逐项比价）

- **路线选择：整份价目快照，而不是只存改动项（diff 链）。** 价目只有约 21–30 个价项，整份每版约 2–4KB，
  按每周调价一次、十年 ≈ 200KB，对 localStorage 可忽略；取价是 O(1)，单据记 `priceVersionId` 直接取当时那版。
  「只存改动项 + 链式回放」省的空间极小，却要回放全部前序版本，且删错/缺失任一中间版本就整条链断、无法还原——故不采用。
- **什么时候会退回去看不了原价（三种 fallback，界面都显式标注）：**
  1. 本功能上线前的旧单没有 `priceVersionId`：原单照显（行明细本身也冻结在单上），可按当时用量 × 当前价目**重算**一版，
     标 `legacy-recalc`，不盖原件；
  2. 单据引用的版本快照本机缺失（清空浏览器数据 / 换机器 / 手动删 localStorage）：可重算，标 `missing-version-recalc`；
  3. 重算时某价项在当前价目里也被删除：该行无法取价，列入 `missingRefs` 且金额不计入重算合计，绝不静默按 0 元算。
- **差异拆分（逐分对平）**：`Δ用量金额 = round((新用量−旧用量) × 旧单价)`，`Δ单价金额 = 行总差 − Δ用量金额`
  （用量与单价同时变动时的交叉项、四舍五入残差都归单价差），因此恒有 `Σ(用量差+单价差) = 新合计 − 旧合计`，不差一分。
- **单位与精度**：金额全程整数「分」（元 = 分 ÷ 100，展示 2 位小数）；计件单位（支/套/个/台/张/只/字）向上取整，
  ㎡/米保留 2 位小数；金额只在取整后用量上算 `round(qty × 单价)`；电源单价 = `round(分/W × 档位W)`。
  出单时断言 `Σ 行金额 = 合计`，不平直接拒绝归档。
- **本机存储**：`app029.prices.versions.v1`（价目版本）、`app029.issuedQuotes.v1`（已出单据）、`app029.archiveMeta.v1`（当前版本指针/单号序列），
  全部 localStorage，无网络。对象带 `schema: 1`，解析时缺字段补默认、未知字段保留，将来新增字段（schema 升级）旧存档也能打开。
- 导出（报价单 `.xls` / 打印 PDF、材料工艺卡 CSV）一律取**当天生效版本**；归档页从冻结单据再导出时用的是**存档行金额**，不重新算价。
- 纯逻辑端到端验证（不依赖浏览器/字体，30 个断言）：`npm run verify:archive`（`scripts/verify-archive.mjs`）。



字体均为可商用开源字体（**SIL Open Font License 1.1**），见 [public/fonts/FONT-LICENSES.txt](public/fonts/FONT-LICENSES.txt)：

| 用途 | 字体 | 授权 |
| --- | --- | --- |
| 黑体 | Noto Sans SC（Regular/Bold） | SIL OFL 1.1 |
| 宋体 | Noto Serif SC（Regular/Bold） | SIL OFL 1.1 |
| 楷体 | Ma Shan Zheng | SIL OFL 1.1 |
| 圆体 | ZCOOL QingKe HuangYou | SIL OFL 1.1 |
| 艺术体 | ZCOOL KuaiLe | SIL OFL 1.1 |

字体已**子集化**为「GB2312 一级汉字 3755 字 + 常用标点 + ASCII」（每款约 0.7–3MB，合计约 9.5MB），
超出字集的字会明确提示「该字符不在当前字体中」，**不会静默退化**。断网环境下全部功能可用。

## 验收结果（规格书第 10 节）

`/presets` 页「验收自检」按钮在浏览器中真实运行全部断言；以下为本机实测结果（生产构建，2026-09-21）。

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| 排版正确性 | 通过 | 3000×800 门头（边框 60）6 字自动字号 **460mm**，占宽 2649.8mm，左/右留边 115.1/115.1mm，**差 0mm ≤ 1mm**；字号 600mm 时超出 576.3mm，建议字号 460mm，采用后占宽 2649.8mm、占高 429.2mm **不再超出** |
| 视觉间距 | 通过 | 两端对齐后相邻字视觉间距 148.99/148.99/148.99/148.99/148.99mm，**极差 0mm ≤ 0.5mm**；同排按包围盒算则为 140.45/144.58/142.99/137.79/148.99mm，极差 11.2mm（证明用的是轮廓距离） |
| 字形分析（20 字） | 通过 | 连通域：一1 十1 赢6 疆7 口1 日1 田1 回2 国3 目1 川3 三3 王1 月1 中1 人1 大1 小3 山1 上1，与人工核对一致；最细笔画与基准误差 ≤ 0.5mm；另附独立截面测量：一 32.93 vs 32.80mm（墨迹高度）、三 30.52 vs 30.00mm、目 30.97 vs 30.00mm |
| 最细笔画拦截 | 通过 | 工艺下限设为 40mm 时 6 个字触发警告（如「牌」8.7mm@300mm），材料清单 `blocked=true` 且列出拦截理由；确认风险后 `blocked=false` 可出报价 |
| LED 计算 | 通过 | L=1234mm/间距150 → N=9（理论 8.23，补足 1）；额定 9×0.72×1.2=7.78W；9.1W/0.85 → **60W**；L=15000 → N=100、86.4W → 101.6W → **150W**；L=60000/间距120 → N=500、864W → 1016.5W → **400W×3 台** 并提示多电源并联 |
| 板材拼版 | 通过 | 4×(500×400) → 1 张 26.87%；3×(1200×800) → 1 张 96.75%；10×(600×600) → 2 张 60.47%（均与手工核算一致） |
| 金额整数分 | 通过 | Σ 明细 = 合计（示例 1492.43 元 = 149243 分），全部为整数「分」 |
| 断网可用 + 性能 | 通过 | 12 字（招牌发光字制作安装工程部）清空字形缓存后排版 + 字形分析 **20 / 22 / 20ms（取最优 20ms ＜ 200ms）**；字体全部为同源静态资源 `fonts/*.otf`，无外网请求 |
| 独立复算 | 通过 | 20 字连通域：扫描线并查集 vs 光栅洪泛填充结果完全一致 |

浏览器实测输出见上方运行记录：第 10 节 10 项断言全部 `PASS`（页面标签「全部通过」），控制台无报错。