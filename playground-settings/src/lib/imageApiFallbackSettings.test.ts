import { describe, expect, it } from 'vitest'
import { createDefaultOpenAIProfile, mergePresetImportedSettings, normalizeSettings } from './apiProfiles'
import { getDefaultImageApiFallback, moveImageFallbackEntry, normalizeImageApiFallback } from './imageApiFallbackSettings'

const profiles = ['www.tixyw.com', 'api-cn.hi-code.cc', 'zzone.cc.cd', 'api2.jojocode.com']
  .map((host) => createDefaultOpenAIProfile({ id: host, name: host, baseUrl: `https://${host}/v1`, model: 'gpt-image-2' }))

describe('user-configurable fallback settings', () => {
  it('preserves the configured default order independently of profile array order', () => {
    expect(getDefaultImageApiFallback([...profiles].reverse())).toEqual({
      enabled: true, entries: [profiles[2], profiles[0], profiles[3], profiles[1]].map((profile) => ({ profileId: profile.id, enabled: true })),
    })
  })

  it('normalizes duplicate and stale IDs without enabling new profiles', () => {
    expect(normalizeImageApiFallback({
      enabled: true,
      entries: [
        { profileId: profiles[2].id, enabled: true },
        { profileId: profiles[0].id, enabled: false },
        { profileId: profiles[2].id, enabled: false },
        { profileId: 'deleted', enabled: true },
        null,
      ],
    }, profiles)?.entries).toEqual([
      { profileId: profiles[2].id, enabled: true },
      { profileId: profiles[0].id, enabled: false },
      { profileId: profiles[1].id, enabled: false },
      { profileId: profiles[3].id, enabled: false },
    ])
  })

  it('migrates the previous all-enabled default order to the current priority order', () => {
    const legacy = { enabled: true, entries: profiles.map((profile) => ({ profileId: profile.id, enabled: true })) }
    expect(normalizeImageApiFallback(legacy, profiles)?.entries).toEqual([
      { profileId: profiles[2].id, enabled: true },
      { profileId: profiles[0].id, enabled: true },
      { profileId: profiles[3].id, enabled: true },
      { profileId: profiles[1].id, enabled: true },
    ])
  })

  it('derives the master setting from provider selections through persistence normalization', () => {
    const config = { enabled: false, entries: [...profiles].reverse().map((profile, index) => ({ profileId: profile.id, enabled: index % 2 === 0 })) }
    const settings = normalizeSettings({ profiles, imageApiFallback: config })
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings))).imageApiFallback).toEqual({
      ...config,
      enabled: true,
    })
  })

  it('allows intentionally disabling every provider', () => {
    const normalized = normalizeImageApiFallback({ enabled: true, entries: [] }, profiles)
    expect(normalized?.entries.every((entry) => !entry.enabled)).toBe(true)
    expect(normalized?.enabled).toBe(false)
    expect(normalizeImageApiFallback(undefined, profiles)).toBeUndefined()
    expect(normalizeImageApiFallback({ entries: 'invalid' }, profiles)).toBeUndefined()
  })

  it('moves entries in both directions while retaining enable flags', () => {
    const entries = profiles.map((profile, index) => ({ profileId: profile.id, enabled: index !== 1 }))
    const next = moveImageFallbackEntry(entries, profiles[3].id, profiles[0].id)
    expect(next.map((entry) => entry.profileId)).toEqual([profiles[3].id, profiles[0].id, profiles[1].id, profiles[2].id])
    expect(moveImageFallbackEntry(next, profiles[3].id, profiles[2].id)).toEqual(entries)
    expect(moveImageFallbackEntry(entries, 'missing', profiles[0].id)).toBe(entries)
    expect(entries[1].enabled).toBe(false)
  })

  it('migrates custom ordering when preset profile IDs are deduplicated', () => {
    const legacy = { ...profiles[3], id: 'old-jojo' }
    const config = { enabled: true, entries: [
      { profileId: legacy.id, enabled: false },
      { profileId: profiles[1].id, enabled: true },
    ] }
    const merged = mergePresetImportedSettings(
      { profiles: [legacy, profiles[1]], imageApiFallback: config },
      { profiles: [{ ...profiles[1], isDefault: true }, profiles[3]] },
      { migrateEquivalentProfileIds: true, lockPresetParams: true },
    )
    expect(merged.settings.imageApiFallback?.entries).toEqual([
      { profileId: profiles[3].id, enabled: false },
      { profileId: profiles[1].id, enabled: true },
    ])
  })
})
