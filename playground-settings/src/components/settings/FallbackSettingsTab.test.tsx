import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import FallbackSettingsTab from './FallbackSettingsTab'

const profiles = ['Hi-Code', 'zzone'].map((name) => createDefaultOpenAIProfile({ id: name, name, apiKey: 'secret-do-not-render' }))

describe('fallback settings panel', () => {
  it('renders ordered checkbox cards, reorder controls and no credentials', () => {
    const draft = normalizeSettings({ profiles, imageApiFallback: {
      enabled: true, entries: [{ profileId: 'zzone', enabled: true }, { profileId: 'Hi-Code', enabled: false }],
    } })
    const html = renderToStaticMarkup(<FallbackSettingsTab draft={draft} profiles={profiles} commitSettings={() => {}} />)
    expect(html).toContain('启用 zzone')
    expect(html).toContain('上移 zzone')
    expect(html).toContain('下移 Hi-Code')
    expect(html).toContain('实际请求顺序：zzone')
    expect(html).toContain('已停用，不参与自动切换')
    expect(html).not.toContain('secret-do-not-render')
    expect(html.indexOf('启用 zzone')).toBeLessThan(html.indexOf('启用 Hi-Code'))
  })

  it('automatically disables fallback when no providers are selected', () => {
    const draft = normalizeSettings({ profiles, imageApiFallback: { enabled: true, entries: [] } })
    const html = renderToStaticMarkup(<FallbackSettingsTab draft={draft} profiles={profiles} commitSettings={() => {}} />)
    expect(html).toContain('自动切换已关闭，仅使用当前 API 配置。')
    expect(html).not.toContain('没有启用的中转站')
  })
})
