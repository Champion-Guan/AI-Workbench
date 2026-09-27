import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ApiProfile, AppSettings, ImageApiFallbackSettings } from '../../types'
import { getDefaultImageApiFallback, moveImageFallbackEntry, normalizeImageApiFallback } from '../../lib/imageApiFallbackSettings'
import { isImageProviderExhausted, resetImageProviderExhausted } from '../../lib/imageApiFallback'
import { Checkbox } from '../Checkbox'
import { DragHandleIcon } from '../icons'

export default function FallbackSettingsTab({ draft, profiles, commitSettings }: {
  draft: AppSettings
  profiles: ApiProfile[]
  commitSettings: (settings: AppSettings) => void
}) {
  type DragPreview = {
    id: string
    label: string
    model: string
    apiMode: string
    baseUrl: string
    width: number
    height: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
  }
  type DropAnimation = {
    sourceId: string
    deltas: Record<string, number>
    phase: 'from' | 'to'
  }
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null)
  const [dragPointerY, setDragPointerY] = useState<number | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [dropAnimation, setDropAnimation] = useState<DropAnimation | null>(null)
  const dragSlotHeightRef = useRef(106)
  const dragPointerYRef = useRef<number | null>(null)
  const dragInsertIndexRef = useRef<number | null>(null)
  const dragOverIdRef = useRef<string | null>(null)
  const dragDropPositionRef = useRef<'before' | 'after' | null>(null)
  const dragLayoutRef = useRef<Record<string, { top: number; center: number; height: number }>>({})
  const dragOrderRef = useRef<string[]>([])
  const dragScrollRef = useRef<{ element: HTMLElement | null; startTop: number }>({ element: null, startTop: 0 })
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null)
  const dragPreviewElementRef = useRef<HTMLDivElement | null>(null)
  const dragPreviewOffsetRef = useRef({ offsetX: 0, offsetY: 0 })
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const dropAnimationFrameRef = useRef<number | null>(null)
  const dropAnimationTimerRef = useRef<number | null>(null)
  const dragListRef = useRef<HTMLDivElement | null>(null)
  const moveToDropIndexRef = useRef<(sourceId: string, insertIndex: number) => void>(() => {})
  const entryElementsRef = useRef<Record<string, HTMLDivElement | null>>({})
  const [, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const update = () => setRevision((revision) => revision + 1)
    window.addEventListener('storage', update)
    window.addEventListener('image-provider-exhausted', update)
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener('image-provider-exhausted', update)
    }
  }, [])
  useEffect(() => {
    if (!dropAnimation || dropAnimation.phase !== 'to') return
    dropAnimationTimerRef.current = window.setTimeout(() => {
      dropAnimationTimerRef.current = null
      setDropAnimation(null)
    }, 240)
    return () => {
      if (dropAnimationTimerRef.current !== null) {
        window.clearTimeout(dropAnimationTimerRef.current)
        dropAnimationTimerRef.current = null
      }
    }
  }, [dropAnimation?.phase])
  useEffect(() => () => {
    if (dropAnimationFrameRef.current !== null) cancelAnimationFrame(dropAnimationFrameRef.current)
    if (dropAnimationTimerRef.current !== null) window.clearTimeout(dropAnimationTimerRef.current)
  }, [])
  const config = normalizeImageApiFallback(draft.imageApiFallback, profiles) ?? getDefaultImageApiFallback(profiles)
  const enabledProfiles = config.entries.flatMap((entry) => {
    const profile = profiles.find((candidate) => candidate.id === entry.profileId)
    return entry.enabled && profile && !isImageProviderExhausted(profile) ? [profile] : []
  })
  const save = (next: ImageApiFallbackSettings) => {
    const enabled = next.entries.some((entry) => entry.enabled)
    commitSettings({ ...draft, imageApiFallback: { ...next, enabled } })
    setNotice('已自动保存，下次提交生效')
  }
  const move = (profileId: string, targetId: string) => {
    save({ ...config, entries: moveImageFallbackEntry(config.entries, profileId, targetId) })
  }

  const clearDragState = () => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
    pendingPointerRef.current = null
    dragRef.current = null
    dragOverIdRef.current = null
    dragInsertIndexRef.current = null
    dragPointerYRef.current = null
    dragLayoutRef.current = {}
    dragOrderRef.current = []
    dragScrollRef.current = { element: null, startTop: 0 }
    setDraggedId(null)
    setDragOverId(null)
    setDragInsertIndex(null)
    setDragPointerY(null)
    dragDropPositionRef.current = null
    setDragPreview(null)
  }

  const moveToDropIndex = (sourceId: string, insertIndex: number) => {
    if (!sourceId || insertIndex < 0) return
    const sourceIndex = config.entries.findIndex((entry) => entry.profileId === sourceId)
    if (sourceIndex < 0) return

    const nextEntries = [...config.entries]
    const [movedEntry] = nextEntries.splice(sourceIndex, 1)
    nextEntries.splice(Math.max(0, Math.min(insertIndex, nextEntries.length)), 0, movedEntry)
    save({ ...config, entries: nextEntries })
  }
  moveToDropIndexRef.current = moveToDropIndex

  const cancelDropAnimation = () => {
    if (dropAnimationFrameRef.current !== null) {
      cancelAnimationFrame(dropAnimationFrameRef.current)
      dropAnimationFrameRef.current = null
    }
    if (dropAnimationTimerRef.current !== null) {
      window.clearTimeout(dropAnimationTimerRef.current)
      dropAnimationTimerRef.current = null
    }
    setDropAnimation(null)
  }

  const getDragScrollDelta = () => {
    const scrollContainer = dragScrollRef.current.element
    return scrollContainer
      ? scrollContainer.scrollTop - dragScrollRef.current.startTop
      : 0
  }

  const getInsertIndexAtPointer = (clientY: number) => {
    const order = dragOrderRef.current
    const sourceId = dragRef.current?.id ?? draggedId
    const sourceIndex = sourceId ? order.indexOf(sourceId) : -1
    const sourceLayout = sourceId ? dragLayoutRef.current[sourceId] : undefined
    if (sourceIndex < 0 || !sourceLayout || order.length < 2) return sourceIndex >= 0 ? sourceIndex : null

    const pointerY = clientY - getDragScrollDelta()
    const halfSlot = Math.max(1, dragSlotHeightRef.current) / 2
    let insertIndex = sourceIndex

    if (pointerY < sourceLayout.center) {
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        const item = dragLayoutRef.current[order[index]]
        if (!item || pointerY >= item.center + halfSlot) break
        insertIndex = index
      }
    } else if (pointerY > sourceLayout.center) {
      for (let index = sourceIndex + 1; index < order.length; index += 1) {
        const item = dragLayoutRef.current[order[index]]
        if (!item || pointerY < item.center - halfSlot) break
        insertIndex = index
      }
    }

    return Math.max(0, Math.min(order.length - 1, insertIndex))
  }

  const prepareDropAnimation = (sourceId: string, insertIndex: number) => {
    const order = dragOrderRef.current
    if (!order.length) return {}
    const scrollDelta = getDragScrollDelta()
    const slotTops = order.map((id) => {
      const item = dragLayoutRef.current[id]
      return item ? item.top - scrollDelta : null
    })
    const nextOrder = [...order]
    const sourceIndex = nextOrder.indexOf(sourceId)
    if (sourceIndex < 0) return {}
    const [moved] = nextOrder.splice(sourceIndex, 1)
    nextOrder.splice(Math.max(0, Math.min(insertIndex, nextOrder.length)), 0, moved)

    const nextTopById = Object.fromEntries(nextOrder.map((id, index) => [id, slotTops[index]]))
    return Object.fromEntries(order.flatMap((id) => {
      // The floating preview already represents the dragged card at the
      // pointer. On drop it should simply appear in its final slot instead
      // of replaying the whole trip from its old slot a second time.
      if (id === sourceId) return []
      const currentTop = entryElementsRef.current[id]?.getBoundingClientRect().top
      const nextTop = nextTopById[id]
      return typeof currentTop === 'number' && typeof nextTop === 'number' ? [[id, currentTop - nextTop]] : []
    })) as Record<string, number>
  }

  const startDropAnimation = (sourceId: string, insertIndex: number) => {
    cancelDropAnimation()
    const deltas = prepareDropAnimation(sourceId, insertIndex)
    setDropAnimation({ sourceId, deltas, phase: 'from' })
    dropAnimationFrameRef.current = requestAnimationFrame(() => {
      dropAnimationFrameRef.current = null
      setDropAnimation((current) => current ? { ...current, phase: 'to' } : null)
    })
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, profileId: string, profile: ApiProfile) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (dropAnimation) return
    const card = entryElementsRef.current[profileId]
    if (!card) return
    const rect = card.getBoundingClientRect()
    event.preventDefault()
    event.stopPropagation()
    const order = config.entries.map((entry) => entry.profileId)
    const layout = Object.fromEntries(order.map((id) => {
      const element = entryElementsRef.current[id]
      const elementRect = element?.getBoundingClientRect()
      return elementRect
        ? [id, { top: elementRect.top, center: elementRect.top + elementRect.height / 2, height: elementRect.height }]
        : [id, { top: rect.top, center: rect.top + rect.height / 2, height: rect.height }]
    }))
    dragOrderRef.current = order
    dragLayoutRef.current = layout
    const adjacentGap = order.slice(1).reduce((gap, id, index) => {
      const previous = layout[order[index]]
      const current = layout[id]
      if (!previous || !current) return gap
      return gap ?? Math.max(0, current.top - (previous.top + previous.height))
    }, null as number | null)
    dragSlotHeightRef.current = rect.height + (adjacentGap ?? 10)
    const scrollContainer = dragListRef.current?.closest('.custom-scrollbar') as HTMLElement | null
    dragScrollRef.current = { element: scrollContainer, startTop: scrollContainer?.scrollTop ?? 0 }
    dragPreviewOffsetRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    pendingPointerRef.current = { x: event.clientX, y: event.clientY }
    dragPointerYRef.current = event.clientY
    dragRef.current = { id: profileId, pointerId: event.pointerId }
    dragOverIdRef.current = null
    dragInsertIndexRef.current = config.entries.findIndex((entry) => entry.profileId === profileId)
    dragDropPositionRef.current = null
    setDraggedId(profileId)
    setDragOverId(null)
    setDragInsertIndex(dragInsertIndexRef.current)
    setDragPointerY(event.clientY)
    setDragPreview({
      id: profileId,
      label: profile.name,
      model: profile.model,
      apiMode: profile.apiMode === 'responses' ? 'Responses API' : 'Images API',
      baseUrl: profile.baseUrl,
      width: rect.width,
      height: rect.height,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    })
  }

  useEffect(() => {
    if (!dragRef.current) return
    const previousUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    const updateDragPosition = (clientX: number, clientY: number) => {
      const drag = dragRef.current
      if (!drag) return
      const { offsetX, offsetY } = dragPreviewOffsetRef.current
      const previewElement = dragPreviewElementRef.current
        ?? document.querySelector<HTMLElement>('[data-fallback-drag-preview]')
      if (previewElement) {
        previewElement.style.transform = `translate3d(${clientX - offsetX}px, ${clientY - offsetY}px, 0)`
      }
      dragPointerYRef.current = clientY
      setDragPointerY(clientY)

      const order = dragOrderRef.current
      const sourceIndex = order.indexOf(drag.id)
      if (sourceIndex < 0 || order.length < 2) return
      const scrollContainer = dragScrollRef.current.element

      // Use the layout captured before dragging started. Cards begin making
      // room one half-slot before the pointer reaches their center, and the
      // same threshold is used on pointerup so a visible drop never reverts
      // to the old order.
      const insertIndex = getInsertIndexAtPointer(clientY)
      if (insertIndex === null) return
      if (dragInsertIndexRef.current !== insertIndex) {
        dragInsertIndexRef.current = insertIndex
        setDragInsertIndex(insertIndex)
      }

      const visibleOrder = order.filter((id) => id !== drag.id)
      const targetId = visibleOrder[Math.min(insertIndex, visibleOrder.length - 1)] ?? null
      const position: 'before' | 'after' | null = insertIndex >= visibleOrder.length ? 'after' : 'before'
      if (dragOverIdRef.current !== targetId || dragDropPositionRef.current !== position) {
        dragOverIdRef.current = targetId
        dragDropPositionRef.current = position
        setDragOverId(targetId)
      }

      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect()
        const scrollThreshold = 30
        if (clientY < containerRect.top + scrollThreshold) scrollContainer.scrollTop -= 4
        if (clientY > containerRect.bottom - scrollThreshold) scrollContainer.scrollTop += 4
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      event.preventDefault()
      pendingPointerRef.current = { x: event.clientX, y: event.clientY }
      if (dragFrameRef.current === null) {
        dragFrameRef.current = requestAnimationFrame(() => {
          dragFrameRef.current = null
          const point = pendingPointerRef.current
          if (point) updateDragPosition(point.x, point.y)
        })
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }
      const point = pendingPointerRef.current
      // Resolve the final slot directly from pointerup. This avoids losing a
      // last pointermove that was still waiting for requestAnimationFrame.
      const insertIndex = getInsertIndexAtPointer(point?.y ?? event.clientY)
      const sourceIndex = config.entries.findIndex((entry) => entry.profileId === drag.id)
      if (insertIndex !== null && sourceIndex >= 0 && insertIndex !== sourceIndex) {
        startDropAnimation(drag.id, insertIndex)
        moveToDropIndexRef.current(drag.id, insertIndex)
      }
      clearDragState()
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) clearDragState()
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = null
      }
      document.body.style.userSelect = previousUserSelect
    }
  }, [draggedId])
  useLayoutEffect(() => {
    if (!dragPreview) return
    const point = pendingPointerRef.current ?? { x: dragPreview.startX, y: dragPreview.startY }
    const previewElement = dragPreviewElementRef.current
      ?? document.querySelector<HTMLElement>('[data-fallback-drag-preview]')
    if (previewElement) {
      previewElement.style.transform = `translate3d(${point.x - dragPreview.offsetX}px, ${point.y - dragPreview.offsetY}px, 0)`
    }
  }, [dragPreview?.id, dragInsertIndex, dragPointerY])
  const getDragShift = (entryIndex: number) => {
    if (!draggedId || dragPointerY === null) return 0
    const sourceIndex = config.entries.findIndex((entry) => entry.profileId === draggedId)
    if (sourceIndex < 0 || entryIndex === sourceIndex) return 0
    const sourceLayout = dragLayoutRef.current[draggedId]
    const entryLayout = dragLayoutRef.current[config.entries[entryIndex]?.profileId]
    if (!sourceLayout || !entryLayout) return 0
    const scrollDelta = dragScrollRef.current.element
      ? dragScrollRef.current.element.scrollTop - dragScrollRef.current.startTop
      : 0
    const pointerY = dragPointerY - scrollDelta
    const sourceCenter = sourceLayout.center
    const slotHeight = Math.max(1, dragSlotHeightRef.current)
    const halfSlot = slotHeight / 2
    const clamp = (value: number) => Math.max(0, Math.min(1, value))
    if (entryIndex > sourceIndex && pointerY > sourceCenter) {
      const progress = clamp((pointerY - (entryLayout.center - halfSlot)) / halfSlot)
      return -slotHeight * progress
    }
    if (entryIndex < sourceIndex && pointerY < sourceCenter) {
      const progress = clamp(((entryLayout.center + halfSlot) - pointerY) / halfSlot)
      return slotHeight * progress
    }
    return 0
  }
  return (
    <>
      <section className="space-y-5" aria-label="Fallback 配置">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">失败自动切换</h3>
        <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          从上到下依次尝试已勾选的中转站。明确失败时切换下一站；本地转发断连、图片回传不完整等结果不明的情况会暂停，避免重复扣费。
        </p>
      </div>
      <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4 space-y-2">
        <Checkbox checked={config.enabled} onChange={(enabled) => save({
          ...config,
          entries: config.entries.map((entry) => ({ ...entry, enabled })),
        })} label="启用 Fallback 自动切换" />
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          关闭后仅请求「API 配置」当前选中的站点，不使用下方顺序和勾选状态。
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-600 dark:text-gray-300">中转站顺序 · 拖动或点击 ↑ ↓ 调整</span>
        <button type="button" className="text-xs text-blue-600 dark:text-blue-400 shrink-0 hover:underline"
          onClick={() => save({
            ...config,
            entries: getDefaultImageApiFallback(profiles).entries.map((entry) =>
              config.entries.find((current) => current.profileId === entry.profileId) ?? entry),
          })}
        >恢复默认顺序</button>
      </div>
      <div ref={dragListRef} className="space-y-2.5" role="list" aria-label="中转站重试顺序">
        {config.entries.map((entry) => {
          const profile = profiles.find((candidate) => candidate.id === entry.profileId)!
          const entryIndex = config.entries.findIndex((candidate) => candidate.profileId === entry.profileId)
          const exhausted = isImageProviderExhausted(profile)
          const checked = entry.enabled && !exhausted
          const isDragged = draggedId === entry.profileId
          const isDropTarget = draggedId !== null && !isDragged && dragOverId === entry.profileId
          const dragShift = getDragShift(entryIndex)
          const isDropSource = dropAnimation?.sourceId === entry.profileId
          const dropShift = dropAnimation?.deltas[entry.profileId] ?? 0
          const wrapperTransform = dropAnimation
            ? `translate3d(0, ${dropAnimation.phase === 'from' ? dropShift : 0}px, 0)`
            : dragShift ? `translate3d(0, ${dragShift}px, 0)` : undefined
          const isDropHidden = isDropSource && dropAnimation?.phase === 'from'
          return (
            <div
              key={entry.profileId}
              className={`flex flex-col will-change-transform ${dropAnimation?.phase === 'from'
                ? 'transition-none'
                : 'transition-transform duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]'}`}
              style={{ transform: wrapperTransform }}
            >
              <div
                ref={(element) => { entryElementsRef.current[entry.profileId] = element }}
                data-fallback-entry={entry.profileId}
                role="listitem"
                aria-hidden={isDragged || isDropHidden ? 'true' : undefined}
                className={`flex items-center gap-3 overflow-hidden rounded-xl border p-3 sm:p-4 transition-[opacity,box-shadow,background-color,border-color] duration-200 ease-out ${isDragged || isDropHidden
                  ? 'pointer-events-none opacity-0'
                  : isDropTarget
                    ? 'ring-2 ring-indigo-300/70 ring-offset-2 ring-offset-white dark:ring-indigo-400/60 dark:ring-offset-gray-900'
                    : ''} ${checked
                  ? 'border-indigo-400 dark:border-indigo-400/60 bg-indigo-50 dark:bg-indigo-500/10'
                  : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]'}`}
              >
                <button type="button" aria-label={`拖动排序 ${profile.name}`} title="拖动调整顺序"
                  className="touch-none select-none text-gray-400 cursor-grab active:cursor-grabbing p-1 shrink-0"
                  onPointerDown={(event) => handlePointerDown(event, entry.profileId, profile)}
                ><DragHandleIcon className="w-4 h-4" /></button>
              <span className="text-xs tabular-nums text-gray-400 shrink-0">{entryIndex + 1}</span>
              <Checkbox checked={checked} aria-label={`启用 ${profile.name}`} className="min-w-0 flex-1"
                onChange={(enabled) => {
                  try {
                    if (enabled && exhausted) resetImageProviderExhausted(profile)
                    save({ ...config, entries: config.entries.map((current) =>
                      current.profileId === entry.profileId ? { ...current, enabled } : current) })
                  } catch {
                    setNotice('无法清除余额不足标记，请检查浏览器存储权限。')
                  }
                }}
                label={<span className="min-w-0 block">
                  <span className="block font-medium text-sm text-gray-900 dark:text-gray-100 break-words">{profile.name}</span>
                  <span className="block mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">
                    {profile.model} · {profile.apiMode === 'responses' ? 'Responses API' : 'Images API'} · {profile.baseUrl}
                  </span>
                  {exhausted && <span className="block mt-1 text-xs text-amber-600 dark:text-amber-400">余额不足，已自动跳过；重新勾选可恢复尝试。</span>}
                  {!checked && !exhausted && <span className="block mt-1 text-xs text-gray-400">已停用，不参与自动切换</span>}
                </span>}
              />
              <div className="flex flex-col gap-1 shrink-0">
                <button type="button" aria-label={`上移 ${profile.name}`} disabled={entryIndex === 0}
                  className="w-7 h-7 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-25"
                  onClick={() => move(entry.profileId, config.entries[entryIndex - 1].profileId)}>↑</button>
                <button type="button" aria-label={`下移 ${profile.name}`} disabled={entryIndex === config.entries.length - 1}
                  className="w-7 h-7 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-25"
                  onClick={() => move(entry.profileId, config.entries[entryIndex + 1].profileId)}>↓</button>
              </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="rounded-xl bg-gray-50 dark:bg-white/[0.03] p-3 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
        {config.enabled
          ? enabledProfiles.length
            ? `实际请求顺序：${enabledProfiles.map((profile) => profile.name).join(' → ')}`
            : <span role="alert" className="text-red-500">没有启用的中转站。请至少勾选一个，否则无法生成图片。</span>
          : '自动切换已关闭，仅使用当前 API 配置。'}
      </div>
      <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{notice || '设置自动保存在当前浏览器，不影响正在生成的任务。'}</p>
      </section>
      {dragPreview && createPortal(
        <div
          aria-hidden="true"
          data-fallback-drag-preview="true"
          ref={(element) => { dragPreviewElementRef.current = element }}
          className="pointer-events-none fixed z-[180] flex will-change-transform items-center gap-3 rounded-xl border border-indigo-400 bg-indigo-50/95 p-3 shadow-2xl ring-2 ring-indigo-400/30 backdrop-blur dark:border-indigo-300/70 dark:bg-indigo-500/20"
          style={{
            left: 0,
            top: 0,
            width: dragPreview.width,
            minHeight: dragPreview.height,
            zIndex: 2000,
          }}
        >
          <DragHandleIcon className="h-4 w-4 shrink-0 text-indigo-500" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="shrink-0 rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-400/20 dark:text-indigo-200">拖动中</span>
              <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">{dragPreview.label}</span>
            </span>
            <span className="mt-1 block break-all text-xs text-gray-500 dark:text-gray-400">
              {dragPreview.model} · {dragPreview.apiMode} · {dragPreview.baseUrl}
            </span>
          </span>
        </div>,
        document.body,
      )}
    </>
  )
}
