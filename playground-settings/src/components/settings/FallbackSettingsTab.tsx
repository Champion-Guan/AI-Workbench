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
  type DropPosition = 'before' | 'after' | null
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
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<DropPosition>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const draggedHeightRef = useRef(96)
  const dragDropPositionRef = useRef<DropPosition>(null)
  const dragOverIdRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null)
  const dragPreviewElementRef = useRef<HTMLDivElement | null>(null)
  const dragPreviewOffsetRef = useRef({ offsetX: 0, offsetY: 0 })
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null)
  const dragFrameRef = useRef<number | null>(null)
  const moveToDropTargetRef = useRef<(sourceId: string, targetId: string, position: DropPosition) => void>(() => {})
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
  const config = normalizeImageApiFallback(draft.imageApiFallback, profiles) ?? getDefaultImageApiFallback(profiles)
  const enabledProfiles = config.entries.flatMap((entry) => {
    const profile = profiles.find((candidate) => candidate.id === entry.profileId)
    return entry.enabled && profile && !isImageProviderExhausted(profile) ? [profile] : []
  })
  const save = (next: ImageApiFallbackSettings) => {
    commitSettings({ ...draft, imageApiFallback: next })
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
    setDraggedId(null)
    setDragOverId(null)
    setDragDropPosition(null)
    dragDropPositionRef.current = null
    setDragPreview(null)
  }

  const moveToDropTarget = (sourceId: string, targetId: string, position: 'before' | 'after' | null) => {
    if (!sourceId || !targetId || sourceId === targetId) return
    const sourceIndex = config.entries.findIndex((entry) => entry.profileId === sourceId)
    const targetIndex = config.entries.findIndex((entry) => entry.profileId === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return

    const nextEntries = [...config.entries]
    const [movedEntry] = nextEntries.splice(sourceIndex, 1)
    let nextIndex = targetIndex + (position === 'after' ? 1 : 0)
    if (sourceIndex < targetIndex) nextIndex -= 1
    nextEntries.splice(Math.max(0, Math.min(nextIndex, nextEntries.length)), 0, movedEntry)
    save({ ...config, entries: nextEntries })
  }
  moveToDropTargetRef.current = moveToDropTarget

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, profileId: string, profile: ApiProfile) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const card = entryElementsRef.current[profileId]
    if (!card) return
    const rect = card.getBoundingClientRect()
    event.preventDefault()
    event.stopPropagation()
    draggedHeightRef.current = rect.height
    dragPreviewOffsetRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    pendingPointerRef.current = { x: event.clientX, y: event.clientY }
    dragRef.current = { id: profileId, pointerId: event.pointerId }
    dragOverIdRef.current = null
    dragDropPositionRef.current = null
    setDraggedId(profileId)
    setDragOverId(null)
    setDragDropPosition(null)
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

      const hovered = document.elementFromPoint(clientX, clientY)?.closest('[data-fallback-entry]') as HTMLElement | null
      const targetId = hovered?.getAttribute('data-fallback-entry')
      if (!hovered || !targetId || targetId === drag.id) {
        if (dragOverIdRef.current !== null || dragDropPositionRef.current !== null) {
          dragOverIdRef.current = null
          dragDropPositionRef.current = null
          setDragOverId(null)
          setDragDropPosition(null)
        }
        return
      }

      const rect = hovered.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      const previousPosition = dragOverIdRef.current === targetId ? dragDropPositionRef.current : null
      let position: DropPosition = clientY < midpoint ? 'before' : 'after'
      if (previousPosition === 'before' && clientY < midpoint + 8) position = 'before'
      if (previousPosition === 'after' && clientY > midpoint - 8) position = 'after'
      if (dragOverIdRef.current !== targetId || dragDropPositionRef.current !== position) {
        dragOverIdRef.current = targetId
        dragDropPositionRef.current = position
        setDragOverId(targetId)
        setDragDropPosition(position)
      }

      const scrollContainer = hovered.closest('.custom-scrollbar') as HTMLElement | null
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect()
        const scrollThreshold = 30
        if (clientY < containerRect.top + scrollThreshold) scrollContainer.scrollTop -= 10
        if (clientY > containerRect.bottom - scrollThreshold) scrollContainer.scrollTop += 10
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
      // Once the gap is rendered, the latest pointer coordinate can be over that
      // pointer-events-none gap instead of the target card. Preserve the target
      // already detected by the last animation frame; only flush when none exists.
      if (!dragOverIdRef.current && point) updateDragPosition(point.x, point.y)
      const targetId = dragOverIdRef.current
      const position = dragDropPositionRef.current
      if (targetId && targetId !== drag.id) moveToDropTargetRef.current(drag.id, targetId, position)
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
  }, [dragPreview?.id, dragOverId, dragDropPosition])
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
        <Checkbox checked={config.enabled} onChange={(enabled) => save({ ...config, enabled })} label="启用 Fallback 自动切换" />
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
      <div className="space-y-2.5" role="list" aria-label="中转站重试顺序">
        {config.entries.filter((entry) => entry.profileId !== draggedId).map((entry) => {
          const profile = profiles.find((candidate) => candidate.id === entry.profileId)!
          const entryIndex = config.entries.findIndex((candidate) => candidate.profileId === entry.profileId)
          const exhausted = isImageProviderExhausted(profile)
          const checked = entry.enabled && !exhausted
          const showDropBefore = draggedId !== null && draggedId !== entry.profileId && dragOverId === entry.profileId && dragDropPosition === 'before'
          const showDropAfter = draggedId !== null && draggedId !== entry.profileId && dragOverId === entry.profileId && dragDropPosition === 'after'
          const isDropTarget = showDropBefore || showDropAfter
          return (
            <div key={entry.profileId} className="flex flex-col">
              <div
                aria-hidden="true"
                className="pointer-events-none order-none overflow-hidden rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/50 transition-[height,opacity,margin] duration-200 ease-out dark:border-indigo-400/60 dark:bg-indigo-500/10"
                style={{
                  height: isDropTarget ? draggedHeightRef.current : 0,
                  opacity: isDropTarget ? 1 : 0,
                  order: showDropBefore ? 0 : 2,
                  marginTop: showDropAfter ? 10 : 0,
                  marginBottom: showDropBefore ? 10 : 0,
                  borderColor: isDropTarget ? undefined : 'transparent',
                }}
              />
              <div
                ref={(element) => { entryElementsRef.current[entry.profileId] = element }}
                data-fallback-entry={entry.profileId}
                role="listitem"
                className={`order-1 flex items-center gap-3 overflow-hidden rounded-xl border p-3 sm:p-4 transition-[height,opacity,transform,background-color,border-color,padding] duration-200 ease-out ${checked
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
          }}
        >
          <DragHandleIcon className="h-4 w-4 shrink-0 text-indigo-500" />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100">{dragPreview.label}</span>
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
