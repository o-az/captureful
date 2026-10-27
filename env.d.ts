/** Written into the app bundle by xcode/Captureful/scripts/build-info.sh; missing outside a build. */
declare var buildInfo: { version: string; build: string; commit: string; date: string } | undefined

/** WKWebView script message bridge, injected by view-controller.swift. */
declare var webkit: {
  messageHandlers: {
    controller: { postMessage(message: string): void }
  }
}
