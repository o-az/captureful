const DEFAULT_SETTINGS = { confirmArea: false, autoStop: true, scale: 0 }

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {{ new (): T; name: string }} type
 * @returns {T}
 */
const elementById = (id, type) => {
  const element = document.getElementById(id)
  if (!(element instanceof type)) throw new Error(`#${id} is not a ${type.name}`)
  return element
}

const confirmArea = elementById('confirmArea', HTMLInputElement)
const autoStop = elementById('autoStop', HTMLInputElement)
const scale = elementById('scale', HTMLSelectElement)

const load = async () => {
  const { settings } = await browser.storage.local.get('settings')
  const current = { ...DEFAULT_SETTINGS, ...settings }
  confirmArea.checked = current.confirmArea
  autoStop.checked = current.autoStop
  scale.value = String(current.scale)
}

const save = () =>
  browser.storage.local.set({
    settings: {
      confirmArea: confirmArea.checked,
      autoStop: autoStop.checked,
      scale: Number(scale.value)
    }
  })

for (const element of [confirmArea, autoStop, scale]) element.addEventListener('change', save)

elementById('forget', HTMLButtonElement).addEventListener('click', async () => {
  await browser.storage.local.remove('areas')
  elementById('status', HTMLSpanElement).textContent = 'Forgotten'
})

void load()
