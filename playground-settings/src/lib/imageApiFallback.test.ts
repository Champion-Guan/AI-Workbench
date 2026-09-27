import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getImageApiFallbackProfiles, markImageProviderExhausted } from './imageApiFallback'
import { callImageApi } from './api'

const profiles = [
  ['zzone', 'zzone.cc.cd'],
  ['IXYAPI', 'www.tixyw.com'],
  ['Hi-Code', 'api-cn.hi-code.cc'],
  ['Jojocode', 'api2.jojocode.com'],
].map(([name, host]) => createDefaultOpenAIProfile({
  id: name, name, baseUrl: `https://${host}/v1`, model: 'gpt-image-2', apiKey: `${name}-test-key`,
}))
const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [...profiles].reverse(), activeProfileId: 'Jojocode' })
const options = { settings, params: DEFAULT_PARAMS, prompt: 'test', inputImageDataUrls: [] }
const success = () => new Response(JSON.stringify({ data: [{ b64_json: 'dGVzdA==' }] }))
const failure = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 503 })

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('four-provider fallback', () => {
  it('falls back when the relay loses a potentially billed result', async () => {
    const onProviderAttempt = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: '连接中断，上游可能已经扣费' } }),
        { status: 502, headers: { 'X-Image-Result-State': 'unknown', 'X-Image-Relay-Request-Id': 'diagnostic-123' } },
      ))
      .mockResolvedValueOnce(success())
    const result = await callImageApi({ ...options, onProviderAttempt })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.apiProfileId).toBe('IXYAPI')
    expect(onProviderAttempt.mock.calls.map(([attempt]) => attempt.status)).toEqual(['running', 'error', 'running', 'success'])
    expect(onProviderAttempt.mock.calls[1][0].error).toContain('diagnostic-123')
  })

  it('falls back after receiving a truncated successful relay response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        '{"data":[{"b64_json":',
        { status: 200, headers: { 'X-Image-Relay-Request-Id': 'truncated-123' } },
      ))
      .mockResolvedValueOnce(success())
    const result = await callImageApi(options)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.apiProfileId).toBe('IXYAPI')
  })

  it('still falls back for a complete explicit provider error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'model unavailable' } }), {
        status: 503, headers: { 'X-Image-Relay-Request-Id': 'upstream-123' },
      }))
      .mockResolvedValueOnce(success())
    const result = await callImageApi(options)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.apiProfileId).toBe('IXYAPI')
  })

  it('tries zzone flare before leaving zzone', async () => {
    const zzoneSettings = normalizeSettings({
      ...settings,
      profiles: profiles.map((profile) => profile.id === 'zzone' ? { ...profile, model: 'gpt-image-2.5-sunburst' } : profile),
    })
    const events: unknown[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('sunburst unavailable'))
      .mockResolvedValueOnce(success())
    const result = await callImageApi({ ...options, settings: zzoneSettings, onProviderAttempt: (attempt) => events.push(attempt) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe('gpt-image-2.5-sunburst')
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).model).toBe('gpt-image-2.5-flare')
    expect(result).toMatchObject({ apiProfileId: 'zzone', apiModel: 'gpt-image-2.5-flare' })
    expect(events).toEqual([
      { profileId: 'zzone', profileName: 'zzone · sunburst', model: 'gpt-image-2.5-sunburst', requestIndex: 0, status: 'running' },
      { profileId: 'zzone', profileName: 'zzone · sunburst', model: 'gpt-image-2.5-sunburst', requestIndex: 0, status: 'error', error: 'sunburst unavailable' },
      { profileId: 'zzone', profileName: 'zzone · flare', model: 'gpt-image-2.5-flare', requestIndex: 0, status: 'running' },
      { profileId: 'zzone', profileName: 'zzone · flare', model: 'gpt-image-2.5-flare', requestIndex: 0, status: 'success' },
    ])
  })

  it('continues to the next provider after both zzone models fail', async () => {
    const zzoneSettings = normalizeSettings({
      ...settings,
      profiles: profiles.map((profile) => profile.id === 'zzone' ? { ...profile, model: 'gpt-image-2.5-sunburst' } : profile),
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('sunburst unavailable'))
      .mockResolvedValueOnce(failure('flare unavailable'))
      .mockResolvedValueOnce(success())
    const result = await callImageApi({ ...options, settings: zzoneSettings })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://zzone.cc.cd/v1/images/generations',
      'https://zzone.cc.cd/v1/images/generations',
      'https://www.tixyw.com/v1/images/generations',
    ])
    expect(result.apiProfileId).toBe('IXYAPI')
  })

  it('uses the same model fallback for Hi-Code', async () => {
    const hiSettings = normalizeSettings({
      ...settings,
      profiles: profiles.map((profile) => profile.id === 'Hi-Code' ? { ...profile, model: 'gpt-image-2.5-sunburst' } : profile),
      imageApiFallback: { enabled: true, entries: [
        { profileId: 'Hi-Code', enabled: true },
        { profileId: 'Jojocode', enabled: true },
      ] },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('sunburst unavailable'))
      .mockResolvedValueOnce(success())
    const result = await callImageApi({ ...options, settings: hiSettings })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe('gpt-image-2.5-sunburst')
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).model).toBe('gpt-image-2.5-flare')
    expect(result).toMatchObject({ apiProfileId: 'Hi-Code', apiModel: 'gpt-image-2.5-flare' })
  })

  it('honors custom order and skips disabled providers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('offline'))
      .mockResolvedValueOnce(success())
    const result = await callImageApi({ ...options, settings: {
      ...settings,
      imageApiFallback: { enabled: true, entries: [
        { profileId: 'zzone', enabled: true },
        { profileId: 'Hi-Code', enabled: false },
        { profileId: 'Jojocode', enabled: true },
        { profileId: 'IXYAPI', enabled: false },
      ] },
    } })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://zzone.cc.cd/v1/images/generations', 'https://api2.jojocode.com/v1/images/generations',
    ])
    expect(result.apiProfileId).toBe('Jojocode')
  })

  it('falls back to the active profile when all providers are disabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure('offline'))
    await expect(callImageApi({ ...options, settings: {
      ...settings, imageApiFallback: { enabled: true, entries: [] },
    } })).rejects.toThrow('offline')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('api2.jojocode.com')
  })

  it('uses only the active profile when automatic fallback is off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure('offline'))
    await expect(callImageApi({ ...options, settings: {
      ...settings, imageApiFallback: { enabled: false, entries: [] },
    } })).rejects.toThrow('offline')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('api2.jojocode.com')
  })

  it('only tries the sole enabled provider even when it fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure('offline'))
    await expect(callImageApi({ ...options, settings: {
      ...settings, imageApiFallback: { enabled: true, entries: [{ profileId: 'zzone', enabled: true }] },
    } })).rejects.toThrow('offline')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('zzone.cc.cd')
  })

  it('emits live attempts in fallback order without including credentials', async () => {
    const events: unknown[] = []
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('offline'))
      .mockResolvedValueOnce(success())
    await callImageApi({ ...options, onProviderAttempt: (attempt) => events.push(attempt) })
    expect(events).toEqual([
      { profileId: 'zzone', profileName: 'zzone', requestIndex: 0, status: 'running' },
      { profileId: 'zzone', profileName: 'zzone', requestIndex: 0, status: 'error', error: 'offline' },
      { profileId: 'IXYAPI', profileName: 'IXYAPI', requestIndex: 0, status: 'running' },
      { profileId: 'IXYAPI', profileName: 'IXYAPI', requestIndex: 0, status: 'success' },
    ])
  })

  it('reports per-image progress for concurrent generations', async () => {
    const events: Array<{ requestIndex: number; status: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => success())
    await callImageApi({
      ...options, params: { ...DEFAULT_PARAMS, n: 2 },
      onProviderAttempt: (attempt) => events.push(attempt),
    })
    expect(events.filter((attempt) => attempt.status === 'success').map((attempt) => attempt.requestIndex).sort()).toEqual([0, 1])
  })

  it('reports cancellation rather than provider failure when aborted', async () => {
    const controller = new AbortController()
    const onProviderAttempt = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw new DOMException('cancelled', 'AbortError')
    })
    await expect(callImageApi({ ...options, signal: controller.signal, onProviderAttempt })).rejects.toThrow('cancelled')
    expect(onProviderAttempt.mock.calls.map(([attempt]) => attempt.status)).toEqual(['running', 'cancelled'])
  })

  it('uses host identity and fixed order regardless of selection or array order', () => {
    expect(getImageApiFallbackProfiles(settings)?.profiles.map((profile) => profile.name))
      .toEqual(['zzone', 'IXYAPI', 'Jojocode', 'Hi-Code'])
    expect(getImageApiFallbackProfiles({
      ...settings, profiles: profiles.map((profile) => ({ ...profile, baseUrl: 'https://unrelated.example/v1' })),
    })).toBeNull()
  })

  it.each([0, 1, 2, 3])('stops after provider %i succeeds', async (successfulIndex) => {
    const orderedProfiles = [profiles[0], profiles[1], profiles[3], profiles[2]]
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (let index = 0; index < successfulIndex; index += 1) fetchMock.mockResolvedValueOnce(failure(`failure ${index}`))
    fetchMock.mockResolvedValueOnce(success())
    const result = await callImageApi(options)
    expect(result.apiProfileId ?? settings.activeProfileId).toBe(orderedProfiles[successfulIndex].id)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(orderedProfiles.slice(0, successfulIndex + 1).map((profile) => `${profile.baseUrl}/images/generations`))
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[1]?.headers).toMatchObject({ Authorization: `Bearer ${orderedProfiles[index].apiKey}` })
    }
  })

  it('reports every failure only after all four providers fail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const profile of profiles) fetchMock.mockResolvedValueOnce(failure(`${profile.name} offline`))
    const error = await callImageApi(options).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    for (const profile of profiles) expect((error as Error).message).toContain(`${profile.name} offline`)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('starts new requests at zzone after transient failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('rate limit'))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
    await callImageApi(options)
    await callImageApi(options)
    expect(fetchMock.mock.calls[2][0]).toContain('zzone.cc.cd')
  })

  it('persistently skips IXYAPI only after explicit balance exhaustion', async () => {
    const ixyProfile = profiles.find((profile) => profile.id === 'IXYAPI')!
    markImageProviderExhausted(ixyProfile, 'insufficient balance')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failure('offline'))
      .mockResolvedValueOnce(success())
    await callImageApi(options)
    expect(fetchMock.mock.calls[0][0]).toContain('zzone.cc.cd')
    expect(fetchMock.mock.calls[1][0]).toContain('api2.jojocode.com')
    expect(localStorage.getItem('gpt-image-playground:ixy-exhausted')).toBe('true')
  })

  it.each(['Unauthorized', '429 Too Many Requests', 'network error', 'timeout', 'quota rate limit'])('does not retire IXYAPI for %s', (message) => {
    markImageProviderExhausted(profiles.find((profile) => profile.id === 'IXYAPI')!, message)
    expect(getImageApiFallbackProfiles(settings)?.primary?.id).toBe('zzone')
  })

  it('does not retire IXYAPI when another provider has no balance', () => {
    markImageProviderExhausted(profiles.find((profile) => profile.id === 'Hi-Code')!, 'insufficient balance')
    expect(getImageApiFallbackProfiles(settings)?.primary?.id).toBe('zzone')
  })

  it.each(['2880x2880', '3840x2160', '3200x2400'])('uses Jojocode 4K model for %s', async (size) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(failure('offline'))
    fetchMock.mockResolvedValueOnce(failure('offline'))
    fetchMock.mockResolvedValueOnce(success())
    await callImageApi({ ...options, params: { ...DEFAULT_PARAMS, size } })
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string).model).toBe('gpt-image-2-4k')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe('gpt-image-2')
  })

  it('does not fallback when cancelled during an in-flight request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
      controller.abort()
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('cancelled', 'AbortError')
    })
    await expect(callImageApi({ ...options, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
