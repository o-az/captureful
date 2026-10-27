/**
 * @param {string} selector
 * @param {string} text
 */
function setText(selector, text) {
  const element = document.querySelector(selector)
  if (element) element.textContent = text
}

/**
 * Called from view-controller.swift via `evaluateJavaScript`.
 *
 * @param {'ios' | 'mac'} platform
 * @param {boolean} [enabled]
 * @param {boolean} [useSettingsInsteadOfPreferences]
 */
// oxlint-disable-next-line no-unused-vars -- called from native code
function show(platform, enabled, useSettingsInsteadOfPreferences) {
  document.body.classList.add(`platform-${platform}`)

  if (useSettingsInsteadOfPreferences) {
    setText(
      '.platform-mac.state-on',
      'Captureful’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.'
    )
    setText(
      '.platform-mac.state-off',
      'Captureful’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.'
    )
    setText(
      '.platform-mac.state-unknown',
      'You can turn on Captureful’s extension in the Extensions section of Safari Settings.'
    )
    setText('.platform-mac.open-preferences', 'Quit and Open Safari Settings…')
  }

  if (typeof enabled === 'boolean') {
    document.body.classList.toggle(`state-on`, enabled)
    document.body.classList.toggle(`state-off`, !enabled)
  } else {
    document.body.classList.remove(`state-on`)
    document.body.classList.remove(`state-off`)
  }
}

function openPreferences() {
  webkit.messageHandlers.controller.postMessage('open-preferences')
}

document.querySelector('button.open-preferences')?.addEventListener('click', openPreferences)

// Written into the app bundle by scripts/build-info.sh at build time.
const info = globalThis.buildInfo
if (info) {
  setText('.build-info', `${info.version} (${info.build}) · ${info.commit} · ${info.date}`)
}
