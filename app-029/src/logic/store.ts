/**
 * 本地存储（无后端）：项目、预设、字库偏好。
 * 只落 localStorage，不发起任何网络请求。
 */

import materialsData from '../data/materials.json'
import type { Preset } from './materials'
import { defaultProject } from './layout'
import type { Project } from './types'
import { commitPresetPrices, ensureBaseline, type PriceVersion } from './archive'

const KEY_PROJECTS = 'app029.projects.v1'
const KEY_PRESET = 'app029.preset.v1'
const KEY_PREFS = 'app029.prefs.v1'

export interface Prefs {
  defaultFontId: string
  defaultWeight: number
  nightPreview: boolean
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储空间不足等异常：忽略写入失败，不影响当前会话使用
  }
}

export function listProjects(): Project[] {
  const list = readJson<Project[]>(KEY_PROJECTS, [])
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null
}

export function saveProject(p: Project): void {
  const list = listProjects()
  const idx = list.findIndex((x) => x.id === p.id)
  const next = { ...p, updatedAt: Date.now() }
  if (idx >= 0) list[idx] = next
  else list.unshift(next)
  writeJson(KEY_PROJECTS, list)
}

export function deleteProject(id: string): void {
  writeJson(
    KEY_PROJECTS,
    listProjects().filter((p) => p.id !== id)
  )
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = newId()
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  saveProject(copy)
  return copy
}

export function newId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createProject(name: string, panel?: { wMm?: number; hMm?: number; frameMm?: number }): Project {
  const p = defaultProject(newId(), panel)
  p.name = name
  const prefs = loadPrefs()
  p.layout.settings.fontId = prefs.defaultFontId
  p.layout.settings.weight = prefs.defaultWeight
  saveProject(p)
  return p
}

function mergePreset(base: Preset, patch: Partial<Preset>): Preset {
  const out: Preset = JSON.parse(JSON.stringify(base))
  if (patch.process) out.process = { ...out.process, ...patch.process }
  if (patch.acrylicSheets) out.acrylicSheets = patch.acrylicSheets
  if (patch.ledModules) out.ledModules = patch.ledModules
  if (patch.psu) out.psu = { ...out.psu, ...patch.psu }
  if (patch.consumables) out.consumables = patch.consumables
  if (patch.labor) out.labor = patch.labor
  if (patch.panelMaterials) out.panelMaterials = patch.panelMaterials
  return out
}

export function defaultPresetDeep(): Preset {
  return JSON.parse(JSON.stringify(materialsData)) as Preset
}

let baselineEnsured = false

export function loadPreset(): Preset {
  const saved = readJson<Partial<Preset> | null>(KEY_PRESET, null)
  const merged = saved ? mergePreset(defaultPresetDeep(), saved) : defaultPresetDeep()
  // 首次载入：若本机还没有价目归档，把当前在用价目存成基线版（幂等，只做一次）
  if (!baselineEnsured) {
    baselineEnsured = true
    try {
      ensureBaseline(merged)
    } catch {
      // localStorage 不可用时不影响功能
    }
  }
  return merged
}

/**
 * 保存预设。
 * @param commitArchive true（在「材质与工艺」页显式点保存/恢复默认）时：
 *   若单价有改动，先存改动前那一版（基线/上一版已在归档里），再存改动后的新价目版本；
 *   false（会话内自动保存项目时顺带落盘预设）只覆盖当前预设，不提新版本，
 *   避免「改个字距也产生一个价目版本」。
 */
export function savePreset(preset: Preset, commitArchive = false): { version: PriceVersion; created: boolean } | null {
  writeJson(KEY_PRESET, preset)
  if (!commitArchive) return null
  try {
    return commitPresetPrices(preset)
  } catch {
    return null
  }
}

export function resetPreset(): Preset {
  const fresh = defaultPresetDeep()
  writeJson(KEY_PRESET, fresh)
  // 显式恢复出厂价：若与当前价目不同，同样产生一个新版本，保留可追溯性
  try {
    commitPresetPrices(fresh, { note: '恢复出厂默认价目' })
  } catch {
    // 忽略归档失败
  }
  return fresh
}

export function loadPrefs(): Prefs {
  return readJson<Prefs>(KEY_PREFS, { defaultFontId: 'hei', defaultWeight: 400, nightPreview: false })
}

export function savePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...p }
  writeJson(KEY_PREFS, next)
  return next
}