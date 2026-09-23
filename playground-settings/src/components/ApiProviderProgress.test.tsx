import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImageApiAttempt } from '../types'
import ApiProviderProgress from './ApiProviderProgress'

const attempts: ImageApiAttempt[] = [
  { profileId: 'hi', profileName: 'Hi-Code', requestIndex: 0, status: 'error' },
  { profileId: 'zzone', profileName: 'zzone', requestIndex: 0, status: 'running' },
]

describe('provider progress badges', () => {
  it('distinguishes an uncertain billed result from a definite failure', () => {
    const html = renderToStaticMarkup(<ApiProviderProgress attempts={[{
      ...attempts[0], status: 'unknown', error: '诊断编号：test-123',
    }]} taskStatus="error" imageCount={1} />)
    expect(html).toContain('结果不明，可能已扣费')
    expect(html).toContain('test-123')
    expect(html).toContain('text-amber-500')
    expect(html).not.toContain('text-red-500')
    expect(html).not.toContain('animate-spin')
  })

  it('shows a red failure followed by the next provider and spinner', () => {
    const html = renderToStaticMarkup(<ApiProviderProgress attempts={attempts} taskStatus="running" imageCount={1} />)
    expect(html).toContain('Hi-Code：请求失败')
    expect(html).toContain('text-red-500')
    expect(html).toContain('zzone：生图进行中')
    expect(html).toContain('animate-spin')
    expect(html.indexOf('Hi-Code')).toBeLessThan(html.indexOf('→'))
    expect(html.indexOf('→')).toBeLessThan(html.indexOf('zzone'))
  })

  it('shows a green check when generation succeeds', () => {
    const html = renderToStaticMarkup(<ApiProviderProgress attempts={[{ ...attempts[1], status: 'success' }]} taskStatus="done" imageCount={1} />)
    expect(html).toContain('生图成功')
    expect(html).toContain('text-emerald-500')
    expect(html).not.toContain('animate-spin')
  })

  it('does not keep spinning after interruption', () => {
    const html = renderToStaticMarkup(<ApiProviderProgress attempts={attempts} taskStatus="error" imageCount={1} />)
    expect(html).toContain('zzone：已停止')
    expect(html).not.toContain('animate-spin')
  })

  it('labels each concurrent image separately', () => {
    const html = renderToStaticMarkup(<ApiProviderProgress attempts={[{ ...attempts[0], requestIndex: 1 }, attempts[1]]} taskStatus="running" imageCount={2} />)
    expect(html).toContain('#1')
    expect(html).toContain('#2')
    expect(html.indexOf('zzone')).toBeLessThan(html.indexOf('Hi-Code'))
  })
})
