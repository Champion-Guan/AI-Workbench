import { useEffect, useRef, useState, type DragEvent } from 'react'
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
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragDropPosition, setDragDropPosition] = useState<'before' | 'after' | null>(null)
  const draggedHeightRef = useRef(96)
  const dragDropPositionRef = useRef<'before' | 'after' | null>(null)
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
    if (!draggedId) return
    const handleGlobalDragEnd = () => {
      setDraggedId(null)
      setDragOverId(null)
      setDragDropPosition(null)
      dragDropPositionRef.current = null
    }
    window.addEventListener('dragend', handleGlobalDragEnd)
    return () => window.removeEventListener('dragend', handleGlobalDragEnd)
  }, [draggedId])
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
    setDraggedId(null)
    setDragOverId(null)
    setDragDropPosition(null)
    dragDropPositionRef.current = null
  }

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, profileId: string) => {
    const card = entryElementsRef.current[profileId]
    if (card) {
      const rect = card.getBoundingClientRect()
      draggedHeightRef.current = rect.height
      event.dataTransfer.setDragImage(card, Math.max(12, event.clientX - rect.left), Math.max(12, event.clientY - rect.top))
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', profileId)
    setDraggedId(profileId)
    setDragOverId(null)
    setDragDropPosition(null)
    dragDropPositionRef.current = null
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    if (!draggedId || draggedId === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    const targetElement = event.currentTarget
    const rect = targetElement.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    dragDropPositionRef.current = position
    setDragOverId((current) => current === targetId ? current : targetId)
    setDragDropPosition((current) => current === position ? current : position)

    const scrollContainer = targetElement.closest('.custom-scrollbar') as HTMLElement | null
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const scrollThreshold = 30
      if (event.clientY < containerRect.top + scrollThreshold) scrollContainer.scrollTop -= 10
      if (event.clientY > containerRect.bottom - scrollThreshold) scrollContainer.scrollTop += 10
    }
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

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId
    if (sourceId) moveToDropTarget(sourceId, targetId, dragDropPositionRef.current ?? dragDropPosition)
    clearDragState()
  }
  return (
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
        {config.entries.map((entry) => {
          const profile = profiles.find((candidate) => candidate.id === entry.profileId)!
          const entryIndex = config.entries.findIndex((candidate) => candidate.profileId === entry.profileId)
          const exhausted = isImageProviderExhausted(profile)
          const checked = entry.enabled && !exhausted
          const isDraggingEntry = draggedId === entry.profileId
          const showDropBefore = draggedId !== null && draggedId !== entry.profileId && dragOverId === entry.profileId && dragDropPosition === 'before'
          const showDropAfter = draggedId !== null && draggedId !== entry.profileId && dragOverId === entry.profileId && dragDropPosition === 'after'
          return (
            <div key={entry.profileId}>
              {showDropBefore && (
                <div
                  aria-hidden="true"
                  className="mb-2.5 overflow-hidden rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/50 animate-dropdown-down transition-[height,opacity,margin] duration-200 ease-out dark:border-indigo-400/60 dark:bg-indigo-500/10"
                  style={{ height: draggedHeightRef.current, opacity: 1 }}
                />
              )}
              <div
                ref={(element) => { entryElementsRef.current[entry.profileId] = element }}
                data-fallback-entry={entry.profileId}
                role="listitem"
                className={`flex items-center gap-3 overflow-hidden rounded-xl border p-3 sm:p-4 transition-[height,opacity,transform,background-color,border-color,padding] duration-200 ease-out ${checked
                  ? 'border-indigo-400 dark:border-indigo-400/60 bg-indigo-50 dark:bg-indigo-500/10'
                  : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]'}`}
                style={isDraggingEntry
                  ? { height: 0, minHeight: 0, paddingTop: 0, paddingBottom: 0, borderWidth: 0, opacity: 0 }
                  : undefined}
                onDragOver={(event) => handleDragOver(event, entry.profileId)}
                onDrop={(event) => handleDrop(event, entry.profileId)}
              >
                <button type="button" draggable aria-label={`拖动排序 ${profile.name}`} title="拖动调整顺序"
                  className="text-gray-400 cursor-grab active:cursor-grabbing p-1 shrink-0"
                  onDragStart={(event) => handleDragStart(event, entry.profileId)}
                  onDragEnd={clearDragState}
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
              {showDropAfter && (
                <div
                  aria-hidden="true"
                  className="mt-2.5 overflow-hidden rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/50 animate-dropdown-down transition-[height,opacity,margin] duration-200 ease-out dark:border-indigo-400/60 dark:bg-indigo-500/10"
                  style={{ height: draggedHeightRef.current, opacity: 1 }}
                />
              )}
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
  )
}
