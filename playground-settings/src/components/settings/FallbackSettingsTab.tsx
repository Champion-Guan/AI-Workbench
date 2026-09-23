import { useEffect, useState } from 'react'
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
        {config.entries.map((entry, index) => {
          const profile = profiles.find((candidate) => candidate.id === entry.profileId)!
          const exhausted = isImageProviderExhausted(profile)
          const checked = entry.enabled && !exhausted
          return (
            <div key={entry.profileId} role="listitem"
              className={`flex items-center gap-3 rounded-xl border p-3 sm:p-4 transition-colors ${checked
                ? 'border-indigo-400 dark:border-indigo-400/60 bg-indigo-50 dark:bg-indigo-500/10'
                : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]'} ${draggedId === entry.profileId ? 'opacity-50' : ''}`}
              onDragOver={(event) => { if (draggedId) event.preventDefault() }}
              onDrop={(event) => {
                event.preventDefault()
                if (draggedId) move(draggedId, entry.profileId)
                setDraggedId(null)
              }}
            >
              <button type="button" draggable aria-label={`拖动排序 ${profile.name}`} title="拖动调整顺序"
                className="text-gray-400 cursor-grab active:cursor-grabbing p-1 shrink-0"
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', entry.profileId)
                  setDraggedId(entry.profileId)
                }}
                onDragEnd={() => setDraggedId(null)}
              ><DragHandleIcon className="w-4 h-4" /></button>
              <span className="text-xs tabular-nums text-gray-400 shrink-0">{index + 1}</span>
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
                <button type="button" aria-label={`上移 ${profile.name}`} disabled={index === 0}
                  className="w-7 h-7 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-25"
                  onClick={() => move(entry.profileId, config.entries[index - 1].profileId)}>↑</button>
                <button type="button" aria-label={`下移 ${profile.name}`} disabled={index === config.entries.length - 1}
                  className="w-7 h-7 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-25"
                  onClick={() => move(entry.profileId, config.entries[index + 1].profileId)}>↓</button>
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
  )
}
