import { describe, expect, it } from 'vitest'
import type { ImageApiAttempt } from '../types'
import { updateImageApiAttempts } from './imageApiProgress'

const primary: ImageApiAttempt = { profileId: 'hi', profileName: 'Hi-Code', requestIndex: 0, status: 'running' }

describe('image API attempt history', () => {
  it('updates status in place and appends fallback without losing failures', () => {
    const running = updateImageApiAttempts(undefined, primary)
    const failed = updateImageApiAttempts(running, { ...primary, status: 'error' })
    const next = updateImageApiAttempts(failed, { ...primary, profileId: 'jojo', profileName: 'Jojocode' })
    expect(running[0].status).toBe('running')
    expect(next.map((attempt) => [attempt.profileId, attempt.status])).toEqual([['hi', 'error'], ['jojo', 'running']])
  })

  it('keeps concurrent images separate even on the same provider', () => {
    const attempts = updateImageApiAttempts([primary], { ...primary, requestIndex: 1 })
    const updated = updateImageApiAttempts(attempts, { ...primary, requestIndex: 1, status: 'success' })
    expect(updated.map((attempt) => attempt.status)).toEqual(['running', 'success'])
  })

  it('keeps model fallback attempts separate on the same provider', () => {
    const sunburst: ImageApiAttempt = { profileId: 'zzone', profileName: 'zzone · sunburst', model: 'gpt-image-2.5-sunburst', requestIndex: 0, status: 'running' }
    const flare = updateImageApiAttempts([sunburst], { profileId: 'zzone', profileName: 'zzone · flare', model: 'gpt-image-2.5-flare', requestIndex: 0, status: 'running' })
    const updated = updateImageApiAttempts(flare, { ...sunburst, status: 'error' })
    expect(updated.map((attempt) => [attempt.profileName, attempt.status])).toEqual([
      ['zzone · sunburst', 'error'],
      ['zzone · flare', 'running'],
    ])
  })
})
