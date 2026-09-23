import type { ApiProfile, AppSettings } from '../types'
import { normalizeSettings } from './apiProfiles'
import { getDefaultImageApiFallback, getProfileHostname } from './imageApiFallbackSettings'

const IXY_EXHAUSTED_KEY = 'gpt-image-playground:ixy-exhausted'
const IXY_HOST = 'www.tixyw.com'
const MODEL_FALLBACK_HOSTS = new Set(['zzone.cc.cd', 'api-cn.hi-code.cc'])
const ZZONE_SUNBURST_MODEL = 'gpt-image-2.5-sunburst'
const ZZONE_FLARE_MODEL = 'gpt-image-2.5-flare'

export function isImageProviderExhausted(profile: ApiProfile): boolean {
  if (getProfileHostname(profile.baseUrl) !== IXY_HOST) return false
  try {
    return localStorage.getItem(IXY_EXHAUSTED_KEY) === 'true'
  } catch {
    return false
  }
}

export function resetImageProviderExhausted(profile: ApiProfile): void {
  if (getProfileHostname(profile.baseUrl) !== IXY_HOST) return
  localStorage.removeItem(IXY_EXHAUSTED_KEY)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('image-provider-exhausted'))
}

export function markImageProviderExhausted(profile: ApiProfile, error: unknown): void {
  if (getProfileHostname(profile.baseUrl) !== IXY_HOST) return
  const message = error instanceof Error ? error.message : String(error)
  if (!/insufficient_quota|insufficient[ _-](?:balance|credit)|(?:余额|可用额度)不足|余额已用完|quota (?:exhausted|depleted)/i.test(message)) return
  try {
    localStorage.setItem(IXY_EXHAUSTED_KEY, 'true')
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('image-provider-exhausted'))
  } catch {
    return
  }
}

export function getImageApiRequestProfiles(profile: ApiProfile): ApiProfile[] {
  if (!MODEL_FALLBACK_HOSTS.has(getProfileHostname(profile.baseUrl)) || profile.model !== ZZONE_SUNBURST_MODEL) return [profile]
  return [
    { ...profile, name: `${profile.name} · sunburst` },
    { ...profile, name: `${profile.name} · flare`, model: ZZONE_FLARE_MODEL },
  ]
}

export interface ImageApiFallbackProfiles {
  primary?: ApiProfile
  fallback?: ApiProfile
  profiles: ApiProfile[]
}

export function getImageApiFallbackProfiles(settings: AppSettings | unknown): ImageApiFallbackProfiles | null {
  const normalized = normalizeSettings(settings)
  const config = normalized.imageApiFallback ?? getDefaultImageApiFallback(normalized.profiles)
  if (!config.enabled) return null
  const available = config.entries.flatMap((entry) => {
    if (!entry.enabled) return []
    const profile = normalized.profiles.find((candidate) => candidate.id === entry.profileId)
    return profile && !isImageProviderExhausted(profile) ? [profile] : []
  })
  return { primary: available[0], fallback: available[1], profiles: available }
}
