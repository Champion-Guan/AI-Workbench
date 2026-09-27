import type { ApiProfile } from '../types'
import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { getImageApiFallbackProfiles, getImageApiRequestProfiles, markImageProviderExhausted } from './imageApiFallback'
import { callOpenAICompatibleImageApi, mergeConcurrentApiResults } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('请求已停止', 'AbortError')
}

function getErrorProperty(err: unknown, key: 'rawImageUrls' | 'rawResponsePayload'): unknown {
  return err && typeof err === 'object' ? (err as Record<string, unknown>)[key] : undefined
}

function getOptionalAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function getProfileCharge(profile: ApiProfile, imageCount: number) {
  const price = getOptionalAmount(profile.price)
  const balance = getOptionalAmount(profile.balance)
  if (price === undefined || balance === undefined) return null
  const count = Math.max(1, Math.trunc(imageCount || 1))
  return { price, balance, cost: price * count }
}

const profileBalanceReservations = new Map<string, number>()

async function reserveProfileCharge(opts: CallApiOptions, profile: ApiProfile, imageCount: number) {
  const charge = getProfileCharge(profile, imageCount)
  if (!charge || charge.cost <= 0) return null
  const reserved = profileBalanceReservations.get(profile.id) ?? 0
  if (charge.balance + 1e-9 < charge.cost) {
    await opts.onProfileBalanceChange?.({ profileId: profile.id, cost: 0, insufficient: true })
    throw new Error(`${profile.name} 余额不足（需要 ¥${charge.cost.toFixed(2)}，剩余 ¥${charge.balance.toFixed(2)}），已自动跳过该配置`)
  }
  if (charge.balance - reserved + 1e-9 < charge.cost) {
    const remaining = Math.max(0, charge.balance - reserved)
    throw new Error(`${profile.name} 余额已由其他并发请求预留（可用 ¥${remaining.toFixed(2)}），本次自动跳过该配置`)
  }
  profileBalanceReservations.set(profile.id, reserved + charge.cost)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const current = profileBalanceReservations.get(profile.id) ?? 0
    const next = Math.max(0, current - charge.cost)
    if (next <= 1e-9) profileBalanceReservations.delete(profile.id)
    else profileBalanceReservations.set(profile.id, next)
  }
  return { release, cost: charge.cost }
}

async function settleProfileCharge(opts: CallApiOptions, profile: ApiProfile, reservation: { release: () => void; cost: number } | null, imageCount: number) {
  if (!reservation) return
  const charge = getProfileCharge(profile, imageCount)
  reservation.release()
  if (!charge || charge.price <= 0) return
  await opts.onProfileBalanceChange?.({
    profileId: profile.id,
    cost: Math.min(charge.cost, reservation.cost),
    insufficient: false,
  })
}

function getProfileRequestModel(profile: ApiProfile, size: string): string {
  if (profile.model !== 'gpt-image-2.5' || new URL(profile.baseUrl || 'https://localhost').hostname.toLowerCase() !== 'api-cn.hi-code.cc') return profile.model
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match || Number(match[1]) * Number(match[2]) <= 1_572_864) return 'gpt-image-2.5'
  return 'gpt-image-2'
}

function createFallbackError(primary: ApiProfile, primaryError: unknown, fallback: ApiProfile, fallbackError: unknown): Error {
  const previous = getErrorMessage(primaryError)
  const error = new Error(`${previous.startsWith(`${primary.name} 请求失败：`) ? previous : `${primary.name} 请求失败：${previous}`}\n已自动切换 ${fallback.name} 重试，但仍失败：${getErrorMessage(fallbackError)}`)
  const rawImageUrls = getErrorProperty(fallbackError, 'rawImageUrls') ?? getErrorProperty(primaryError, 'rawImageUrls')
  const rawResponsePayload = getErrorProperty(fallbackError, 'rawResponsePayload') ?? getErrorProperty(primaryError, 'rawResponsePayload')
  if (rawImageUrls !== undefined) (error as Error & { rawImageUrls?: unknown }).rawImageUrls = rawImageUrls
  if (rawResponsePayload !== undefined) (error as Error & { rawResponsePayload?: unknown }).rawResponsePayload = rawResponsePayload
  return error
}

