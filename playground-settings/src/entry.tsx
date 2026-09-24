import { createRoot } from 'react-dom/client'
import SettingsModal from './components/SettingsModal'
import { initStore, useStore } from './store'
import { createDefaultOpenAIProfile } from './lib/apiProfiles'
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

createRoot(mount).render(<SettingsModal />)

void initStore().then(() => {
  const state = useStore.getState()
  const settings = state.settings
  if (settings.profiles.length !== 1 || settings.profiles[0].apiKey || settings.imageApiFallback?.entries.length) return

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
