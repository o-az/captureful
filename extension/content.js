;(() => {
  if ('__capturefulLoaded' in globalThis) return
  Object.defineProperty(globalThis, '__capturefulLoaded', { value: true })

  const SHADOW_SEPARATOR = ' >>> '
  const MAXIMUM_CANVAS_AREA = 16_777_216
  const MAXIMUM_CANVAS_SIDE = 16_384
  const MAXIMUM_PDF_PAGE_POINTS = 14_400
  const IDLE_CAPTURE_MILLISECONDS = 140
  const AUTO_STOP_MILLISECONDS = 3000
  const AUTO_SCROLL_STEP = 0.8
  const CAPTURE_TIMEOUT_MILLISECONDS = 4000
  /** Maximum CSS px a manual scroll may move during a shot for it to be kept. */
  const MAXIMUM_SHOT_DRIFT = 24
  /** Maximum CSS px a frame's tracked position is corrected by pixel matching. */
  const MAXIMUM_ALIGN_SHIFT = 48
  const SIGNATURE_COLUMNS = 32
  /** Overlays this close to the band's edge (e.g. a date pill under a header) are trimmed too. */
  const EDGE_SLACK = 12
  /** How far our overlays' drop shadow reaches past their box, in CSS px. */
  const OWN_UI_SHADOW = 24
  /** Smallest crop side, in CSS px of the preview. */
  const MINIMUM_CROP_CSS = 60
  /** Dragging a crop handle this close to the preview's top or bottom scrolls it. */
  const CROP_SCROLL_ZONE = 48
  /** Maximum CSS px the preview scrolls per frame while dragging a crop handle. */
  const CROP_SCROLL_SPEED = 24
  const CROP_HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
  /** A tap in pick mode selects the smallest block at least this many CSS px wide and tall. */
  const MINIMUM_PICK_SIDE = 80
  /**
   * CSS px past a picked part's last edge that auto-scroll aims for, since the band's own edges
   * shift a little between frames (the pill above which it ends changes height with its text).
   */
  const REGION_END_MARGIN = 16
  /** @type {{ confirmArea: boolean; autoStop: boolean; scale: number }} */
  const DEFAULT_SETTINGS = { confirmArea: false, autoStop: true, scale: 0 }

  /* --------------------------------- storage ---------------------------------- */

  /** @type {typeof DEFAULT_SETTINGS} */
  let settings = { ...DEFAULT_SETTINGS }
  /** @type {Record<string, string>} */
  let areas = {}

  const loadStorage = async () => {
    try {
      const stored = await browser.storage.local.get(['settings', 'areas'])
      settings = { ...DEFAULT_SETTINGS, ...stored.settings }
      areas = stored.areas ?? {}
    } catch (error) {
      console.warn('[captureful] storage unavailable', error)
    }
  }

  /** @param {string | null} selector */
  const saveArea = selector => {
    if (selector) areas[location.host] = selector
    else delete areas[location.host]
    void browser.storage.local.set({ areas })
  }

  /* ------------------------------ scroll targets ------------------------------ */

  const scrollingElement = () => document.scrollingElement || document.documentElement

  /** @param {Element} element */
  const isDocumentTarget = element =>
    element === scrollingElement() ||
    element === document.documentElement ||
    element === document.body

  /**
   * Parent element, stepping out of shadow roots to their host.
   *
   * @param {Element} element
   * @returns {Element | null}
   */
  const parentOf = element =>
    element.parentElement ||
    (element.parentNode instanceof ShadowRoot ? element.parentNode.host : null)

  /** @param {Element} element */
  const isOwnUi = element => element === ui?.host || element === calibrationMarker

  /**
   * Every element in the document, including inside open shadow roots.
   *
   * @param {Document | ShadowRoot} [root]
   * @returns {Element[]}
   */
  const allElements = (root = document) => {
    /** @type {Element[]} */
    const out = []
    for (const element of root.querySelectorAll('*')) {
      if (isOwnUi(element)) continue
      out.push(element)
      if (element.shadowRoot) out.push(...allElements(element.shadowRoot))
    }
    return out
  }

  /**
   * ElementsFromPoint that also looks inside open shadow roots (innermost first).
   *
   * @param {number} x @param {number} y @param {Document | ShadowRoot} [root]
   * @returns {Element[]}
   */
  const elementsAt = (x, y, root = document) => {
    /** @type {Element[]} */
    const out = []
    for (const element of root.elementsFromPoint(x, y)) {
      if (isOwnUi(element) || out.includes(element)) continue
      if (element.shadowRoot && element.shadowRoot !== root) {
        for (const inner of elementsAt(x, y, element.shadowRoot)) {
          if (!out.includes(inner)) out.push(inner)
        }
      }
      if (!out.includes(element)) out.push(element)
    }
    return out
  }

  /** @param {Element} element */
  const isScrollableY = element => {
    if (isDocumentTarget(element)) {
      return scrollingElement().scrollHeight > window.innerHeight + 1
    }
    const { overflowY } = getComputedStyle(element)
    return (
      /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1
    )
  }

  /**
   * @param {EventTarget | Node | null} node
   * @returns {Element | null}
   */
  const resolveScrollTarget = node => {
    let element = node instanceof Element ? node : null
    while (element) {
      if (isDocumentTarget(element)) break
      if (isScrollableY(element)) return element
      element = parentOf(element)
    }
    return isScrollableY(scrollingElement()) ? scrollingElement() : null
  }

  /** @param {Element} element */
  const getScrollTop = element => (isDocumentTarget(element) ? window.scrollY : element.scrollTop)

  /** @param {Element} element @param {number} top */
  const setScrollTop = (element, top) => {
    // iOS Safari reports an unclamped window.scrollY after scrolling past the end.
    const [minimum, maximum] = scrollRange(element)
    const clamped = Math.min(maximum, Math.max(minimum, top))
    // Chat UIs that stick to the bottom undo scrolls not preceded by user input.
    const delta = clamped - getScrollTop(element)
    const wheelTarget = isDocumentTarget(element) ? document.documentElement : element
    wheelTarget.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: delta,
        bubbles: true,
        cancelable: true
      })
    )
    if (isDocumentTarget(element)) window.scrollTo({ top: clamped, behavior: 'instant' })
    else element.scrollTo({ top: clamped, behavior: 'instant' })
  }

  /** @param {Element} element @returns {[number, number]} */
  const scrollRange = element => {
    if (isDocumentTarget(element)) {
      return [0, Math.max(0, scrollingElement().scrollHeight - window.innerHeight)]
    }
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
    // flex column-reverse containers scroll from 0 (bottom) to -maximum (top).
    return getComputedStyle(element).flexDirection === 'column-reverse'
      ? [-maximum, 0]
      : [0, maximum]
  }

  /**
   * Client box of the scroll target in viewport coordinates.
   *
   * @param {Element} element
   */
  const viewportOf = element => {
    if (isDocumentTarget(element)) {
      const width = document.documentElement.clientWidth
      const height = window.innerHeight
      return { top: 0, left: 0, width, height, bottom: height, right: width }
    }
    const rectangle = element.getBoundingClientRect()
    const top = rectangle.top + element.clientTop
    const left = rectangle.left + element.clientLeft
    return {
      top,
      left,
      width: element.clientWidth,
      height: element.clientHeight,
      bottom: top + element.clientHeight,
      right: left + element.clientWidth
    }
  }

  /** The part of the target's client box that is on screen. @param {Element} element */
  const visibleBoxOf = element => {
    const viewport = viewportOf(element)
    const top = Math.max(viewport.top, 0)
    const left = Math.max(viewport.left, 0)
    const bottom = Math.min(viewport.bottom, window.innerHeight)
    const right = Math.min(viewport.right, document.documentElement.clientWidth)
    return { viewport, top, left, bottom, right }
  }

  /** @param {Element} ancestor @param {Element} element */
  const containsComposed = (ancestor, element) => {
    /** @type {Element | null} */
    let node = element
    for (; node; node = parentOf(node)) if (node === ancestor) return true
    return false
  }

  /**
   * Pinned elements (headers, composers) paint over the target's content, so frames only keep the
   * band between them: sticky/fixed ones, and absolutely positioned overlays outside the scroller
   * (they don't move with its content).
   *
   * @param {Element} element @param {ReturnType<typeof visibleBoxOf>} box
   */
  const unobstructedBoxOf = (element, box) => {
    const width = box.right - box.left
    const height = box.bottom - box.top
    const isDocument = isDocumentTarget(element)
    /** @type {DOMRect[]} */
    const pinned = []
    for (const node of allElements()) {
      if (node === element || !(node instanceof HTMLElement)) continue
      const position = getComputedStyle(node).position
      const inside = !isDocument && containsComposed(element, node)
      if (position === 'absolute') {
        if (isDocument || inside || containsComposed(node, element)) continue
      } else if (position === 'sticky') {
        if (!inside && !isDocument) continue
      } else if (position !== 'fixed') continue
      const rectangle = node.getBoundingClientRect()
      const overlap = Math.min(rectangle.right, box.right) - Math.max(rectangle.left, box.left)
      if (overlap < width * 0.5 || rectangle.height < 1) continue
      if (rectangle.height > height * 0.5) continue
      if (rectangle.bottom <= box.top || rectangle.top >= box.bottom) continue
      if (position === 'sticky') {
        const previous = node.style.position
        node.style.position = 'static'
        const natural = node.getBoundingClientRect()
        node.style.position = previous
        if (Math.abs(natural.top - rectangle.top) < 1) continue
      }
      pinned.push(rectangle)
    }
    let { top, bottom } = box
    // Stacked overlays (header, then a fade below it) trim the band in turn.
    for (let changed = true; changed;) {
      changed = false
      for (const rectangle of pinned) {
        if (rectangle.bottom <= top || rectangle.top >= bottom) continue
        if (rectangle.top <= top + EDGE_SLACK) top = rectangle.bottom
        else if (rectangle.bottom >= bottom - EDGE_SLACK) bottom = rectangle.top
        else continue
        changed = true
      }
    }
    if (bottom - top < height * 0.2) return box
    return { ...box, top, bottom }
  }

  /**
   * Small floating controls over the content (e.g. "jump to bottom" buttons) that aren't part of
   * the scroller; hidden during each shot so they don't repeat.
   *
   * @param {Element} element @param {ReturnType<typeof visibleBoxOf>} box
   * @returns {HTMLElement[]}
   */
  const floatingOverlaysOf = (element, box) => {
    if (isDocumentTarget(element)) return []
    const width = box.right - box.left
    const height = box.bottom - box.top
    /** @type {HTMLElement[]} */
    const found = []
    for (const node of allElements()) {
      if (!(node instanceof HTMLElement)) continue
      const position = getComputedStyle(node).position
      if (position !== 'absolute' && position !== 'fixed') continue
      if (containsComposed(element, node) || containsComposed(node, element)) continue
      const rectangle = node.getBoundingClientRect()
      if (rectangle.width < 1 || rectangle.height < 1) continue
      if (rectangle.width >= width * 0.5 || rectangle.height >= height * 0.5) continue
      if (
        rectangle.right <= box.left ||
        rectangle.left >= box.right ||
        rectangle.bottom <= box.top ||
        rectangle.top >= box.bottom
      )
        continue
      if (found.some(outer => outer.contains(node))) continue
      found.push(node)
    }
    return found
  }

  /** @param {Element} element */
  const backgroundOf = element => {
    /** @type {Element | null} */
    let node = element
    while (node) {
      const color = getComputedStyle(node).backgroundColor
      if (color && color !== 'transparent' && !color.endsWith(', 0)')) return color
      node = parentOf(node)
    }
    return '#ffffff'
  }

  /** @param {Element} element */
  const selectorFor = element => {
    if (isDocumentTarget(element)) return ':root'
    // One selector per tree, outermost first, joined by SHADOW_SEPARATOR for open shadow roots.
    /** @type {string[]} */
    const trees = []
    /** @type {string[]} */
    let parts = []
    /** @type {Element | null} */
    let node = element
    while (node && node !== document.documentElement) {
      const root = node.getRootNode()
      const scope = root instanceof ShadowRoot ? root : document
      const current = node
      if (node.id && scope.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`)
      } else {
        let part = node.localName
        const testId = node.getAttribute('data-testid')
        if (testId) part += `[data-testid="${CSS.escape(testId)}"]`
        const siblings = Array.from(node.parentElement?.children ?? scope.children).filter(
          child => child.localName === current.localName
        )
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        parts.unshift(part)
        if (node.parentElement) {
          node = node.parentElement
          continue
        }
      }
      trees.unshift(parts.join(' > '))
      parts = []
      node = root instanceof ShadowRoot ? root.host : null
    }
    if (parts.length) trees.unshift(parts.join(' > '))
    return trees.join(SHADOW_SEPARATOR)
  }

  const rememberedTarget = () => {
    const selector = areas[location.host]
    if (!selector) return null
    try {
      const element =
        selector === ':root'
          ? scrollingElement()
          : selector
              .split(SHADOW_SEPARATOR)
              .reduce(
                (/** @type {Element | null} */ found, part, index) =>
                  index === 0
                    ? document.querySelector(part)
                    : (found?.shadowRoot?.querySelector(part) ?? null),
                null
              )
      if (!element) return null
      return isDocumentTarget(element) && !isScrollableY(element) ? null : element
    } catch {
      return null
    }
  }

  /** @param {Element} element */
  const paintsBackground = element => {
    const style = getComputedStyle(element)
    const alpha = style.backgroundColor.match(/[\d.]+/g)?.[3]
    return (
      (style.backgroundColor !== 'transparent' && alpha !== '0') ||
      style.backgroundImage !== 'none' ||
      (style.backdropFilter || 'none') !== 'none'
    )
  }

  /**
   * The innermost scrollable area at a point. Sites often put the visible content of a scroller in
   * a sibling layer on top of it, so the elements under the point aren't always inside the
   * scroller; fall back to geometry.
   *
   * @param {number} x @param {number} y
   */
  const scrollableAt = (x, y) => {
    for (const hit of elementsAt(x, y)) {
      const found = resolveScrollTarget(hit)
      if (found && !isDocumentTarget(found)) return found
      // Only see through layers that don't paint over what's beneath (e.g. not modals).
      if (paintsBackground(hit)) return found
    }
    /** @type {Element | null} */
    let best = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const element of allElements()) {
      const rectangle = element.getBoundingClientRect()
      const area = rectangle.width * rectangle.height
      if (
        area >= bestArea ||
        x < rectangle.left ||
        x > rectangle.right ||
        y < rectangle.top ||
        y > rectangle.bottom ||
        !isScrollableY(element)
      )
        continue
      best = element
      bestArea = area
    }
    if (best) return best
    return isScrollableY(scrollingElement()) ? scrollingElement() : null
  }

  /** @param {Element} element */
  const isScrollTarget = element => isDocumentTarget(element) || isScrollableY(element)

  /**
   * What scrolls a picked element: the element itself when it scrolls, otherwise the nearest
   * scrollable area around it, falling back to the page.
   *
   * @param {Element} element
   * @returns {Element}
   */
  const scrollerOf = element => {
    if (isDocumentTarget(element)) return scrollingElement()
    if (isScrollableY(element)) return element
    const parent = parentOf(element)
    return (parent && resolveScrollTarget(parent)) ?? scrollingElement()
  }

  /**
   * What a tap in pick mode selects. A scrollable area under the point wins, as in chat panels.
   * Where only the page scrolls, the block under the point is selected instead, so part of a page
   * (a feed beside a pinned sidebar) can be captured.
   *
   * @param {number} x @param {number} y
   */
  const pickAt = (x, y) => {
    const scrollable = scrollableAt(x, y)
    if (scrollable && !isDocumentTarget(scrollable)) return scrollable
    /** @type {Element | null} */
    let element = elementsAt(x, y).find(hit => !isDocumentTarget(hit)) ?? null
    while (element && !isDocumentTarget(element)) {
      const { width, height } = element.getBoundingClientRect()
      if (width >= MINIMUM_PICK_SIDE && height >= MINIMUM_PICK_SIDE) return element
      element = parentOf(element)
    }
    return scrollable
  }

  /**
   * The next larger element to select. Wrappers exactly the size of the selection are skipped,
   * since selecting them changes nothing visible, unless they scroll.
   *
   * @param {Element} element
   * @returns {Element | null}
   */
  const largerThan = element => {
    if (isDocumentTarget(element)) return null
    const inner = element.getBoundingClientRect()
    for (let parent = parentOf(element); parent; parent = parentOf(parent)) {
      if (isDocumentTarget(parent)) break
      const outer = parent.getBoundingClientRect()
      const sameBox =
        Math.abs(outer.top - inner.top) <= 1 &&
        Math.abs(outer.bottom - inner.bottom) <= 1 &&
        Math.abs(outer.left - inner.left) <= 1 &&
        Math.abs(outer.right - inner.right) <= 1
      if (!sameBox || isScrollableY(parent)) return parent
    }
    return isScrollableY(scrollingElement()) ? scrollingElement() : null
  }

  /**
   * The on-screen box to highlight: the visible client box of a scroller, or the visible border box
   * of a picked part of the page.
   *
   * @param {Element} element
   */
  const highlightBoxOf = element => {
    if (isScrollTarget(element)) return visibleBoxOf(element)
    const rectangle = element.getBoundingClientRect()
    return {
      top: Math.max(rectangle.top, 0),
      left: Math.max(rectangle.left, 0),
      bottom: Math.min(rectangle.bottom, window.innerHeight),
      right: Math.min(rectangle.right, document.documentElement.clientWidth)
    }
  }

  /* ------------------------------------ ui ------------------------------------ */

  const STYLES = /* css */ `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      z-index: 2147483647;
    }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .highlight {
      position: fixed;
      pointer-events: none;
      z-index: 1;
      border: 2px solid #2563eb;
      border-radius: 2px;
      display: none;
    }
    .highlight[data-mode='tint'] { background: rgba(37, 99, 235, 0.2); }
    .highlight[data-mode='outline'] { border-style: dashed; border-color: rgba(239, 68, 68, 0.8); }
    .catcher {
      position: fixed;
      inset: 0;
      z-index: 2;
      cursor: crosshair;
      display: none;
      background: rgba(0, 0, 0, 0.05);
    }
    .pill, .sheet {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
      z-index: 3;
      max-width: calc(100vw - 16px);
      background: rgba(17, 17, 17, 0.94);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      font-size: 14px;
      line-height: 1.3;
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 8px 8px 12px;
      white-space: nowrap;
    }
    .pill[hidden], .sheet[hidden], .result[hidden], .toast[hidden] { display: none; }
    .sheet { width: min(420px, calc(100vw - 16px)); padding: 14px; }
    .sheet p { margin: 0 0 4px; font-weight: 600; }
    .sheet small { display: block; opacity: 0.7; margin-bottom: 12px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; }
    .label { overflow: hidden; text-overflow: ellipsis; }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      flex: none;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .dot[data-idle] { background: #a3a3a3; animation: none; }
    .warn { color: #fbbf24; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    button {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: inherit;
      font: inherit;
      font-size: 13px;
      border-radius: 4px;
      padding: 7px 10px;
      cursor: pointer;
      touch-action: manipulation;
    }
    button:active { background: rgba(255, 255, 255, 0.2); }
    button[data-primary] { background: #2563eb; border-color: #2563eb; }
    button[data-danger] { background: #dc2626; border-color: #dc2626; }
    button:disabled { opacity: 0.4; }
    .result {
      position: fixed;
      inset: 0;
      z-index: 4;
      display: flex;
      flex-direction: column;
      background: #0a0a0a;
      color: #fff;
      padding-top: env(safe-area-inset-top, 0px);
    }
    .result header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 12px;
      max-height: 40vh;
      overflow-y: auto;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    .result header .label { flex: 1 1 100%; font-size: 13px; opacity: 0.8; }
    .result .images {
      flex: 1;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      padding: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .result img { max-width: min(100%, 720px); height: auto; border: 1px solid rgba(255, 255, 255, 0.15); }
    .result .images[data-crop] {
      overflow-x: hidden;
      padding: 28px 16px;
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
    .crop-stage { position: relative; flex: none; }
    .crop-stage img { display: block; width: 100%; max-width: none; border: 0; }
    .crop-stage [data-shade] {
      position: absolute;
      left: 0;
      right: 0;
      background: rgba(0, 0, 0, 0.6);
      pointer-events: none;
    }
    [data-shade='top'] { top: 0; }
    [data-shade='bottom'] { bottom: 0; }
    [data-shade='left'] { right: auto; }
    .crop-box {
      position: absolute;
      border: 1px solid rgba(255, 255, 255, 0.9);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
      pointer-events: none;
    }
    .crop-box [data-handle] { position: absolute; pointer-events: auto; touch-action: none; }
    .crop-box [data-handle]::before {
      content: '';
      position: absolute;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
    }
    [data-handle='n'], [data-handle='s'] { left: 22px; right: 22px; height: 44px; cursor: ns-resize; }
    [data-handle='e'], [data-handle='w'] { top: 22px; bottom: 22px; width: 44px; cursor: ew-resize; }
    [data-handle='n'] { top: -22px; }
    [data-handle='s'] { bottom: -22px; }
    [data-handle='e'] { right: -22px; }
    [data-handle='w'] { left: -22px; }
    [data-handle='n']::before, [data-handle='s']::before {
      left: 50%;
      top: 19px;
      width: 28px;
      height: 4px;
      margin-left: -14px;
      background: #fff;
    }
    [data-handle='e']::before, [data-handle='w']::before {
      top: 50%;
      left: 19px;
      width: 4px;
      height: 28px;
      margin-top: -14px;
      background: #fff;
    }
    [data-handle='nw'], [data-handle='ne'], [data-handle='sw'], [data-handle='se'] { width: 44px; height: 44px; }
    [data-handle='nw']::before, [data-handle='ne']::before, [data-handle='sw']::before, [data-handle='se']::before {
      width: 24px;
      height: 24px;
    }
    [data-handle='nw'] { top: -22px; left: -22px; cursor: nwse-resize; }
    [data-handle='ne'] { top: -22px; right: -22px; cursor: nesw-resize; }
    [data-handle='sw'] { bottom: -22px; left: -22px; cursor: nesw-resize; }
    [data-handle='se'] { bottom: -22px; right: -22px; cursor: nwse-resize; }
    [data-handle='nw']::before { top: 19px; left: 19px; border-top: 4px solid #fff; border-left: 4px solid #fff; }
    [data-handle='ne']::before { top: 19px; right: 19px; border-top: 4px solid #fff; border-right: 4px solid #fff; }
    [data-handle='sw']::before { bottom: 19px; left: 19px; border-bottom: 4px solid #fff; border-left: 4px solid #fff; }
    [data-handle='se']::before { bottom: 19px; right: 19px; border-bottom: 4px solid #fff; border-right: 4px solid #fff; }
    .toast {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      top: calc(env(safe-area-inset-top, 0px) + 12px);
      z-index: 5;
      background: rgba(17, 17, 17, 0.94);
      color: #fff;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      max-width: calc(100vw - 24px);
    }
  `

  /**
   * @type {{
   *   host: HTMLElement
   *   root: ShadowRoot
   *   highlight: HTMLElement
   *   catcher: HTMLElement
   *   pill: HTMLElement
   *   sheet: HTMLElement
   *   result: HTMLElement
   *   toast: HTMLElement
   * } | null}
   */
  let ui = null
  /** @type {HTMLElement | null} */
  let calibrationMarker = null

  const ensureUi = () => {
    if (ui?.host.isConnected) return ui
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = /* html */ `
      <style>${STYLES}</style>
      <div class="highlight"></div>
      <div class="catcher"></div>
      <div class="pill" hidden></div>
      <div class="sheet" hidden></div>
      <div class="result" hidden></div>
      <div class="toast" hidden></div>
    `
    document.documentElement.append(host)
    /** @param {string} selector */
    const part = selector => {
      const element = root.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`)
      return element
    }
    ui = {
      host,
      root,
      highlight: part('.highlight'),
      catcher: part('.catcher'),
      pill: part('.pill'),
      sheet: part('.sheet'),
      result: part('.result'),
      toast: part('.toast')
    }
    root.addEventListener('click', onUiClick)
    root.addEventListener('pointerdown', onCropPointerDown)
    root.addEventListener('pointermove', onCropPointerMove)
    root.addEventListener('pointerup', onCropPointerUp)
    root.addEventListener('pointercancel', onCropPointerUp)
    ui.catcher.addEventListener('click', onCatcherClick)
    return ui
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer
  /** @param {string} message */
  const toast = message => {
    const { toast: element } = ensureUi()
    element.textContent = message
    element.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      element.hidden = true
    }, 2600)
  }

  /** @param {string} text */
  const escapeHtml = text => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

  /** @param {number} pixels */
  const formatPixels = pixels => `${Math.round(pixels).toLocaleString()} px`

  /* --------------------------------- session ---------------------------------- */

  /** @type {'idle' | 'armed' | 'confirm' | 'pick' | 'capturing' | 'processing' | 'result'} */
  let state = 'idle'
  /** @type {Element | null} */
  let target = null
  /**
   * The picked part of the target that frames are cut to, when it's smaller than the target.
   *
   * @type {Element | null}
   */
  let region = null
  /** @type {Element | null} */
  let candidate = null
  /** @type {Element[]} */
  let pickStack = []
  /** @type {{ y: number; height: number; blob: Blob }[]} */
  let pieces = []
  /** @type {[number, number][]} */
  let coverage = []
  /** @type {{ element: Element; top: number }[]} */
  let anchors = []
  let frameCount = 0
  let position = 0
  let lastScrollTop = 0
  /** @type {Promise<void> | null} */
  let inflight = null
  let pendingCapture = false
  let finishing = false
  /** @type {0 | 1 | -1} */
  let autoDirection = 0
  /** @type {0 | 1 | -1} */
  let travelDirection = 0
  let captureErrors = 0
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let edgeTimer
  let updateAnimationFrame = 0
  let highlightAnimationFrame = 0
  /** @type {MutationObserver | null} */
  let observer = null
  /**
   * @type {{
   *   key: string
   *   offsetX: number
   *   offsetY: number
   *   scaleX: number
   *   scaleY: number
   *   clearTop: number
   *   clearBottom: number
   * } | null}
   */
  let calibration = null
  /**
   * Row signature of the last accepted frame, for aligning the next one.
   *
   * @type {{ range: [number, number]; rows: Uint8ClampedArray } | null}
   */
  let lastSignature = null
  /** @type {{ blob: Blob; url: string; width: number; height: number }[]} */
  let parts = []
  /** The uncropped stitched images; `parts` is either these or a crop of them. @type {typeof parts} */
  let sourceParts = []
  /**
   * Applied crop, in pixels of the source parts stacked top to bottom.
   *
   * @type {{ x: number; y: number; width: number; height: number } | null}
   */
  let cropRectangle = null
  /**
   * Crop being edited; set while the crop view is open.
   *
   * @type {{ x: number; y: number; width: number; height: number } | null}
   */
  let cropDraft = null
  /**
   * @type {{
   *   handle: string
   *   pointerId: number
   *   offsetX: number
   *   offsetY: number
   *   clientX: number
   *   clientY: number
   * } | null}
   */
  let cropDrag = null
  let cropAnimationFrame = 0
  let cropBusy = false
  /** @type {string[]} */
  let resultNotes = []
  let resultStem = ''
  /** Output pixels per CSS pixel, locked when capturing starts. */
  let sessionScale = 0
  let frameWidthCss = 0
  /** Bumped on reset so stale async work (capture, stitching, auto-scroll) can bail. */
  let generation = 0
  let autoRun = 0

  /** @type {(Document | ShadowRoot)[]} */
  let scrollRoots = []

  // Scroll events don't cross shadow boundaries, so listen on each open shadow root too.
  const listenScroll = () => {
    unlistenScroll()
    scrollRoots = [document]
    for (const element of allElements())
      if (element.shadowRoot) scrollRoots.push(element.shadowRoot)
    for (const root of scrollRoots) {
      root.addEventListener('scroll', onScroll, {
        capture: true,
        passive: true
      })
    }
  }

  const unlistenScroll = () => {
    for (const root of scrollRoots) {
      root.removeEventListener('scroll', onScroll, true)
    }
    scrollRoots = []
  }

  const resetSession = () => {
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    cancelAnimationFrame(updateAnimationFrame)
    cancelAnimationFrame(highlightAnimationFrame)
    observer?.disconnect()
    observer = null
    unlistenScroll()
    document.removeEventListener('keydown', onKeydown, true)
    cancelAnimationFrame(cropAnimationFrame)
    for (const part of new Set([...sourceParts, ...parts])) URL.revokeObjectURL(part.url)
    calibrationMarker?.remove()
    calibrationMarker = null
    if (ui) ui.host.style.visibility = ''
    target = null
    region = null
    candidate = null
    pickStack = []
    pieces = []
    coverage = []
    anchors = []
    parts = []
    sourceParts = []
    cropRectangle = null
    cropDraft = null
    cropDrag = null
    cropAnimationFrame = 0
    cropBusy = false
    frameCount = 0
    position = 0
    lastScrollTop = 0
    inflight = null
    pendingCapture = false
    finishing = false
    autoDirection = 0
    travelDirection = 0
    captureErrors = 0
    updateAnimationFrame = 0
    highlightAnimationFrame = 0
    calibration = null
    lastSignature = null
    sessionScale = 0
    frameWidthCss = 0
    generation++
    autoRun++
  }

  /** @param {typeof state} next */
  const setState = next => {
    state = next
    render()
  }

  let starting = false
  const start = async () => {
    if (state !== 'idle' || starting) return
    starting = true
    try {
      await loadStorage()
    } finally {
      starting = false
    }
    if (state !== 'idle') return
    ensureUi()
    resetSession()
    candidate = settings.confirmArea ? rememberedTarget() : null
    listenScroll()
    document.addEventListener('keydown', onKeydown, true)
    setState('armed')
    trackHighlight()
  }

  const cancel = () => {
    resetSession()
    setState('idle')
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape') return
    if (cropDraft) {
      if (!cropBusy) closeCrop()
      return
    }
    if (state === 'pick') {
      setState(candidate ? 'confirm' : 'armed')
      return
    }
    cancel()
  }

  /** @param {Event} event */
  function onScroll(event) {
    if (state === 'armed' || state === 'confirm') {
      const scrolled = resolveScrollTarget(event.target)
      if (!scrolled) return
      if (!settings.confirmArea) {
        beginCapture(scrolled)
        return
      }
      const remembered = state === 'armed' ? rememberedTarget() : null
      if (remembered && scrollerOf(remembered) === scrolled) {
        beginCapture(remembered)
        return
      }
      if (candidate !== scrolled || state !== 'confirm') {
        candidate = scrolled
        pickStack = []
        setState('confirm')
      }
      return
    }
    if (state !== 'capturing' || !target) return
    if (resolveScrollTarget(event.target) !== target) return
    scheduleUpdate()
  }

  /** @param {Element} element The picked scroller, or a part of the page inside one. */
  const beginCapture = element => {
    const scroller = scrollerOf(element)
    target = scroller
    region = isScrollTarget(element) ? null : element
    candidate = null
    if (region) {
      // Start at the top of the picked part when it begins above the view.
      const top = unobstructedBoxOf(scroller, visibleBoxOf(scroller)).top
      const regionTop = region.getBoundingClientRect().top
      if (regionTop < top) setScrollTop(scroller, getScrollTop(scroller) + regionTop - top)
    }
    lastScrollTop = getScrollTop(scroller)
    position = 0
    anchors = sampleAnchors()
    observer = new MutationObserver(() => {
      scheduleUpdate()
    })
    observer.observe(isDocumentTarget(scroller) ? document.body : scroller, {
      childList: true,
      subtree: true,
      characterData: true
    })
    setState('capturing')
    scheduleIdleCapture()
  }

  /* ---------------------------- position tracking ----------------------------- */

  /** @param {Element} element */
  const isPinned = element => {
    /** @type {Element | null} */
    let node = element
    while (node && node !== target) {
      const { position: cssPosition } = getComputedStyle(node)
      if (cssPosition === 'fixed' || cssPosition === 'sticky') return true
      node = parentOf(node)
    }
    return false
  }

  /** @returns {typeof anchors} */
  const sampleAnchors = () => {
    if (!target) return []
    const { top, left, bottom, right } = visibleBoxOf(target)
    if (bottom - top < 4 || right - left < 4) return []
    const isDocument = isDocumentTarget(target)
    /** @type {typeof anchors} */
    const found = []
    const seen = new Set()
    for (const fractionX of [0.3, 0.7]) {
      for (const fractionY of [0.15, 0.5, 0.85]) {
        const x = left + (right - left) * fractionX
        const y = top + (bottom - top) * fractionY
        for (const element of elementsAt(x, y)) {
          if (element === target) continue
          if (
            isDocument
              ? element === document.documentElement || element === document.body
              : !target.contains(element)
          ) {
            continue
          }
          if (seen.has(element) || isPinned(element)) break
          seen.add(element)
          found.push({ element, top: element.getBoundingClientRect().top })
          break
        }
      }
    }
    return found
  }

  /** @param {number[]} values */
  const median = values => {
    const sorted = [...values].sort((one, other) => one - other)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  }

  /**
   * Tracks the target's viewport top in a coordinate space fixed to its content. Visible elements
   * are used as anchors so content inserted, recycled or resized above the viewport (lazy loading,
   * virtualized lists, late images) doesn't skew it. The scrollTop delta is the fallback when no
   * anchor survived.
   */
  const updatePosition = () => {
    const element = target
    if (!element) return
    const scrollTop = getScrollTop(element)
    let delta = scrollTop - lastScrollTop
    const isDocument = isDocumentTarget(element)
    const alive = anchors.filter(
      anchor => anchor.element.isConnected && (isDocument || element.contains(anchor.element))
    )
    if (alive.length) {
      // When content reflows unevenly (rows inserted and regrouped), only the
      // anchor nearest the already-captured side keeps the seam aligned.
      const edge = travelDirection
        ? alive.reduce((best, anchor) =>
            (anchor.top - best.top) * travelDirection < 0 ? anchor : best
          )
        : null
      delta = edge
        ? edge.top - edge.element.getBoundingClientRect().top
        : median(alive.map(anchor => anchor.top - anchor.element.getBoundingClientRect().top))
    }
    if (Math.abs(delta) > 0.5) travelDirection = delta > 0 ? 1 : -1
    position += delta
    lastScrollTop = scrollTop
    anchors = sampleAnchors()
  }

  const scheduleUpdate = () => {
    if (updateAnimationFrame) return
    updateAnimationFrame = requestAnimationFrame(() => {
      updateAnimationFrame = 0
      updatePosition()
      if (!autoDirection && !finishing) {
        scheduleIdleCapture()
        scheduleEdgeStop()
        // Continuous scrolling postpones the idle shot; take one before a gap opens.
        const current = currentRange()
        if (current && coverage.length) {
          const band = current.range[1] - current.range[0]
          const missing = uncovered(current.range).reduce(
            (sum, [gapStart, gapEnd]) => sum + (gapEnd - gapStart),
            0
          )
          if (missing > band * 0.4) void captureIfNeeded()
        }
      }
      renderPill()
    })
  }

  const scheduleIdleCapture = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void captureIfNeeded()
    }, IDLE_CAPTURE_MILLISECONDS)
  }

  const scheduleEdgeStop = () => {
    clearTimeout(edgeTimer)
    if (!settings.autoStop || !target || frameCount < 2 || !travelDirection) return
    const [minimum, maximum] = scrollRange(target)
    const scrollTop = getScrollTop(target)
    const atEdge =
      (travelDirection > 0 ? scrollTop >= maximum - 1 : scrollTop <= minimum + 1) ||
      regionEndReached(travelDirection)
    if (!atEdge) return
    edgeTimer = setTimeout(() => {
      if (state === 'capturing' && !autoDirection) void finish()
    }, AUTO_STOP_MILLISECONDS)
  }

  /* --------------------------------- coverage --------------------------------- */

  /** @param {[number, number][]} intervals @returns {[number, number][]} */
  const mergeIntervals = intervals => {
    const sorted = [...intervals].sort((one, other) => one[0] - other[0])
    /** @type {[number, number][]} */
    const merged = []
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1]
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    return merged
  }

  /** @param {[number, number]} range @returns {[number, number][]} */
  const uncovered = ([start, end]) => {
    /** @type {[number, number][]} */
    const gaps = []
    let cursor = start
    for (const [coveredStart, coveredEnd] of coverage) {
      if (coveredEnd <= cursor) continue
      if (coveredStart >= end) break
      if (coveredStart > cursor) gaps.push([cursor, Math.min(coveredStart, end)])
      cursor = Math.max(cursor, coveredEnd)
      if (cursor >= end) break
    }
    if (cursor < end) gaps.push([cursor, end])
    return gaps.filter(([gapStart, gapEnd]) => gapEnd - gapStart >= 2)
  }

  /* --------------------------------- capture ---------------------------------- */

  /** @param {number} milliseconds */
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))

  /**
   * @template T
   * @param {Promise<T>} promise @param {number} milliseconds @param {string} what
   * @returns {Promise<T>}
   */
  const withTimeout = (promise, milliseconds, what) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} timed out`)), milliseconds)
      )
    ])

  /** @param {number} width @param {number} height */
  const createCanvas = (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  /** @param {HTMLCanvasElement} canvas */
  const context2d = canvas => {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context unavailable')
    return context
  }

  /**
   * @param {HTMLCanvasElement} canvas @param {string} type @param {number} [quality] @returns
   *   {Promise<Blob>}
   */
  const canvasToBlob = (canvas, type, quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Canvas export failed'))),
        type,
        quality
      )
    })

  /**
   * Viewport rectangle of one of our overlays, padded for its drop shadow.
   *
   * @param {HTMLElement} element
   */
  const ownUiRectangle = element => {
    const rectangle = element.getBoundingClientRect()
    return {
      top: rectangle.top - OWN_UI_SHADOW,
      left: rectangle.left - OWN_UI_SHADOW,
      bottom: rectangle.bottom + OWN_UI_SHADOW,
      right: rectangle.right + OWN_UI_SHADOW
    }
  }

  /**
   * @param {{ top: number; left: number; bottom: number; right: number }} one
   * @param {{ top: number; left: number; bottom: number; right: number }} other
   */
  const intersects = (one, other) =>
    one.top < other.bottom &&
    one.bottom > other.top &&
    one.left < other.right &&
    one.right > other.left

  /**
   * Screenshot of the visible tab without our own UI in the captured box. Only what overlaps the
   * box is hidden, so the pill doesn't flicker on every shot.
   *
   * @param {ReturnType<typeof visibleBoxOf>} [box]
   */
  const screenshot = async box => {
    /** @type {HTMLElement[]} */
    const hidden = !ui
      ? []
      : !box
        ? [ui.host]
        : [
            ui.highlight,
            ...[ui.pill, ui.toast].filter(
              element => !element.hidden && intersects(ownUiRectangle(element), box)
            )
          ]
    for (const element of hidden) element.style.visibility = 'hidden'
    const floating = target && box ? floatingOverlaysOf(target, box) : []
    const floatingVisibility = floating.map(node => node.style.visibility)
    for (const node of floating) node.style.visibility = 'hidden'
    // Restyling the root scroller makes iOS Safari restore an older page scroll position.
    const scroller = target instanceof HTMLElement && !isDocumentTarget(target) ? target : null
    const scrollbarWidth = scroller?.style.scrollbarWidth ?? ''
    if (scroller) scroller.style.scrollbarWidth = 'none'
    try {
      await nextFrame()
      await nextFrame()
      const response = await withTimeout(
        browser.runtime.sendMessage({ type: 'capture' }),
        CAPTURE_TIMEOUT_MILLISECONDS,
        'Screenshot'
      )
      if (!response?.ok) throw new Error(response?.error || 'Screenshot failed')
      const blob = await (await fetch(response.url)).blob()
      return await createImageBitmap(blob)
    } finally {
      floating.forEach((node, index) => {
        node.style.visibility = floatingVisibility[index] ?? ''
      })
      if (scroller) scroller.style.scrollbarWidth = scrollbarWidth
      for (const element of hidden) element.style.visibility = ''
    }
  }

  const viewportKey = () =>
    [
      window.innerWidth,
      window.innerHeight,
      window.visualViewport?.scale ?? 1,
      window.visualViewport?.offsetTop ?? 0
    ].join(',')

  /**
   * Screenshots cover the whole screen (status bar and browser chrome included), so a full-height
   * stripe is painted at the viewport's left edge and located in a screenshot to map viewport
   * coordinates to screenshot pixels.
   *
   * @returns {Promise<NonNullable<typeof calibration>>}
   */
  const calibrate = async () => {
    const key = viewportKey()
    const marker = document.createElement('div')
    marker.style.cssText = `all:initial;position:fixed;left:0;top:0;width:6px;height:${window.innerHeight}px;background:#ff00ff;z-index:2147483647;pointer-events:none`
    calibrationMarker = marker
    document.documentElement.append(marker)
    /** @type {ImageBitmap} */
    let bitmap
    try {
      bitmap = await screenshot()
    } finally {
      marker.remove()
      calibrationMarker = null
    }
    const scaleX = bitmap.width / document.documentElement.clientWidth
    const canvas = createCanvas(1, bitmap.height)
    const context = context2d(canvas)
    context.drawImage(bitmap, Math.floor(scaleX * 3), 0, 1, bitmap.height, 0, 0, 1, bitmap.height)
    const data = context.getImageData(0, 0, 1, bitmap.height).data
    let first = -1
    let last = -1
    // Rows where Safari's own bars fade over the page aren't pure magenta.
    let pureFirst = -1
    let pureLast = -1
    for (let y = 0; y < bitmap.height; y++) {
      const red = data[y * 4] ?? 0
      const green = data[y * 4 + 1] ?? 0
      const blue = data[y * 4 + 2] ?? 0
      if (red > 200 && green < 90 && blue > 200) {
        if (first < 0) first = y
        last = y
      }
      if (red >= 250 && green <= 5 && blue >= 250) {
        if (pureFirst < 0) pureFirst = y
        pureLast = y
      }
    }
    bitmap.close()
    if (first < 0) {
      console.warn('[captureful] calibration marker not found')
      return {
        key,
        offsetX: 0,
        offsetY: 0,
        scaleX,
        scaleY: scaleX,
        clearTop: 0,
        clearBottom: window.innerHeight
      }
    }
    const scaleY = (last + 1 - first) / window.innerHeight
    return {
      key,
      offsetX: 0,
      offsetY: first,
      scaleX,
      scaleY,
      clearTop: pureFirst < 0 ? 0 : (pureFirst - first) / scaleY,
      clearBottom: pureFirst < 0 ? window.innerHeight : (pureLast + 1 - first) / scaleY
    }
  }

  const captureIfNeeded = () => {
    if (inflight) {
      pendingCapture = true
      return inflight
    }
    inflight = captureFrame().finally(() => {
      inflight = null
      renderPill()
      if (pendingCapture && state === 'capturing' && !autoDirection && !finishing)
        scheduleIdleCapture()
    })
    return inflight
  }

  /** @returns {{ box: ReturnType<typeof visibleBoxOf>; range: [number, number] } | null} */
  const currentRange = () => {
    if (!target) return null
    const box = unobstructedBoxOf(target, visibleBoxOf(target))
    if (calibration) {
      // Skip the band under Safari's faded bars, except at the scroll ends where
      // that band can't be scrolled into the clear.
      const [minimum, maximum] = scrollRange(target)
      const scrollTop = getScrollTop(target)
      const top = scrollTop > minimum + 1 ? Math.max(box.top, calibration.clearTop) : box.top
      const bottom =
        scrollTop < maximum - 1 ? Math.min(box.bottom, calibration.clearBottom) : box.bottom
      if (bottom - top > (box.bottom - box.top) * 0.5) {
        box.top = top
        box.bottom = bottom
      }
    }
    // A picked part of the page keeps only its own columns and rows, leaving out pinned
    // neighbours like sidebars. It's measured every frame since feeds grow while scrolling.
    if (region) {
      const area = region.getBoundingClientRect()
      box.left = Math.max(box.left, area.left)
      box.right = Math.min(box.right, area.right)
      box.top = Math.max(box.top, area.top)
      box.bottom = Math.min(box.bottom, area.bottom)
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return null
    }
    // The pill stays on screen during shots, so keep the band above it. At the
    // end of the scroll that band can't be scrolled clear; the shot hides it instead.
    if (ui && !ui.pill.hidden) {
      const pill = ownUiRectangle(ui.pill)
      const [, maximum] = scrollRange(target)
      const bottom = Math.min(box.bottom, pill.top)
      if (
        getScrollTop(target) < maximum - 1 &&
        intersects(pill, box) &&
        bottom - box.top > (box.bottom - box.top) * 0.5
      )
        box.bottom = bottom
    }
    return {
      box,
      range: [position + (box.top - box.viewport.top), position + (box.bottom - box.viewport.top)]
    }
  }

  /**
   * CSS px of the picked part not captured yet in this direction, or null when no part was picked
   * or nothing is captured yet. Measured against the coverage, in the same content coordinates as
   * the frames, so it agrees with what was actually kept.
   *
   * @param {1 | -1} direction
   */
  const regionRemaining = direction => {
    const first = coverage[0]
    const last = coverage[coverage.length - 1]
    if (!region || !target || !first || !last) return null
    const viewportTop = viewportOf(target).top
    const area = region.getBoundingClientRect()
    return direction > 0
      ? position + (area.bottom - viewportTop) - last[1]
      : first[0] - (position + (area.top - viewportTop))
  }

  /**
   * Whether the picked part is captured to its edge in this direction. Below 2 px is done, as
   * `uncovered` skips slivers that thin.
   *
   * @param {1 | -1} direction
   */
  const regionEndReached = direction => {
    const remaining = regionRemaining(direction)
    return remaining !== null && remaining < 2
  }

  /**
   * Content that grows while auto-scrolling (images loading, rows inserted) can push the view past
   * the captured edge; scroll back so the band in between isn't lost.
   *
   * @param {1 | -1} direction
   */
  const closeGap = async direction => {
    for (let attempt = 0; attempt < 3 && target; attempt++) {
      const current = currentRange()
      const edge = direction > 0 ? coverage[coverage.length - 1]?.[1] : coverage[0]?.[0]
      if (!current || edge === undefined) return
      const gap = direction > 0 ? current.range[0] - edge : edge - current.range[1]
      if (gap <= 1) return
      setScrollTop(target, getScrollTop(target) - direction * (gap + 8))
      await settle()
      updatePosition()
    }
  }

  /**
   * Downscaled RGB rows of the frame's box, one row per CSS px.
   *
   * @param {ImageBitmap} bitmap
   * @param {NonNullable<typeof calibration>} activeCalibration
   * @param {ReturnType<typeof visibleBoxOf>} box
   */
  const signatureOf = (bitmap, activeCalibration, box) => {
    const height = Math.max(1, Math.round(box.bottom - box.top))
    const canvas = createCanvas(SIGNATURE_COLUMNS, height)
    const context = context2d(canvas)
    context.drawImage(
      bitmap,
      activeCalibration.offsetX + box.left * activeCalibration.scaleX,
      activeCalibration.offsetY + box.top * activeCalibration.scaleY,
      (box.right - box.left) * activeCalibration.scaleX,
      (box.bottom - box.top) * activeCalibration.scaleY,
      0,
      0,
      SIGNATURE_COLUMNS,
      height
    )
    const rows = context.getImageData(0, 0, SIGNATURE_COLUMNS, height).data
    canvas.width = 0
    canvas.height = 0
    return rows
  }

  /**
   * Tracked positions drift when content reflows (rows prepended and regrouped). Where this frame
   * overlaps the previous one, find the small shift that makes their pixels agree; keep the tracked
   * position unless a shift is clearly better.
   *
   * @param {Uint8ClampedArray} rows @param {[number, number]} range
   */
  const alignShift = (rows, range) => {
    const last = lastSignature
    if (!last) return 0
    const stride = SIGNATURE_COLUMNS * 4
    const newHeight = rows.length / stride
    const lastHeight = last.rows.length / stride
    /** @param {number} shift */
    const errorAt = shift => {
      const start = Math.ceil(Math.max(range[0] + shift, last.range[0]))
      const end = Math.floor(Math.min(range[0] + shift + newHeight, last.range[0] + lastHeight))
      if (end - start < 40) return Infinity
      let sum = 0
      let count = 0
      for (let y = start; y < end; y++) {
        const newRow = Math.floor(y - (range[0] + shift)) * stride
        const lastRow = Math.floor(y - last.range[0]) * stride
        for (let pixel = 0; pixel < stride; pixel += 4) {
          sum +=
            Math.abs((rows[newRow + pixel] ?? 0) - (last.rows[lastRow + pixel] ?? 0)) +
            Math.abs((rows[newRow + pixel + 1] ?? 0) - (last.rows[lastRow + pixel + 1] ?? 0)) +
            Math.abs((rows[newRow + pixel + 2] ?? 0) - (last.rows[lastRow + pixel + 2] ?? 0))
          count += 3
        }
      }
      return sum / count
    }
    const base = errorAt(0)
    if (!Number.isFinite(base) || base < 2) return 0
    let best = 0
    let bestError = base
    for (let shift = -MAXIMUM_ALIGN_SHIFT; shift <= MAXIMUM_ALIGN_SHIFT; shift++) {
      if (!shift) continue
      const error = errorAt(shift)
      if (error < bestError) {
        best = shift
        bestError = error
      }
    }
    return bestError < base * 0.5 && bestError < 4 ? best : 0
  }

  const captureFrame = async () => {
    if (state !== 'capturing' || !target) return
    const session = generation
    try {
      if (!calibration || calibration.key !== viewportKey()) {
        calibration = await calibrate()
        if (session !== generation || !target) return
      }
      const activeCalibration = calibration
      updatePosition()
      const current = currentRange()
      if (!current) return
      const { box, range } = current
      if (box.right - box.left < 2 || !uncovered(range).length) return
      pendingCapture = false
      renderPill()
      const before = position
      const bitmap = await screenshot(box)
      if (session !== generation || !target) {
        bitmap.close()
        return
      }
      updatePosition()
      const moved = position - before
      // A shot taken while moving has an uncertain position. During slow manual
      // scrolls, the midpoint is close enough and beats leaving a gap.
      const tolerable = !autoDirection && Math.abs(moved) <= MAXIMUM_SHOT_DRIFT
      if ((Math.abs(moved) > 1 && !tolerable) || activeCalibration.key !== viewportKey()) {
        bitmap.close()
        pendingCapture = true
        return
      }
      if (Math.abs(moved) > 1) {
        range[0] += moved / 2
        range[1] += moved / 2
        pendingCapture = true
      }
      const signature = signatureOf(bitmap, activeCalibration, box)
      const shift = alignShift(signature, range)
      if (shift) {
        position += shift
        range[0] += shift
        range[1] += shift
      }
      if (!sessionScale) {
        sessionScale = settings.scale
          ? Math.min(settings.scale, activeCalibration.scaleX)
          : activeCalibration.scaleX
        frameWidthCss = box.right - box.left
      }
      const width = Math.round(frameWidthCss * sessionScale)
      /** @type {typeof pieces} */
      const framePieces = []
      for (const [gapStart, gapEnd] of uncovered(range)) {
        const height = Math.max(1, Math.round((gapEnd - gapStart) * sessionScale))
        const canvas = createCanvas(width, height)
        // Whole source rows: fractional ones blend in a neighbouring row, leaving seam lines.
        const sourceTop = Math.round(
          activeCalibration.offsetY + (box.top + (gapStart - range[0])) * activeCalibration.scaleY
        )
        const sourceHeight = Math.max(
          1,
          Math.round(
            activeCalibration.offsetY + (box.top + (gapEnd - range[0])) * activeCalibration.scaleY
          ) - sourceTop
        )
        const context = context2d(canvas)
        context.imageSmoothingEnabled = sourceHeight !== height
        context.drawImage(
          bitmap,
          activeCalibration.offsetX + box.left * activeCalibration.scaleX,
          sourceTop,
          (box.right - box.left) * activeCalibration.scaleX,
          sourceHeight,
          0,
          0,
          width,
          height
        )
        framePieces.push({
          y: gapStart,
          height: gapEnd - gapStart,
          blob: await canvasToBlob(canvas, 'image/png')
        })
        canvas.width = 0
        canvas.height = 0
      }
      bitmap.close()
      if (session !== generation) return
      pieces.push(...framePieces)
      frameCount++
      lastSignature = { range: [range[0], range[1]], rows: signature }
      coverage = mergeIntervals([...coverage, range])
      if (!autoDirection && !finishing) scheduleEdgeStop()
    } catch (error) {
      captureErrors++
      console.error('[captureful] capture failed', error)
      if (captureErrors === 3) toast('Capture keeps failing. See console.')
    }
  }

  /** Waits for the DOM inside the target to stop changing (lazy loading, layout). */
  const settle = async (quietMilliseconds = 200, maximumMilliseconds = 1500) => {
    await nextFrame()
    await nextFrame()
    const startedAt = Date.now()
    let lastMutation = Date.now()
    const watcher = new MutationObserver(() => {
      lastMutation = Date.now()
    })
    if (target) {
      watcher.observe(isDocumentTarget(target) ? document.body : target, {
        childList: true,
        subtree: true,
        attributes: true
      })
    }
    while (
      Date.now() - lastMutation < quietMilliseconds &&
      Date.now() - startedAt < maximumMilliseconds
    ) {
      await sleep(50)
    }
    watcher.disconnect()
  }

  /** @param {1 | -1} direction */
  const runAutoScroll = async direction => {
    if (!target) return
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    const run = ++autoRun
    autoDirection = direction
    renderPill()
    const active = () =>
      run === autoRun &&
      autoDirection === direction &&
      state === 'capturing' &&
      !finishing &&
      !!target
    while (active() && target) {
      await inflight
      await captureIfNeeded()
      // A shot is discarded when the content moved while it was taken (e.g. a lazy
      // loader inserted rows); retake it before scrolling on, or that band is lost.
      for (let retry = 0; retry < 4 && pendingCapture && active(); retry++) {
        await settle()
        updatePosition()
        await closeGap(direction)
        await captureIfNeeded()
      }
      if (!active() || !target) break
      if (regionEndReached(direction)) {
        autoDirection = 0
        if (settings.autoStop) {
          await finish()
          return
        }
        break
      }
      // Scroll only a little past what's left of the picked part, so its last rows land inside the
      // band rather than beyond it, where nothing would scroll back for them.
      const remaining = regionRemaining(direction)
      const distance = viewportOf(target).height * AUTO_SCROLL_STEP
      const step =
        direction *
        (remaining === null ? distance : Math.min(distance, remaining + REGION_END_MARGIN))
      const before = getScrollTop(target)
      const heightBefore = target.scrollHeight
      setScrollTop(target, before + step)
      await settle()
      updatePosition()
      const moved = Math.abs(getScrollTop(target) - before) >= 1
      if (moved) await closeGap(direction)
      if (!target) break
      if (moved) continue
      // At an edge: give lazy loaders a moment to append more content.
      const waitStart = Date.now()
      while (active() && Date.now() - waitStart < 2000 && target.scrollHeight === heightBefore) {
        await sleep(100)
      }
      if (!active()) break
      await settle()
      setScrollTop(target, getScrollTop(target) + step)
      await settle()
      updatePosition()
      if (Math.abs(getScrollTop(target) - before) >= 1) continue
      await captureIfNeeded()
      if (!active()) return
      autoDirection = 0
      if (settings.autoStop) {
        await finish()
        return
      }
    }
    if (run !== autoRun) return
    autoDirection = 0
    renderPill()
  }

  /* --------------------------------- stitching -------------------------------- */

  /** Tallest canvas of this width the browser can export. @param {number} width */
  const maximumPartHeightFor = width =>
    Math.min(MAXIMUM_CANVAS_SIDE, Math.floor(MAXIMUM_CANVAS_AREA / width))

  /**
   * Exports the canvas as a PNG part and frees its memory. @param {HTMLCanvasElement} canvas
   *
   * @returns {Promise<(typeof parts)[number]>}
   */
  const canvasToPart = async canvas => {
    const blob = await canvasToBlob(canvas, 'image/png')
    const part = {
      blob,
      url: URL.createObjectURL(blob),
      width: canvas.width,
      height: canvas.height
    }
    canvas.width = 0
    canvas.height = 0
    return part
  }

  const stitch = async () => {
    if (!pieces.length || !target) return []
    const scale = sessionScale
    const minimumY = coverage[0]?.[0] ?? 0
    const maximumY = coverage[coverage.length - 1]?.[1] ?? 0
    const width = Math.round(frameWidthCss * scale)
    const totalHeight = Math.round((maximumY - minimumY) * scale)
    const maximumPartHeight = maximumPartHeightFor(width)
    const background = backgroundOf(region ?? target)
    /** @type {typeof parts} */
    const result = []
    for (let partTop = 0; partTop < totalHeight; partTop += maximumPartHeight) {
      const partHeight = Math.min(maximumPartHeight, totalHeight - partTop)
      const canvas = createCanvas(width, partHeight)
      const context = context2d(canvas)
      context.fillStyle = background
      context.fillRect(0, 0, width, partHeight)
      for (const piece of pieces) {
        const top = Math.round((piece.y - minimumY) * scale)
        const bottom = Math.round((piece.y + piece.height - minimumY) * scale)
        if (bottom <= partTop || top >= partTop + partHeight) continue
        const bitmap = await createImageBitmap(piece.blob)
        context.drawImage(bitmap, 0, top - partTop, width, bottom - top)
        bitmap.close()
      }
      result.push(await canvasToPart(canvas))
    }
    return result
  }

  const finish = async () => {
    if (state !== 'capturing' || finishing) return
    finishing = true
    autoDirection = 0
    autoRun++
    clearTimeout(idleTimer)
    clearTimeout(edgeTimer)
    renderPill()
    const session = generation
    // Each screenshot times out, so this can't wait forever.
    await inflight
    await captureIfNeeded()
    if (session !== generation) return
    observer?.disconnect()
    unlistenScroll()
    if (!pieces.length) {
      toast('Nothing captured')
      cancel()
      return
    }
    setState('processing')
    try {
      const gaps = coverage.length - 1
      const stitched = await stitch()
      if (session !== generation) {
        for (const part of stitched) URL.revokeObjectURL(part.url)
        return
      }
      parts = stitched
      sourceParts = stitched
      resultStem = fileStem()
      resultNotes = [
        `${frameCount} frame${frameCount === 1 ? '' : 's'}`,
        gaps > 0 ? `${gaps} gap${gaps === 1 ? '' : 's'} (scrolled too fast)` : ''
      ].filter(Boolean)
      pieces = []
      finishing = false
      setState('result')
    } catch (error) {
      console.error('[captureful] stitching failed', error)
      toast('Stitching failed. See console.')
      cancel()
    }
  }

  /* ---------------------------------- export ---------------------------------- */

  const fileStem = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `captureful-${location.host.replace(/[^\w.-]/g, '')}-${stamp}`
  }

  /** @param {Blob} blob @param {string} name */
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  /** @param {string} stem */
  const pngFiles = stem =>
    parts.map(
      (part, index) =>
        new File([part.blob], parts.length > 1 ? `${stem}-${index + 1}.png` : `${stem}.png`, {
          type: 'image/png'
        })
    )

  /**
   * Minimal PDF writer: each page is one JPEG slice, sized at 0.75pt per CSS pixel.
   *
   * @param {{
   *   jpeg: Uint8Array<ArrayBuffer>
   *   widthPixels: number
   *   heightPixels: number
   *   widthPoints: number
   *   heightPoints: number
   * }[]} pages
   */
  const buildPdf = pages => {
    const encoder = new TextEncoder()
    /** @type {Uint8Array<ArrayBuffer>[]} */
    const chunks = []
    /** @type {number[]} */
    const offsets = []
    let length = 0
    /** @param {string | Uint8Array<ArrayBuffer>} data */
    const push = data => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data
      chunks.push(bytes)
      length += bytes.length
    }
    /** @param {number} id @param {string} body @param {Uint8Array<ArrayBuffer>} [stream] */
    const object = (id, body, stream) => {
      offsets[id] = length
      push(`${id} 0 obj\n${body}\n`)
      if (stream) {
        push('stream\n')
        push(stream)
        push('\nendstream\n')
      }
      push('endobj\n')
    }
    push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n')
    const pageIds = pages.map((_, index) => 3 + index * 3)
    object(1, '<< /Type /Catalog /Pages 2 0 R >>')
    object(
      2,
      `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
    )
    pages.forEach((page, index) => {
      const pageId = 3 + index * 3
      const contentId = pageId + 1
      const imageId = pageId + 2
      const width = page.widthPoints.toFixed(2)
      const height = page.heightPoints.toFixed(2)
      const content = encoder.encode(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)
      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
      object(contentId, `<< /Length ${content.length} >>`, content)
      object(
        imageId,
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPixels} /Height ${page.heightPixels} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
        page.jpeg
      )
    })
    const objectCount = 3 + pages.length * 3
    const crossReferenceOffset = length
    push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`)
    for (let id = 1; id < objectCount; id++) {
      push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
    }
    push(
      `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF\n`
    )
    return new Blob(chunks, {
      type: 'application/pdf'
    })
  }

  const exportPdf = async () => {
    const scale = sessionScale || 1
    const maximumPageHeightPixels = Math.floor((MAXIMUM_PDF_PAGE_POINTS / 0.75) * scale)
    /** @type {Parameters<typeof buildPdf>[0]} */
    const pages = []
    for (const part of parts) {
      const bitmap = await createImageBitmap(part.blob)
      for (let top = 0; top < part.height; top += maximumPageHeightPixels) {
        const heightPixels = Math.min(maximumPageHeightPixels, part.height - top)
        const canvas = createCanvas(part.width, heightPixels)
        const context = context2d(canvas)
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, part.width, heightPixels)
        context.drawImage(bitmap, 0, top, part.width, heightPixels, 0, 0, part.width, heightPixels)
        const jpeg = new Uint8Array(
          await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()
        )
        pages.push({
          jpeg,
          widthPixels: part.width,
          heightPixels,
          widthPoints: (part.width / scale) * 0.75,
          heightPoints: (heightPixels / scale) * 0.75
        })
        canvas.width = 0
        canvas.height = 0
      }
      bitmap.close()
    }
    return buildPdf(pages)
  }

  /** @param {string} action */
  const runResultAction = async action => {
    const stem = resultStem || fileStem()
    if (action.startsWith('png:')) {
      const file = pngFiles(stem)[Number(action.slice(4))]
      if (file) download(file, file.name)
      return
    }
    if (action === 'pdf') {
      toast('Building PDF…')
      download(await exportPdf(), `${stem}.pdf`)
      return
    }
    if (action === 'share') {
      try {
        await navigator.share({ files: pngFiles(stem) })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Sharing failed')
      }
      return
    }
    if (action === 'copy') {
      const part = parts[0]
      if (!part) return
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': part.blob })])
        toast('Copied image')
      } catch {
        toast('Copy failed')
      }
    }
  }

  /* --------------------------------- rendering -------------------------------- */

  const trackHighlight = () => {
    cancelAnimationFrame(highlightAnimationFrame)
    const tick = () => {
      if (state === 'idle' || state === 'result') return
      positionHighlight()
      highlightAnimationFrame = requestAnimationFrame(tick)
    }
    highlightAnimationFrame = requestAnimationFrame(tick)
  }

  const positionHighlight = () => {
    if (!ui) return
    const element =
      state === 'confirm' || state === 'pick' || state === 'armed' ? candidate : (region ?? target)
    const { highlight } = ui
    if (!element || state === 'processing') {
      highlight.style.display = 'none'
      return
    }
    const { top, left, bottom, right } = highlightBoxOf(element)
    highlight.dataset.mode = state === 'capturing' ? 'outline' : 'tint'
    Object.assign(highlight.style, {
      display: 'block',
      top: `${top}px`,
      left: `${left}px`,
      width: `${Math.max(0, right - left)}px`,
      height: `${Math.max(0, bottom - top)}px`
    })
  }

  const renderPill = () => {
    if (!ui) return
    const { pill } = ui
    if (state === 'armed') {
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot" data-idle></span>
        <span class="label">Scroll the area to capture</span>
        <button data-action="pick">Pick area</button>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'capturing' && finishing) {
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot" data-idle></span>
        <span class="label">Finishing…</span>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'capturing') {
      const covered = coverage.reduce(
        (sum, [intervalStart, intervalEnd]) => sum + (intervalEnd - intervalStart),
        0
      )
      const status =
        coverage.length > 1
          ? '<span class="label warn">Gap: scroll back slower</span>'
          : `<span class="label">${frameCount} · ${formatPixels(covered)}${inflight ? ' …' : ''}</span>`
      const autoButtons = autoDirection
        ? '<button data-action="auto-stop">Pause</button>'
        : '<button data-action="auto-up" aria-label="Auto-scroll up">Auto ↑</button><button data-action="auto-down" aria-label="Auto-scroll down">Auto ↓</button>'
      pill.hidden = false
      pill.innerHTML = /* html */ `
        <span class="dot"></span>
        ${status}
        ${autoButtons}
        <button data-action="stop" data-danger>Stop</button>
        <button data-action="cancel" aria-label="Cancel">✕</button>
      `
      return
    }
    if (state === 'processing') {
      pill.hidden = false
      pill.innerHTML = '<span class="dot" data-idle></span><span class="label">Stitching…</span>'
      return
    }
    pill.hidden = true
    pill.innerHTML = ''
  }

  const renderSheet = () => {
    if (!ui) return
    const { sheet, catcher } = ui
    catcher.style.display = state === 'pick' ? 'block' : 'none'
    if (state === 'confirm' && candidate) {
      const contentHeight = isDocumentTarget(candidate)
        ? scrollingElement().scrollHeight
        : candidate.scrollHeight
      sheet.hidden = false
      sheet.innerHTML = /* html */ `
        <p>Capture this area?</p>
        <small>The highlighted area will be captured (${escapeHtml(formatPixels(contentHeight))} of content loaded).</small>
        <div class="row">
          <button data-action="use" data-primary>Use this</button>
          <button data-action="pick">Pick another</button>
          <button data-action="cancel">Cancel</button>
        </div>
      `
      return
    }
    if (state === 'pick') {
      sheet.hidden = false
      sheet.innerHTML = /* html */ `
        <p>${candidate ? 'Selected area' : 'Tap the area to capture'}</p>
        <small>${candidate ? 'Adjust the selection or tap somewhere else.' : 'A scrollable area or the part of the page around your tap gets selected.'}</small>
        <div class="row">
          <button data-action="bigger" ${candidate && largerThan(candidate) ? '' : 'disabled'}>↑ Bigger</button>
          <button data-action="smaller" ${pickStack.length ? '' : 'disabled'}>↓ Smaller</button>
          <button data-action="use" data-primary ${candidate ? '' : 'disabled'}>Use this</button>
          <button data-action="cancel">Cancel</button>
        </div>
      `
      return
    }
    sheet.hidden = true
    sheet.innerHTML = ''
  }

  const renderResult = () => {
    if (!ui) return
    const { result } = ui
    if (state !== 'result') {
      result.hidden = true
      result.innerHTML = ''
      return
    }
    const canShare =
      typeof navigator.canShare === 'function' && navigator.canShare({ files: pngFiles('check') })
    const canCopy =
      parts.length === 1 && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write
    result.hidden = false
    if (cropDraft) {
      renderCrop(result)
      return
    }
    const details = [
      parts[0] ? `${parts[0].width} × ${totalHeight(parts).toLocaleString()} px` : '',
      parts.length > 1 ? `${parts.length} images (size limit)` : '',
      ...resultNotes
    ]
      .filter(Boolean)
      .join(' · ')
    // Safari drops all but the last of several downloads started by one tap,
    // so each part gets its own button.
    result.innerHTML = /* html */ `
      <header>
        <span class="label">${escapeHtml(details)}</span>
        ${parts
          .map(
            (_, index) =>
              `<button data-action="png:${index}"${index ? '' : ' data-primary'}>Save PNG${parts.length > 1 ? ` ${index + 1}/${parts.length}` : ''}</button>`
          )
          .join('')}
        <button data-action="pdf">Save PDF</button>
        ${canShare ? '<button data-action="share">Share</button>' : ''}
        ${canCopy ? '<button data-action="copy">Copy</button>' : ''}
        <button data-action="crop">Crop</button>
        <button data-action="close">Close</button>
      </header>
      <div class="images">
        ${parts.map((part, index) => `<img src="${part.url}" alt="Captureful screenshot part ${index + 1}" width="${part.width}" height="${part.height}">`).join('')}
      </div>
    `
  }

  const render = () => {
    if (!ui) return
    if (state === 'idle') {
      ui.highlight.style.display = 'none'
      ui.catcher.style.display = 'none'
    }
    renderPill()
    renderSheet()
    renderResult()
    positionHighlight()
  }

  /** @param {Event} event */
  function onUiClick(event) {
    const button =
      event.target instanceof Element ? event.target.closest('button[data-action]') : null
    if (!(button instanceof HTMLButtonElement) || button.disabled) return
    const action = button.dataset.action ?? ''
    switch (action) {
      case 'cancel':
      case 'close':
        cancel()
        return
      case 'pick':
        setState('pick')
        return
      case 'use':
        if (!candidate) return
        saveArea(selectorFor(candidate))
        beginCapture(candidate)
        return
      case 'bigger': {
        if (!candidate) return
        const parent = largerThan(candidate)
        if (!parent) return
        pickStack.push(candidate)
        candidate = parent
        render()
        return
      }
      case 'smaller': {
        const previous = pickStack.pop()
        if (previous) candidate = previous
        render()
        return
      }
      case 'auto-up':
        void runAutoScroll(-1)
        return
      case 'auto-down':
        void runAutoScroll(1)
        return
      case 'auto-stop':
        autoDirection = 0
        renderPill()
        return
      case 'stop':
        void finish()
        return
      case 'crop':
        openCrop()
        return
      case 'crop-reset':
        if (!cropDraft) return
        cropDraft = { x: 0, y: 0, ...sourceSize() }
        positionCropBox()
        return
      case 'crop-cancel':
        closeCrop()
        return
      case 'crop-done':
        void applyCrop()
        return
      default:
        void runResultAction(action)
    }
  }

  /** @param {MouseEvent} event */
  function onCatcherClick(event) {
    if (!ui) return
    ui.catcher.style.display = 'none'
    const picked = pickAt(event.clientX, event.clientY)
    ui.catcher.style.display = 'block'
    if (!picked) {
      toast('Nothing to capture there')
      return
    }
    candidate = picked
    pickStack = []
    render()
  }

  /* ----------------------------------- crop ----------------------------------- */

  /** @param {typeof parts} list */
  const totalHeight = list => list.reduce((sum, part) => sum + part.height, 0)

  const sourceSize = () => ({
    width: sourceParts[0]?.width ?? 0,
    height: totalHeight(sourceParts)
  })

  /** @param {HTMLElement} result */
  const renderCrop = result => {
    // The source parts are stacked without gaps so they read as one image.
    result.innerHTML = /* html */ `
      <header>
        <span class="label" data-crop-size></span>
        <button data-action="crop-done" data-primary>Done</button>
        <button data-action="crop-reset">Reset</button>
        <button data-action="crop-cancel">Cancel</button>
      </header>
      <div class="images" data-crop>
        <div class="crop-stage">
          ${sourceParts.map((part, index) => `<img src="${part.url}" alt="Captureful screenshot part ${index + 1}" width="${part.width}" height="${part.height}" draggable="false">`).join('')}
          <div data-shade="top"></div>
          <div data-shade="bottom"></div>
          <div data-shade="left"></div>
          <div data-shade="right"></div>
          <div class="crop-box">
            ${CROP_HANDLES.map(handle => `<div data-handle="${handle}"></div>`).join('')}
          </div>
        </div>
      </div>
    `
    const stage = result.querySelector('.crop-stage')
    if (stage instanceof HTMLElement)
      stage.style.width = `min(100%, 720px, ${sourceSize().width}px)`
    positionCropBox()
  }

  const positionCropBox = () => {
    const root = ui?.root
    if (!root || !cropDraft) return
    const { width, height } = sourceSize()
    const { x, y, width: cropWidth, height: cropHeight } = cropDraft
    /** @param {number} value @param {number} total */
    const percent = (value, total) => `${(value / total) * 100}%`
    /** @param {string} selector @param {Partial<CSSStyleDeclaration>} styles */
    const place = (selector, styles) => {
      const element = root.querySelector(selector)
      if (element instanceof HTMLElement) Object.assign(element.style, styles)
    }
    const rows = { top: percent(y, height), height: percent(cropHeight, height) }
    place('.crop-box', { ...rows, left: percent(x, width), width: percent(cropWidth, width) })
    place('[data-shade="top"]', { height: rows.top })
    place('[data-shade="bottom"]', { top: percent(y + cropHeight, height) })
    place('[data-shade="left"]', { ...rows, width: percent(x, width) })
    place('[data-shade="right"]', { ...rows, left: percent(x + cropWidth, width) })
    const label = root.querySelector('[data-crop-size]')
    if (label)
      label.textContent = `${Math.round(cropWidth)} × ${Math.round(cropHeight).toLocaleString()} px`
    const reset = root.querySelector('[data-action="crop-reset"]')
    if (reset instanceof HTMLButtonElement && !cropBusy)
      reset.disabled = x === 0 && y === 0 && cropWidth === width && cropHeight === height
  }

  const openCrop = () => {
    const { width, height } = sourceSize()
    if (state !== 'result' || !width || !height) return
    cropDraft = cropRectangle ? { ...cropRectangle } : { x: 0, y: 0, width, height }
    renderResult()
    // Start at the top of the current crop rather than the top of the image.
    const images = ui?.root.querySelector('.images')
    const box = ui?.root.querySelector('.crop-box')
    if (images && box)
      images.scrollTop += box.getBoundingClientRect().top - images.getBoundingClientRect().top - 28
  }

  const closeCrop = () => {
    cropDraft = null
    cropDrag = null
    cancelAnimationFrame(cropAnimationFrame)
    cropAnimationFrame = 0
    renderResult()
  }

  /**
   * Cuts `rectangle` out of the stacked source parts, re-split to fit canvas limits.
   *
   * @param {NonNullable<typeof cropRectangle>} rectangle
   */
  const cropParts = async rectangle => {
    const maximumPartHeight = maximumPartHeightFor(rectangle.width)
    /** @type {typeof parts} */
    const result = []
    for (let partTop = 0; partTop < rectangle.height; partTop += maximumPartHeight) {
      const partHeight = Math.min(maximumPartHeight, rectangle.height - partTop)
      const canvas = createCanvas(rectangle.width, partHeight)
      const context = context2d(canvas)
      let sourceTop = 0
      for (const source of sourceParts) {
        const from = Math.max(rectangle.y + partTop, sourceTop)
        const to = Math.min(rectangle.y + partTop + partHeight, sourceTop + source.height)
        if (to > from) {
          const bitmap = await createImageBitmap(source.blob)
          context.drawImage(
            bitmap,
            rectangle.x,
            from - sourceTop,
            rectangle.width,
            to - from,
            0,
            from - rectangle.y - partTop,
            rectangle.width,
            to - from
          )
          bitmap.close()
        }
        sourceTop += source.height
      }
      result.push(await canvasToPart(canvas))
    }
    return result
  }

  const applyCrop = async () => {
    if (!cropDraft || cropBusy) return
    const { width, height } = sourceSize()
    const left = Math.round(cropDraft.x)
    const top = Math.round(cropDraft.y)
    const right = Math.round(cropDraft.x + cropDraft.width)
    const bottom = Math.round(cropDraft.y + cropDraft.height)
    /** @type {typeof cropRectangle} */
    const next =
      left === 0 && top === 0 && right === width && bottom === height
        ? null
        : { x: left, y: top, width: right - left, height: bottom - top }
    const unchanged =
      next === cropRectangle ||
      (!!next &&
        !!cropRectangle &&
        next.x === cropRectangle.x &&
        next.y === cropRectangle.y &&
        next.width === cropRectangle.width &&
        next.height === cropRectangle.height)
    if (unchanged) {
      closeCrop()
      return
    }
    cropBusy = true
    cropDrag = null
    for (const button of ui?.result.querySelectorAll('button') ?? []) button.disabled = true
    const session = generation
    try {
      const cropped = next ? await cropParts(next) : sourceParts
      if (session !== generation) {
        if (cropped !== sourceParts) for (const part of cropped) URL.revokeObjectURL(part.url)
        return
      }
      if (parts !== sourceParts) for (const part of parts) URL.revokeObjectURL(part.url)
      parts = cropped
      cropRectangle = next
      cropBusy = false
      closeCrop()
    } catch (error) {
      console.error('[captureful] crop failed', error)
      toast('Crop failed. See console.')
      cropBusy = false
      if (session === generation) renderResult()
    }
  }

  /** A client point in source image pixels. @param {number} clientX @param {number} clientY */
  const cropPoint = (clientX, clientY) => {
    const stage = ui?.root.querySelector('.crop-stage')
    if (!stage) return null
    const rectangle = stage.getBoundingClientRect()
    if (!rectangle.width) return null
    // Parts share one width, so one factor maps both axes.
    const scale = sourceSize().width / rectangle.width
    return {
      x: (clientX - rectangle.left) * scale,
      y: (clientY - rectangle.top) * scale,
      scale
    }
  }

  const dragCrop = () => {
    if (!cropDrag || !cropDraft) return
    const point = cropPoint(cropDrag.clientX, cropDrag.clientY)
    if (!point) return
    const { width, height } = sourceSize()
    const minimumWidth = Math.min(MINIMUM_CROP_CSS * point.scale, width)
    const minimumHeight = Math.min(MINIMUM_CROP_CSS * point.scale, height)
    const pointerX = point.x + cropDrag.offsetX
    const pointerY = point.y + cropDrag.offsetY
    let left = cropDraft.x
    let top = cropDraft.y
    let right = left + cropDraft.width
    let bottom = top + cropDraft.height
    const { handle } = cropDrag
    if (handle.includes('w')) left = Math.min(Math.max(pointerX, 0), right - minimumWidth)
    if (handle.includes('e')) right = Math.max(Math.min(pointerX, width), left + minimumWidth)
    if (handle.includes('n')) top = Math.min(Math.max(pointerY, 0), bottom - minimumHeight)
    if (handle.includes('s')) bottom = Math.max(Math.min(pointerY, height), top + minimumHeight)
    cropDraft = { x: left, y: top, width: right - left, height: bottom - top }
    positionCropBox()
  }

  // Tall captures don't fit on screen, so holding a handle near the preview's
  // top or bottom scrolls it, like dragging a selection past the edge.
  const edgeScroll = () => {
    cropAnimationFrame = 0
    const images = ui?.root.querySelector('.images')
    if (!cropDrag || !images || !/[ns]/.test(cropDrag.handle)) return
    const { top, bottom } = images.getBoundingClientRect()
    const y = cropDrag.clientY
    let speed = 0
    if (y < top + CROP_SCROLL_ZONE)
      speed = -Math.min(1, (top + CROP_SCROLL_ZONE - y) / CROP_SCROLL_ZONE)
    else if (y > bottom - CROP_SCROLL_ZONE)
      speed = Math.min(1, (y - bottom + CROP_SCROLL_ZONE) / CROP_SCROLL_ZONE)
    if (!speed) return
    images.scrollTop +=
      Math.sign(speed) * Math.max(1, Math.round(Math.abs(speed) * CROP_SCROLL_SPEED))
    dragCrop()
    cropAnimationFrame = requestAnimationFrame(edgeScroll)
  }

  /** @param {Event} event */
  function onCropPointerDown(event) {
    if (!cropDraft || cropBusy || !(event instanceof PointerEvent)) return
    const handle = event.target instanceof Element ? event.target.closest('[data-handle]') : null
    if (!(handle instanceof HTMLElement)) return
    const point = cropPoint(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    const name = handle.dataset.handle ?? ''
    const { x, y, width, height } = cropDraft
    // Keep the grabbed edge where it is instead of snapping it to the pointer.
    const edgeX = name.includes('w') ? x : name.includes('e') ? x + width : point.x
    const edgeY = name.includes('n') ? y : name.includes('s') ? y + height : point.y
    cropDrag = {
      handle: name,
      pointerId: event.pointerId,
      offsetX: edgeX - point.x,
      offsetY: edgeY - point.y,
      clientX: event.clientX,
      clientY: event.clientY
    }
  }

  /** @param {Event} event */
  function onCropPointerMove(event) {
    if (!(event instanceof PointerEvent) || event.pointerId !== cropDrag?.pointerId) return
    cropDrag.clientX = event.clientX
    cropDrag.clientY = event.clientY
    dragCrop()
    if (!cropAnimationFrame) cropAnimationFrame = requestAnimationFrame(edgeScroll)
  }

  /** @param {Event} event */
  function onCropPointerUp(event) {
    if (!(event instanceof PointerEvent) || event.pointerId !== cropDrag?.pointerId) return
    cropDrag = null
    cancelAnimationFrame(cropAnimationFrame)
    cropAnimationFrame = 0
  }

  /* --------------------------------- trigger ---------------------------------- */

  browser.runtime.onMessage.addListener(message => {
    if (message?.type !== 'toggle') return
    if (state === 'idle') void start()
    else if (state === 'capturing') void finish()
    else if (state !== 'processing') cancel()
  })
})()