async function callImageApiForProfile(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const configuredModel = profile.model
  profile = { ...profile, model: getProfileRequestModel(profile, opts.params.size) }
  if (/^https:\/\/api2\.jojocode\.com(?:\/|$)/i.test(profile.baseUrl) &&
    profile.model === 'gpt-image-2' &&
    opts.params.size.split('x').reduce((pixels, dimension) => pixels * Number(dimension), 1) > 4_194_304) {
    const result = await callOpenAICompatibleImageApi(opts, { ...profile, model: 'gpt-image-2-4k' })
    return { ...result, apiModel: 'gpt-image-2-4k' }
  }
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)
  const result = await callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
  return profile.model === configuredModel ? result : { ...result, apiModel: profile.model }
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const activeProfile = getActiveApiProfile(opts.settings)
  const fallbackProfiles = getImageApiFallbackProfiles(opts.settings)
  const profiles = fallbackProfiles?.profiles ?? [activeProfile]
  if (!profiles.length) throw new Error('Fallback 没有启用的中转站，请在设置 → Fallback 配置中至少启用一个。')
  if (fallbackProfiles && opts.params.n > 1) {
    const results = await Promise.allSettled(Array.from({ length: opts.params.n }, (_, requestIndex) => callImageApi({
      ...opts,
      params: { ...opts.params, n: 1 },
      onProviderAttempt: opts.onProviderAttempt
        ? (attempt) => opts.onProviderAttempt?.({ ...attempt, requestIndex })
        : undefined,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
        : undefined,
    })))
    if (opts.signal?.aborted) throw getAbortReason(opts.signal)
    return mergeConcurrentApiResults(results)
  }
  const requestProfiles = profiles.flatMap((profile) => getImageApiRequestProfiles(profile).map((requestProfile) => ({ profile, requestProfile })))
  let firstError: unknown
  let firstRequestProfile: ApiProfile | undefined

  for (let index = 0; index < requestProfiles.length; index += 1) {
    const { profile, requestProfile } = requestProfiles[index]
    if (opts.signal?.aborted) throw getAbortReason(opts.signal)
    const attempt = {
      profileId: profile.id,
      profileName: requestProfile.name,
      ...(requestProfile.name !== profile.name ? { model: requestProfile.model } : {}),
      requestIndex: 0,
    }
    opts.onProviderAttempt?.({ ...attempt, status: 'running' })

    let reservation: Awaited<ReturnType<typeof reserveProfileCharge>> = null
    try {
      reservation = await reserveProfileCharge(opts, requestProfile, opts.params.n)
      const result = await callImageApiForProfile(opts, requestProfile)
      if (!result.images.length) throw new Error(`${requestProfile.name} 未返回图片数据`)
      await settleProfileCharge(opts, requestProfile, reservation, result.images.length)
      reservation = null
      opts.onProviderAttempt?.({ ...attempt, status: 'success' })
      const modelResult = requestProfile.model === profile.model ? result : { ...result, apiModel: requestProfile.model }
      if (!fallbackProfiles && profile.id === activeProfile.id && requestProfile.model === profile.model) return modelResult
      return { ...modelResult, apiProfileId: profile.id }
    } catch (err) {
      reservation?.release()
      opts.onProviderAttempt?.({
        ...attempt,
        status: opts.signal?.aborted ? 'cancelled' : 'error',
        error: getErrorMessage(err),
      })
      if (opts.signal?.aborted) throw err
      markImageProviderExhausted(profile, err)
      const combinedError = firstError === undefined
        ? err
        : createFallbackError(firstRequestProfile ?? requestProfile, firstError, requestProfile, err)
      if (index === requestProfiles.length - 1) {
        throw combinedError
      }
      firstError = combinedError
      firstRequestProfile ??= requestProfile
    }
  }

  throw new Error('图像请求失败')
}
