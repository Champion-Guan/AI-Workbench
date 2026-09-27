import { createRoot } from 'react-dom/client'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import { applyImageProfileBalanceChange, initStore, useStore } from './store'
import { createDefaultOpenAIProfile, getActiveApiProfile, normalizeSettings, validateApiProfile } from './lib/apiProfiles'
import { callImageApi } from './lib/api'
import { normalizeParamsForSettings } from './lib/paramCompatibility'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import './settings.css'

const mount = document.createElement('div')
mount.id = 'playground-settings-root'

// Keep the real settings React tree inside the workbench's Radix dialog so it
// stays within the dialog focus scope. Nested settings dialogs portal to this
// same mount, where the settings layer styles keep them above the panel.
const placeMount = () => {
  const workbenchDialog = document.querySelector<HTMLElement>(
    '[role="dialog"][data-slot="dialog-content"]',
  )
  const parent = workbenchDialog ?? document.body
  if (mount.parentElement !== parent) parent.append(mount)
  return Boolean(workbenchDialog)
}

placeMount()
const mountObserver = new MutationObserver(() => {
  if (placeMount()) mountObserver.disconnect()
})
mountObserver.observe(document.documentElement, { childList: true, subtree: true })

createRoot(mount).render(
  <>
    <SettingsModal />
    <ConfirmDialog />
  </>,
)

/**
 * Run background removal through the same active image configuration as the
 * gallery.  This is exposed only to the local workbench bridge; credentials
 * remain in the persisted browser settings and are never written to source.
 */
async function generateBackgroundRemoval(inputImageDataUrl: string) {
  if (!inputImageDataUrl?.startsWith('data:')) {
    throw new Error('待处理图片数据无效')
  }

  const state = useStore.getState()
  const settings = normalizeSettings(state.settings)
  const activeProfile = getActiveApiProfile(settings)
  const profileError = validateApiProfile(activeProfile)
  if (profileError) throw new Error(`请先完善生图配置：${profileError}`)

  const baseParams = {
    ...state.params,
    n: 1,
    output_format: 'png' as const,
    output_compression: null,
    transparent_output: true,
  }
  const normalizedParams = normalizeParamsForSettings(baseParams, settings, { hasInputImages: true })
  const requestParams = getTransparentRequestParams({
    ...normalizedParams,
    output_format: 'png',
    output_compression: null,
    transparent_output: true,
    n: 1,
  })
  const prompt = [
    'Remove the background from the provided product image.',
    'Preserve the exact product identity, shape, proportions, materials, colors, logos, text, and fine details without redesigning or replacing it.',
    'Keep the complete product visible, centered, and sharply separated from the background.',
    'Return one PNG with a truly transparent background and no shadow, reflection, props, or extra objects.',
  ].join(' ')
  const useLocalTransparentPostProcess = activeProfile.transparentBackgroundMethod === 'local'
  const result = await callImageApi({
    settings,
    onProfileBalanceChange: applyImageProfileBalanceChange,
    prompt: useLocalTransparentPostProcess ? createTransparentOutputMeta(prompt).effectivePrompt : prompt,
    params: requestParams,
    nativeTransparentBackground: !useLocalTransparentPostProcess,
    inputImageDataUrls: [inputImageDataUrl],
  })
  let dataUrl = result.images[0]
  if (!dataUrl) throw new Error('接口未返回处理后的图片')
  if (useLocalTransparentPostProcess) {
    dataUrl = await removeKeyedBackgroundFromDataUrl(dataUrl, undefined, 'png')
  }
  return {
    dataUrl,
    profileName: result.apiProfileId
      ? settings.profiles.find((profile) => profile.id === result.apiProfileId)?.name ?? activeProfile.name
      : activeProfile.name,
  }
}

type LocalWorkbenchGenerationBridge = {
  generateBackgroundRemoval?: (inputImageDataUrl: string) => Promise<{ dataUrl: string; profileName: string }>
}

;(window as Window & { __localWorkbenchGeneration?: LocalWorkbenchGenerationBridge }).__localWorkbenchGeneration = {
  generateBackgroundRemoval,
}

void initStore().then(() => {
  const state = useStore.getState()
  const settings = state.settings
  if (settings.profiles.length === 1 && !settings.profiles[0].apiKey && !settings.imageApiFallback?.entries.length) {
    const profiles = [
      createDefaultOpenAIProfile({
        id: 'zzone',
        name: 'zzone',
        baseUrl: 'https://zzone.cc.cd/v1',
        apiKey: '',
        model: 'gpt-image-2.5-sunburst',
      }),
      createDefaultOpenAIProfile({
        id: 'ixyapi',
        name: 'IXYAPI',
        baseUrl: 'https://www.tixyw.com/v1',
        apiKey: '',
        model: 'gpt-image-2',
      }),
      createDefaultOpenAIProfile({
        id: 'jojocode',
        name: 'Jojocode',
        baseUrl: 'https://api2.jojocode.com/v1',
        apiKey: '',
        model: 'gpt-image-2',
      }),
      createDefaultOpenAIProfile({
        id: 'hi-code',
        name: 'Hi-Code',
        baseUrl: 'https://api-cn.hi-code.cc/v1',
        apiKey: '',
        model: 'gpt-image-2.5-sunburst',
      }),
    ]
    state.setSettings({
      ...settings,
      profiles,
      activeProfileId: 'zzone',
      imageApiFallback: {
        enabled: true,
        entries: profiles.map((profile) => ({ profileId: profile.id, enabled: true })),
      },
    })
  }
  window.dispatchEvent(new CustomEvent('local-workbench-generation-ready'))
}).catch((error) => {
  console.error('Playground settings initialization failed:', error)
})

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.local-workbench-settings-button')) return
  event.preventDefault()
  event.stopImmediatePropagation()
  useStore.getState().setShowSettings(true, 'api')
}, true)

useStore.subscribe((state) => {
  document
    .querySelector('.local-workbench-settings-button')
    ?.setAttribute('aria-expanded', String(state.showSettings))
})
