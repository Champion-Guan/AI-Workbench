import type { ImageApiAttempt } from '../types'

export function updateImageApiAttempts(attempts: ImageApiAttempt[] = [], attempt: ImageApiAttempt): ImageApiAttempt[] {
  const index = attempts.findIndex((item) => item.requestIndex === attempt.requestIndex && item.profileId === attempt.profileId && (item.model ?? '') === (attempt.model ?? ''))
  if (index < 0) return [...attempts, attempt]
  return attempts.map((item, itemIndex) => itemIndex === index ? attempt : item)
}
