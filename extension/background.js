/** @param {number} tabId */
const toggle = async tabId => {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'toggle' })
  } catch {
    // Tabs opened before the extension was enabled have no content script yet.
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    })
    await browser.tabs.sendMessage(tabId, { type: 'toggle' })
  }
}

browser.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) void toggle(tab.id)
})

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'capture' || (sender.frameId ?? 0) !== 0) return
  const windowId = sender.tab?.windowId
  const capture =
    windowId === undefined
      ? browser.tabs.captureVisibleTab({ format: 'png' })
      : browser.tabs.captureVisibleTab(windowId, { format: 'png' })
  return capture.then(
    url => ({ ok: true, url }),
    error => {
      if (error instanceof Error) return { ok: false, error: error.message }
      return { ok: false, error: String(error) }
    }
  )
})
