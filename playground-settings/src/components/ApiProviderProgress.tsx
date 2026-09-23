import { useEffect, useRef } from 'react'
import type { ImageApiAttempt, TaskStatus } from '../types'
import { CodeIcon } from './icons'

const STATUS_LABELS = {
  running: '生图进行中',
  success: '生图成功',
  error: '请求失败',
  cancelled: '已停止',
  unknown: '结果不明，可能已扣费',
}

export default function ApiProviderProgress({ attempts, taskStatus, imageCount }: {
  attempts: ImageApiAttempt[]
  taskStatus: TaskStatus
  imageCount: number
}) {
  const progressRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (taskStatus !== 'running') return
    const container = progressRef.current?.closest<HTMLElement>('[data-tag-scroll-area]')
    const active = progressRef.current?.querySelectorAll<HTMLElement>('[data-provider-status="running"]')
    const latest = active?.[active.length - 1]
    if (!container || !latest) return
    const overflow = latest.getBoundingClientRect().right - container.getBoundingClientRect().right + 12
    if (overflow > 0) container.scrollLeft += overflow
  }, [attempts, taskStatus])
  const requestIndices = [...new Set(attempts.map((attempt) => attempt.requestIndex))].sort((left, right) => left - right)
  return (
    <span ref={progressRef} className="inline-flex flex-shrink-0 items-center gap-2" aria-label="生图中转站进度" aria-live="polite">
      {requestIndices.map((requestIndex) => (
        <span key={requestIndex} className="inline-flex items-center gap-1">
          {imageCount > 1 && <span className="text-xs text-gray-400">#{requestIndex + 1}</span>}
          {attempts.filter((attempt) => attempt.requestIndex === requestIndex).map((attempt, index) => {
            const status = attempt.status === 'running' && taskStatus !== 'running' ? 'cancelled' : attempt.status
            const label = `${attempt.profileName}：${STATUS_LABELS[status]}${attempt.error ? `；${attempt.error}` : ''}`
            return (
              <span key={`${attempt.profileId}:${attempt.model ?? ''}`} className="inline-flex items-center gap-1">
                {index > 0 && <span className="text-xs text-gray-400" aria-hidden="true">→</span>}
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 text-xs"
                  title={label}
                  aria-label={label}
                  data-provider-status={status}
                >
                  <CodeIcon className="w-3 h-3 flex-shrink-0 text-gray-400" />
                  <span className="truncate max-w-[8rem]">{attempt.profileName}</span>
                  {status === 'unknown' && <span className="text-amber-500">结果不明</span>}
                  {status === 'running' ? (
                    <span aria-hidden="true" className="w-3 h-3 flex-shrink-0 rounded-full border-[1.5px] border-blue-500/30 border-t-blue-500 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      className={`w-3 h-3 flex-shrink-0 ${status === 'unknown' ? 'text-amber-500' : status === 'error' ? 'text-red-500' : status === 'success' ? 'text-emerald-500' : 'text-gray-400'}`}
                    >
                      <path d={status === 'success' ? 'M3 8l3 3 7-7' : status === 'error' ? 'M4 4l8 8M12 4l-8 8' : status === 'unknown' ? 'M8 3v6M8 12v1' : 'M5 4v8M11 4v8'} />
                    </svg>
                  )}
                </span>
              </span>
            )
          })}
        </span>
      ))}
    </span>
  )
}
