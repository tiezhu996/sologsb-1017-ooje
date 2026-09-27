import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { ChangeRequest, Character, ContinuityState, DiffItem, Prop, Reply, Scene, SceneFieldChange, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const sceneFieldLabels: Record<string, string> = {
  number: '场号',
  slug: '场名',
  synopsis: '摘要',
  intExt: '内外景',
  location: '地点',
  dayNight: '日夜',
  storyTime: '故事时间',
  pageLength: '页数',
  revision: '修订色',
  status: '状态',
  reason: '修改理由',
  characterIds: '出场角色',
  propIds: '使用道具',
  costumes: '服装搭配'
}

export const revisionLabels: Record<Scene['revision'], string> = {
  white: '白纸', blue: '蓝', pink: '粉', yellow: '黄', green: '绿', goldenrod: '金菊', buff: '浅黄', salmon: '鲑粉', cherry: '樱桃'
}

export const sceneStatusLabels: Record<Scene['status'], string> = { draft: '草稿', review: '待审', locked: '锁定' }

export function formatSceneField(script: Script, field: keyof Scene, value: Scene[keyof Scene]): string {
  if (value === undefined || value === null || value === '') return '空'
  if (field === 'characterIds') {
    const names = (value as string[]).map((itemId) => script.characters.find((item) => item.id === itemId)?.name ?? '未知角色')
    return names.length ? names.join('、') : '无'
  }
  if (field === 'propIds') {
    const names = (value as string[]).map((itemId) => script.props.find((item) => item.id === itemId)?.name ?? '未知道具')
    return names.length ? names.join('、') : '无'
  }
  if (field === 'costumes') {
    const pairs = Object.entries(value as Record<string, string>).map(([characterId, wardrobeId]) => {
      const character = script.characters.find((item) => item.id === characterId)?.name ?? '未知角色'
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)?.name ?? '未知服装'
      return `${character}→${wardrobe}`
    })
    return pairs.length ? pairs.join('、') : '无'
  }
  if (field === 'revision') return revisionLabels[value as Scene['revision']] ?? String(value)
  if (field === 'status') return sceneStatusLabels[value as Scene['status']] ?? String(value)
  if (field === 'pageLength') return `${value} 页`
  return String(value)
}

export function buildSceneChanges(script: Script, scene: Scene, edits: Partial<Scene>): SceneFieldChange[] {
  const changes: SceneFieldChange[] = []
  ;(Object.keys(edits) as Array<keyof Scene>).forEach((field) => {
    const before = scene[field]
    const after = edits[field]
    if (after === undefined || JSON.stringify(before) === JSON.stringify(after)) return
    changes.push({
      field,
      label: sceneFieldLabels[field] ?? String(field),
      beforeText: formatSceneField(script, field, before),
      afterText: formatSceneField(script, field, after),
      after: clone(after)
    })
  })
  return changes
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) {
        return { ...parsed, changeRequests: Array.isArray(parsed.changeRequests) ? parsed.changeRequests : [] }
      }
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], changeRequests: [], updatedAt: new Date().toISOString() }
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const sceneIndex = (sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  script.scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。'
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。'
        })
      }
    })

    if (index > 0 && script.scenes[index - 1].storyTime && scene.storyTime && index > 0) {
      const previous = script.scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const diffKeys: Array<keyof Scene> = ['slug', 'synopsis', 'intExt', 'location', 'dayNight', 'storyTime', 'pageLength', 'revision', 'status', 'reason']
  const fields = diffKeys.map((key) => ({ key, label: sceneFieldLabels[key] }))
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<Script[]>([])
  const redoRef = useRef<Script[]>([])
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const next = clone(previous.script)
      mutator(next)
      undoRef.current.push(clone(previous.script))
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      return { ...previous, script: next, updatedAt: new Date().toISOString() }
    })
  }, [])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push(clone(previous.script))
      return { ...previous, script: target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push(clone(previous.script))
      return { ...previous, script: target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene]) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      // Locked scenes only change through an approved change request.
      if (!scene || scene.status === 'locked') return
      ;(scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene || scene.status === 'locked') return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene || scene.status === 'locked') return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [mutate])

  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      if (script.scenes[index].status === 'locked') return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    if (state.script.scenes.find((scene) => scene.id === sceneId)?.status === 'locked') return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate, state.script.scenes])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: { ...(previous.reviews[warningId] ?? { replies: [] }), status }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const submitChangeRequest = useCallback((sceneId: string, submitter: string, note: string, changes: SceneFieldChange[]) => {
    if (!changes.length) return ''
    const scene = state.script.scenes.find((item) => item.id === sceneId)
    if (!scene) return ''
    const request: ChangeRequest = {
      id: id('req'),
      sceneId,
      sceneNumber: scene.number,
      sceneSlug: scene.slug,
      submitter: submitter.trim() || '未署名',
      note: note.trim(),
      changes,
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    setState((previous) => ({ ...previous, changeRequests: [request, ...previous.changeRequests], updatedAt: new Date().toISOString() }))
    return request.id
  }, [state.script.scenes])

  const approveChangeRequest = useCallback((requestId: string, resolver: string) => {
    setState((previous) => {
      const request = previous.changeRequests.find((item) => item.id === requestId)
      if (!request || request.status !== 'pending') return previous
      const sceneExists = previous.script.scenes.some((scene) => scene.id === request.sceneId)
      if (!sceneExists) return previous
      const next = clone(previous.script)
      const scene = next.scenes.find((item) => item.id === request.sceneId)
      if (scene) {
        request.changes.forEach((change) => {
          (scene as unknown as Record<string, unknown>)[change.field] = clone(change.after)
        })
      }
      undoRef.current.push(clone(previous.script))
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      return {
        ...previous,
        script: next,
        changeRequests: previous.changeRequests.map((item) =>
          item.id === requestId
            ? { ...item, status: 'approved' as const, resolvedAt: new Date().toISOString(), resolver: resolver.trim() || '审阅人' }
            : item
        ),
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const rejectChangeRequest = useCallback((requestId: string, resolver: string, reason: string) => {
    if (!reason.trim()) return
    setState((previous) => ({
      ...previous,
      changeRequests: previous.changeRequests.map((item) =>
        item.id === requestId && item.status === 'pending'
          ? { ...item, status: 'rejected' as const, resolvedAt: new Date().toISOString(), resolver: resolver.trim() || '审阅人', rejectReason: reason.trim() }
          : item
      ),
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    const version: Version = { id: id('version'), name: name.trim() || `版本 ${state.versions.length + 1}`, createdAt: new Date().toISOString(), script: clone(state.script) }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [state.script, state.versions.length])

  const restoreVersion = useCallback((versionId: string) => {
    const version = state.versions.find((item) => item.id === versionId)
    if (!version) return
    mutate((script) => { Object.assign(script, clone(version.script)) })
  }, [mutate, state.versions])

  const reset = useCallback(() => {
    mutate((script) => { Object.assign(script, clone(sampleScript)) })
    setState((previous) => ({ ...previous, reviews: {} }))
  }, [mutate])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    setReviewStatus,
    addReply,
    submitChangeRequest,
    approveChangeRequest,
    rejectChangeRequest,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}
