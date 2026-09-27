import type { ApiProfile, ImageApiFallbackSettings } from '../types'

export const IMAGE_FALLBACK_HOSTS = ['zzone.cc.cd', 'www.tixyw.com', 'api2.jojocode.com', 'api-cn.hi-code.cc']
const LEGACY_IMAGE_FALLBACK_HOSTS = [
  ['www.tixyw.com', 'api-cn.hi-code.cc', 'zzone.cc.cd', 'api2.jojocode.com'],
  ['zzone.cc.cd', 'www.tixyw.com', 'api-cn.hi-code.cc', 'api2.jojocode.com'],
]

export function getProfileHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function getDefaultImageApiFallback(profiles: ApiProfile[]): ImageApiFallbackSettings {
  const ordered = IMAGE_FALLBACK_HOSTS.flatMap((host) => {
    const profile = profiles.find((candidate) => candidate.provider === 'openai' && getProfileHostname(candidate.baseUrl) === host)
    return profile ? [{ profileId: profile.id, enabled: true }] : []
  })
  return {
    enabled: ordered.length > 0,
    entries: [...ordered, ...profiles
      .filter((profile) => profile.provider === 'openai' && !ordered.some((entry) => entry.profileId === profile.id))
      .map((profile) => ({ profileId: profile.id, enabled: false }))],
  }
}

export function normalizeImageApiFallback(input: unknown, profiles: ApiProfile[]): ImageApiFallbackSettings | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (!Array.isArray(record.entries)) return undefined
  const availableIds = new Set(profiles.filter((profile) => profile.provider === 'openai').map((profile) => profile.id))
  const seen = new Set<string>()
  const entries: ImageApiFallbackSettings['entries'] = []
  for (const entry of record.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.profileId !== 'string' ||
      !availableIds.has(entry.profileId) || seen.has(entry.profileId)) continue
    seen.add(entry.profileId)
    entries.push({ profileId: entry.profileId, enabled: entry.enabled === true })
  }
  for (const profileId of availableIds) {
    if (!seen.has(profileId)) entries.push({ profileId, enabled: false })
  }
  const matchesLegacyOrder = LEGACY_IMAGE_FALLBACK_HOSTS.some((legacyHosts) => {
    const legacyIds = legacyHosts.map((host) => profiles.find((profile) => getProfileHostname(profile.baseUrl) === host)?.id)
    return legacyIds.every((id): id is string => Boolean(id)) &&
      entries.length === legacyIds.length &&
      entries.every((entry, index) => entry.profileId === legacyIds[index] && entry.enabled)
  })
  if (matchesLegacyOrder) {
    return getDefaultImageApiFallback(profiles)
  }
  // The master switch mirrors the provider selections. A fallback chain is
  // useful as soon as at least one station is selected, and it must turn off
  // when every station is unselected.
  return { enabled: entries.some((entry) => entry.enabled), entries }
}

export function moveImageFallbackEntry(
  entries: ImageApiFallbackSettings['entries'],
  profileId: string,
  targetId: string,
): ImageApiFallbackSettings['entries'] {
  const fromIndex = entries.findIndex((entry) => entry.profileId === profileId)
  const toIndex = entries.findIndex((entry) => entry.profileId === targetId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return entries
  const next = [...entries]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}
