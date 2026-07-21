/* Frontend Debugger — in-page inspection agent (v2).
 *
 * Injected as the first <head> script into the target app (before React loads),
 * so it can install the React DevTools global hook and later walk the live fiber
 * tree. Everything here runs INSIDE the target page (the iframe). It never draws
 * UI in the page — it only reads the DOM/CSSOM/fibers and reports to the parent
 * debugger over postMessage.
 *
 * Design notes:
 *  - Modes: 'interact' (fully passive — the app works normally, you can navigate),
 *    'pick' (hover+click to select), 'theater' (driven by the parent overlay).
 *    Default is 'interact' so the embedded app is never hijacked unexpectedly.
 *  - Component identity is a STABLE PATH of child-indices from the fiber root,
 *    not an object reference. React recreates fibers on every commit, so object
 *    ids go stale; a path re-resolves against the live tree and survives
 *    re-renders, which is what makes selecting in a recursive tree reliable.
 *  - Live style edits are applied to the CSSOM for preview only; the agent never
 *    writes anything. The parent decides whether to persist.
 *
 * Plain ES2018, no imports — injected verbatim as a classic <script>.
 */
;(function () {
  'use strict'
  if (window.__FEDBG_AGENT__) return
  window.__FEDBG_AGENT__ = true

  var PARENT_ORIGIN = (window.__FEDBG__ && window.__FEDBG__.uiOrigin) || '*'

  // ---- Network capture (the click→log join feed) ----------------------------
  // Wrap fetch NOW — this script runs before React and before devMock installs
  // its interceptor, so in LIVE mode every /api call flows through here and
  // reports its X-Request-Id (the backend CORS-exposes it). In MOCK mode
  // devMock answers before this wrapper sees the call, so only fall-through
  // requests land — the Network tab says so. `send` is hoisted (declared in
  // the message bridge below).
  var lastInteractionAt = 0
  try {
    window.addEventListener(
      'pointerdown',
      function () {
        lastInteractionAt = Date.now()
      },
      true,
    )
    window.addEventListener(
      'keydown',
      function () {
        lastInteractionAt = Date.now()
      },
      true,
    )
  } catch (e) {}
  ;(function () {
    var nativeFetch = window.fetch
    if (typeof nativeFetch !== 'function') return
    var isApiPath = function (p) {
      return p.indexOf('/api') === 0 || p.indexOf('/healthz') === 0
    }
    window.fetch = function (input, init) {
      var started = Date.now()
      var url = ''
      var method = 'GET'
      try {
        var raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input)
        method =
          (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'
        var u = new URL(raw, location.href)
        url = u.pathname + u.search
      } catch (e) {}
      var p = nativeFetch.apply(this, arguments)
      try {
        p.then(
          function (res) {
            try {
              if (!url || !isApiPath(url)) return
              var gap = lastInteractionAt ? started - lastInteractionAt : null
              send({
                type: 'netreq',
                method: String(method).toUpperCase(),
                url: url,
                status: res ? res.status : 0,
                ms: Date.now() - started,
                requestId: res && res.headers ? res.headers.get('X-Request-Id') : null,
                clickGap: gap != null && gap >= 0 ? gap : null,
              })
            } catch (e) {}
          },
          function () {
            try {
              if (!url || !isApiPath(url)) return
              send({
                type: 'netreq',
                method: String(method).toUpperCase(),
                url: url,
                status: 0,
                ms: Date.now() - started,
                requestId: null,
                clickGap: null,
              })
            } catch (e) {}
          },
        )
      } catch (e) {}
      return p
    }
  })()

  // ---- React DevTools hook (must exist before react-dom initialises) -------
  var renderers = new Map()
  var fiberRoots = new Map()
  var rid = 0

  function ensureSet(map, id) {
    var s = map.get(id)
    if (!s) {
      s = new Set()
      map.set(id, s)
    }
    return s
  }

  var existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!existing) {
    var hook = {
      supportsFiber: true,
      renderers: renderers,
      _fedbg: true,
      inject: function (renderer) {
        var id = ++rid
        renderers.set(id, renderer)
        return id
      },
      onScheduleFiberRoot: function () {},
      onCommitFiberRoot: function (id, root) {
        ensureSet(fiberRoots, id).add(root)
        scheduleWatch()
      },
      onCommitFiberUnmount: function () {},
      onPostCommitFiberRoot: function () {},
      checkDCE: function () {},
      on: function () {},
      off: function () {},
      sub: function () {
        return function () {}
      },
      emit: function () {},
      getFiberRoots: function (id) {
        return ensureSet(fiberRoots, id)
      },
    }
    try {
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
        value: hook,
        configurable: true,
        writable: true,
      })
    } catch (e) {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
    }
  } else if (!existing._fedbg) {
    var origCommit = existing.onCommitFiberRoot
    existing.onCommitFiberRoot = function (id, root) {
      ensureSet(fiberRoots, id).add(root)
      scheduleWatch()
      if (origCommit) return origCommit.apply(this, arguments)
    }
    if (!existing.getFiberRoots)
      existing.getFiberRoots = function (id) {
        return ensureSet(fiberRoots, id)
      }
  }

  function getRoots() {
    var out = []
    fiberRoots.forEach(function (set) {
      set.forEach(function (r) {
        if (r && r.current) out.push(r.current)
      })
    })
    if (!out.length) {
      var rootEl = document.getElementById('root') || document.body.firstElementChild
      var f = rootEl && getFiberFromDom(rootEl)
      if (f) {
        var top = f
        while (top.return) top = top.return
        out.push(top)
      }
    }
    return out
  }

  // ---- Fiber helpers --------------------------------------------------------
  function getFiberFromDom(el) {
    if (!el) return null
    for (var k in el) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0)
        return el[k]
    }
    return null
  }

  function isComponentFiber(f) {
    if (!f) return false
    var tag = f.tag
    return tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15
  }

  function getComponentName(f) {
    if (!f) return null
    var t = f.type
    if (t == null) return f.tag === 3 ? 'Root' : null
    if (typeof t === 'string') return t
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous'
    if (typeof t === 'object') {
      if (t.render) return t.render.displayName || t.render.name || 'ForwardRef'
      if (t.type) return nameFromType(t.type) || 'Memo'
    }
    return 'Anonymous'
  }
  function nameFromType(t) {
    if (!t) return null
    if (typeof t === 'string') return t
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous'
    if (typeof t === 'object' && t.render) return t.render.displayName || t.render.name || 'ForwardRef'
    return null
  }

  function nearestComponentFiber(f) {
    var cur = f
    while (cur) {
      if (isComponentFiber(cur)) return cur
      cur = cur.return
    }
    return null
  }
  function parentComponentFiber(f) {
    var cur = f && f.return
    while (cur) {
      if (isComponentFiber(cur)) return cur
      cur = cur.return
    }
    return null
  }

  // outermost host elements rendered directly by a fiber's subtree
  function topHostElements(fiber) {
    var out = []
    function descend(f) {
      var c = f.child
      while (c) {
        if (c.stateNode && c.stateNode.nodeType === 1) out.push(c.stateNode)
        else descend(c)
        c = c.sibling
      }
    }
    if (fiber.stateNode && fiber.stateNode.nodeType === 1) out.push(fiber.stateNode)
    else descend(fiber)
    return out
  }
  function allHostElements(fiber, limit) {
    var out = []
    function descend(f) {
      if (out.length >= (limit || 2000)) return
      var c = f.child
      while (c) {
        if (c.stateNode && c.stateNode.nodeType === 1) out.push(c.stateNode)
        descend(c)
        c = c.sibling
      }
    }
    descend(fiber)
    return out
  }
  function boxOfElements(els) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      any = true
      if (r.left < x0) x0 = r.left
      if (r.top < y0) y0 = r.top
      if (r.right > x1) x1 = r.right
      if (r.bottom > y1) y1 = r.bottom
    }
    if (!any) return null
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  function boxOfFiber(fiber) {
    try {
      var b = boxOfElements(topHostElements(fiber))
      // Parents whose outermost host is a zero-size wrapper (fragments, portals)
      // need a full-subtree union so their boundary still renders.
      if (!b || b.width < 1 || b.height < 1) b = boxOfElements(allHostElements(fiber, 1500))
      return b
    } catch (e) {
      return null
    }
  }
  function firstLevelChildComponents(fiber) {
    var out = []
    function descend(f) {
      var c = f.child
      while (c) {
        if (isComponentFiber(c)) out.push(c)
        else descend(c)
        c = c.sibling
      }
    }
    descend(fiber)
    return out
  }

  // ---- Stable path identity -------------------------------------------------
  function indexAmongSiblings(f) {
    var idx = 0
    var c = f.return ? f.return.child : null
    while (c && c !== f) {
      idx++
      c = c.sibling
    }
    return idx
  }
  function pathOfFiber(fiber) {
    var path = []
    var cur = fiber
    while (cur && cur.return) {
      path.unshift(indexAmongSiblings(cur))
      cur = cur.return
    }
    return path
  }
  function pathId(fiber) {
    return pathOfFiber(fiber).join('.')
  }
  function fiberByPath(idStr) {
    if (idStr == null || idStr === '') return getRoots()[0] || null
    var path = String(idStr).split('.').map(Number)
    var cur = getRoots()[0]
    if (!cur) return null
    for (var i = 0; i < path.length; i++) {
      var c = cur.child
      var j = 0
      while (c && j < path[i]) {
        c = c.sibling
        j++
      }
      if (!c) return null
      cur = c
    }
    return cur
  }

  // ---- Route discovery (react-router, read from the live fiber tree) --------
  // The debugger must work on ANY react-router app, not just nodewatch. buildTree
  // deliberately skips context providers (tag 10) — but that's exactly where
  // react-router keeps its route table, current match, and basename. So we do a
  // raw walk over the tag-10 fibers buildTree ignores and classify each context
  // by the SHAPE of its value (never importing react-router, never trusting
  // displayName), so detection survives react-router version bumps. Everything is
  // try/caught: this must never throw into the target page, and a non-react-router
  // app simply yields { source: 'none' }.
  function walkAllFibers(root, cb, cap) {
    var limit = cap || 30000
    var count = 0
    function visit(node) {
      var f = node
      while (f) {
        if (count >= limit) return
        count++
        try {
          cb(f)
        } catch (e) {}
        if (f.child) visit(f.child)
        f = f.sibling
      }
    }
    try {
      visit(root)
    } catch (e) {}
  }

  var REACT_FRAGMENT = typeof Symbol === 'function' && Symbol.for ? Symbol.for('react.fragment') : null

  // Flatten a react children value (arrays + fragments) into a flat element list.
  function flattenChildren(ch, out) {
    out = out || []
    if (ch == null || ch === false || ch === true) return out
    if (Array.isArray(ch)) {
      for (var i = 0; i < ch.length; i++) flattenChildren(ch[i], out)
      return out
    }
    if (ch.type != null && ch.type === REACT_FRAGMENT && ch.props) {
      flattenChildren(ch.props.children, out)
      return out
    }
    out.push(ch)
    return out
  }

  function joinRoutePath(a, b) {
    if (!b) return a || '/'
    var left = a && a !== '/' ? a : ''
    var right = b.charAt(0) === '/' ? b : '/' + b
    return left + right || '/'
  }

  function prettyRouteLabel(path) {
    if (!path || path === '/') return 'Home'
    var segs = path.split('/').filter(Boolean)
    var last = (segs[segs.length - 1] || '').replace(/[:*]/g, '')
    if (!last) return 'Home'
    return last.charAt(0).toUpperCase() + last.slice(1).replace(/[-_]/g, ' ')
  }

  function pushRoute(out, seen, routeObj, full) {
    if (!full || seen[full]) return
    seen[full] = true
    var label = (routeObj && routeObj.handle && routeObj.handle.label) || prettyRouteLabel(full)
    out.push({ id: full, path: full, label: label, group: 'Primary', dynamic: /[:*]/.test(full) })
  }

  // Data-router (createBrowserRouter): walk the resolved route objects.
  function collectDataRoutes(routes, parentPath, out, seen) {
    if (!Array.isArray(routes)) return
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i]
      if (!r) continue
      var seg = r.index ? '' : r.path || ''
      var full = joinRoutePath(parentPath, seg)
      if (r.path || r.index) pushRoute(out, seen, r, full)
      if (r.children) collectDataRoutes(r.children, full, out, seen)
    }
  }

  // Declarative (<Routes><Route .../></Routes>): reconstruct from the user's own
  // JSX props — version-independent, no react-router internals involved.
  function collectJsxRoutes(children, parentPath, out, seen) {
    var arr = flattenChildren(children)
    for (var i = 0; i < arr.length; i++) {
      var el = arr[i]
      if (!el || typeof el !== 'object' || !el.props) continue
      var p = el.props
      var seg = p.index ? '' : p.path || ''
      var full = joinRoutePath(parentPath, seg)
      if (p.path || p.index) pushRoute(out, seen, p, full)
      if (p.children) collectJsxRoutes(p.children, full, out, seen)
    }
  }

  function detectRoutes() {
    try {
      var roots = getRoots()
      if (!roots.length) return { source: 'none', routes: [] }
      var dataRouter = null
      var basename = null
      var activePath = null
      var deepestRoute = null
      var deepestLen = -1
      var routesFiber = null
      var onFiber = function (f) {
        if (f.tag === 10) {
          var val = f.memoizedProps && f.memoizedProps.value
          if (!val || typeof val !== 'object') return
          if (val.router && val.router.routes && val.router.state) {
            dataRouter = val.router
          } else if (Array.isArray(val.matches) && 'outlet' in val) {
            if (val.matches.length > deepestLen) {
              deepestLen = val.matches.length
              deepestRoute = f
            }
          } else if (val.navigator && val.basename !== undefined) {
            if (basename == null) basename = val.basename
          } else if (val.location && val.navigationType !== undefined) {
            if (activePath == null) activePath = val.location.pathname
          }
        } else if (routesFiber == null && getComponentName(f) === 'Routes') {
          routesFiber = f
        }
      }
      for (var ri = 0; ri < roots.length; ri++) walkAllFibers(roots[ri], onFiber)

      var routes = []
      var seen = {}
      if (dataRouter) {
        if (basename == null) basename = dataRouter.basename
        if (activePath == null && dataRouter.state && dataRouter.state.location)
          activePath = dataRouter.state.location.pathname
        collectDataRoutes(dataRouter.routes, '', routes, seen)
      } else if (routesFiber && routesFiber.memoizedProps) {
        collectJsxRoutes(routesFiber.memoizedProps.children, '', routes, seen)
      }
      if (!dataRouter && !routesFiber) return { source: 'none', routes: [] }

      var pageId = null
      if (deepestRoute) {
        var pf = firstLevelChildComponents(deepestRoute)[0]
        if (pf) pageId = pathId(pf)
      }
      var picker = []
      for (var i = 0; i < routes.length; i++) if (!routes[i].dynamic) picker.push(routes[i])
      return {
        source: 'live',
        basename: basename == null ? '' : basename,
        active: activePath,
        pageId: pageId,
        routes: picker,
        all: routes,
      }
    } catch (e) {
      return { source: 'none', routes: [], error: String((e && e.message) || e) }
    }
  }

  // The "app anchor": the app-root component just below the router chrome
  // (Auth0Provider/AuthGuard/ErrorBoundary/ToastProvider/BrowserRouter/Router).
  // Rooting the tree + breadcrumb here keeps paths relative to the app root
  // instead of drowning them in provider wrappers — the whole reason a target's
  // page tree is what you want to see, not its bootstrap chrome. Generic: find
  // the OUTERMOST router boundary (react-router's NavigationContext, or a data
  // router) by context SHAPE, then take its first component child. null → no
  // router detected → callers fall back to the full tree.
  var cachedAnchorId = null
  function routeAnchorFiber() {
    try {
      var roots = getRoots()
      if (!roots.length) return null
      var boundary = null
      var onFiber = function (f) {
        if (boundary || f.tag !== 10) return
        var val = f.memoizedProps && f.memoizedProps.value
        if (!val || typeof val !== 'object') return
        if (
          (val.router && val.router.routes && val.router.state) ||
          (val.navigator && val.basename !== undefined)
        )
          boundary = f
      }
      for (var i = 0; i < roots.length && !boundary; i++) walkAllFibers(roots[i], onFiber)
      if (!boundary) return null
      return firstLevelChildComponents(boundary)[0] || null
    } catch (e) {
      return null
    }
  }

  function ancestorChain(fiber) {
    var chain = []
    var cur = fiber
    while (cur) {
      if (isComponentFiber(cur)) chain.unshift({ id: pathId(cur), name: getComponentName(cur) })
      cur = cur.return
    }
    // Trim provider chrome above the app anchor so the breadcrumb reads relative
    // to the app root. If the selected node sits above the anchor (chrome), the
    // anchor isn't in its chain → show the full path unchanged.
    if (cachedAnchorId) {
      for (var i = 0; i < chain.length; i++) if (chain[i].id === cachedAnchorId) return chain.slice(i)
    }
    return chain
  }
  function ancestorNames(fiber, max) {
    var names = []
    var cur = fiber
    while (cur && names.length < (max || 8)) {
      if (isComponentFiber(cur)) names.unshift(getComponentName(cur))
      cur = cur.return
    }
    return names
  }

  function relativeFiber(fiber, dir) {
    if (dir === 'parent') return parentComponentFiber(fiber)
    if (dir === 'child') return firstLevelChildComponents(fiber)[0] || null
    var container = parentComponentFiber(fiber) || getRoots()[0]
    if (!container) return null
    var sibs = firstLevelChildComponents(container)
    var myId = pathId(fiber)
    var i = -1
    for (var k = 0; k < sibs.length; k++) {
      if (pathId(sibs[k]) === myId) {
        i = k
        break
      }
    }
    if (i < 0) return null
    return dir === 'prev' ? sibs[i - 1] || null : sibs[i + 1] || null
  }

  // ---- Source location ------------------------------------------------------
  function sourceOfFiber(fiber) {
    var name = getComponentName(fiber)
    var hosts = allHostElements(fiber, 600)
    var best = null
    for (var i = 0; i < hosts.length; i++) {
      var el = hosts[i]
      var file = el.getAttribute && el.getAttribute('data-inspect-file')
      if (!file) continue
      var line = parseInt(el.getAttribute('data-inspect-line') || '0', 10)
      var col = parseInt(el.getAttribute('data-inspect-col') || '0', 10)
      var elName = el.getAttribute('data-inspect-name')
      if (elName && name && elName === name) {
        if (!best || best._m || line < best.line) best = { file: file, line: line, col: col, _m: false }
      } else if (!best) {
        best = { file: file, line: line, col: col, _m: true }
      }
    }
    if (best) delete best._m
    return best
  }
  function sourceOfElement(el) {
    if (!el || !el.getAttribute) return null
    var node = el
    while (node && !(node.getAttribute && node.getAttribute('data-inspect-file')))
      node = node.parentElement
    if (!node) return null
    return {
      file: node.getAttribute('data-inspect-file'),
      line: parseInt(node.getAttribute('data-inspect-line') || '0', 10),
      col: parseInt(node.getAttribute('data-inspect-col') || '0', 10),
      name: node.getAttribute('data-inspect-name') || null,
    }
  }

  // ---- Matched CSS ----------------------------------------------------------
  var STATE_PSEUDO = /:(hover|focus|focus-within|focus-visible|active|visited|target|enabled|disabled|checked|valid|invalid|required|optional|placeholder-shown)/g
  var PSEUDO_EL = /::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button)/g

  function safeMatches(el, sel) {
    try {
      if (el.matches(sel)) return { match: true, stateOnly: false }
    } catch (e) {}
    var base = sel.replace(PSEUDO_EL, '').replace(STATE_PSEUDO, '').trim()
    if (base && base !== sel) {
      try {
        if (el.matches(base)) return { match: true, stateOnly: true }
      } catch (e2) {}
    }
    return { match: false }
  }
  function safeMedia(mt) {
    try {
      return window.matchMedia(mt).matches
    } catch (e) {
      return false
    }
  }
  function declsOf(style) {
    var out = []
    for (var i = 0; i < style.length; i++) {
      var prop = style[i]
      out.push({
        prop: prop,
        value: style.getPropertyValue(prop),
        important: style.getPropertyPriority(prop) === 'important',
      })
    }
    return out
  }
  function matchedRulesFor(el) {
    var matched = []
    var allMedia = {}
    var sheets = document.styleSheets
    function walk(rules, media) {
      if (!rules) return
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i]
        if (rule.type === 1) {
          var selText = rule.selectorText
          if (!selText) continue
          var parts = selText.split(',')
          var hit = null
          for (var p = 0; p < parts.length; p++) {
            var m = safeMatches(el, parts[p].trim())
            if (m.match) {
              hit = { stateOnly: m.stateOnly, selectorPart: parts[p].trim() }
              break
            }
          }
          if (hit) {
            matched.push({
              selectorText: selText,
              selectorPart: hit.selectorPart,
              stateOnly: hit.stateOnly,
              media: media,
              mediaActive: media ? safeMedia(media) : true,
              cssText: rule.style.cssText,
              declarations: declsOf(rule.style),
            })
          }
        } else if (rule.type === 4) {
          var mt = rule.media && rule.media.mediaText
          if (mt) allMedia[mt] = safeMedia(mt)
          walk(rule.cssRules, mt || media)
        } else if (rule.type === 12) {
          walk(rule.cssRules, media)
        }
      }
    }
    for (var s = 0; s < sheets.length; s++) {
      var rules
      try {
        rules = sheets[s].cssRules
      } catch (e) {
        continue
      }
      walk(rules, null)
    }
    return { matched: matched, allMedia: allMedia }
  }
  function computedBox(el) {
    var cs = getComputedStyle(el)
    var g = function (p) {
      return cs.getPropertyValue(p)
    }
    return {
      width: g('width'),
      height: g('height'),
      display: g('display'),
      position: g('position'),
      color: g('color'),
      background: g('background-color'),
      fontSize: g('font-size'),
      fontFamily: g('font-family'),
      margin: [g('margin-top'), g('margin-right'), g('margin-bottom'), g('margin-left')],
      padding: [g('padding-top'), g('padding-right'), g('padding-bottom'), g('padding-left')],
      border: [g('border-top-width'), g('border-right-width'), g('border-bottom-width'), g('border-left-width')],
    }
  }

  // ---- Inherited styles -----------------------------------------------------
  // Properties that cascade to descendants. Inherited rules are the rules on
  // ANCESTOR elements that set one of these (Chrome's "Inherited from" section).
  var INHERITED_PROPS = {
    color: 1, cursor: 1, visibility: 1, direction: 1,
    font: 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1,
    'font-variant': 1, 'font-stretch': 1, 'line-height': 1, 'letter-spacing': 1,
    'word-spacing': 1, 'text-align': 1, 'text-indent': 1, 'text-transform': 1,
    'text-shadow': 1, 'white-space': 1, 'word-break': 1, 'overflow-wrap': 1,
    'list-style': 1, 'list-style-type': 1, 'list-style-position': 1,
    'border-collapse': 1, 'caption-side': 1, 'empty-cells': 1, quotes: 1,
    'tab-size': 1, 'color-scheme': 1, 'accent-color': 1,
  }
  function componentNameForEl(node) {
    var f = nearestComponentFiber(getFiberFromDom(node))
    return f ? getComponentName(f) : null
  }
  function inheritedFor(el) {
    var groups = []
    var node = el.parentElement
    var depth = 0
    while (node && node.nodeType === 1 && depth < 8) {
      var res = matchedRulesFor(node)
      var rules = []
      for (var i = 0; i < res.matched.length; i++) {
        var r = res.matched[i]
        var decls = r.declarations.filter(function (d) {
          return INHERITED_PROPS[d.prop]
        })
        if (decls.length)
          rules.push({
            selectorText: r.selectorText,
            media: r.media,
            mediaActive: r.mediaActive,
            declarations: decls,
          })
      }
      if (rules.length) {
        groups.push({
          name: componentNameForEl(node) || node.tagName.toLowerCase(),
          tag: node.tagName.toLowerCase(),
          source: sourceOfElement(node),
          rules: rules,
        })
      }
      node = node.parentElement
      depth++
    }
    return groups
  }

  // ---- Build component tree -------------------------------------------------
  function buildTree(maxNodes) {
    var count = 0
    function collect(fiber, basePath) {
      var out = []
      var c = fiber.child
      var idx = 0
      while (c) {
        var p = basePath.concat(idx)
        if (isComponentFiber(c)) {
          if (count++ < (maxNodes || 6000)) {
            out.push({ id: p.join('.'), name: getComponentName(c), children: collect(c, p) })
          }
        } else {
          var sub = collect(c, p)
          for (var k = 0; k < sub.length; k++) out.push(sub[k])
        }
        c = c.sibling
        idx++
      }
      return out
    }
    // Root the tree at the app anchor (below the provider chrome) when a router
    // is detected — ids stay absolute paths from the real root, so selection and
    // rebox keep working. No anchor → fall back to the full tree from the roots.
    var anchor = routeAnchorFiber()
    cachedAnchorId = anchor ? pathId(anchor) : null
    if (anchor) {
      var ap = pathOfFiber(anchor)
      return [{ id: ap.join('.'), name: getComponentName(anchor), children: collect(anchor, ap) }]
    }
    var roots = getRoots()
    var result = []
    for (var i = 0; i < roots.length; i++) {
      var kids = collect(roots[i], [])
      for (var j = 0; j < kids.length; j++) result.push(kids[j])
    }
    return result
  }

  // ---- Props preview --------------------------------------------------------
  function safeProps(fiber) {
    try {
      var props = fiber.memoizedProps || {}
      var out = {}
      var keys = Object.keys(props).slice(0, 40)
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i]
        out[k] = k === 'children' ? '«children»' : previewValue(props[k])
      }
      return out
    } catch (e) {
      return null
    }
  }
  function previewValue(v) {
    var t = typeof v
    if (v == null) return String(v)
    if (t === 'function') return 'ƒ ' + (v.name || 'anonymous')
    if (t === 'string') return v.length > 100 ? v.slice(0, 100) + '…' : v
    if (t === 'number' || t === 'boolean') return v
    if (Array.isArray(v)) return 'Array(' + v.length + ')'
    if (t === 'object') {
      if (v.$$typeof) return '«ReactElement»'
      try {
        var s = JSON.stringify(v)
        return s.length > 100 ? s.slice(0, 100) + '…' : s
      } catch (e) {
        return '«object»'
      }
    }
    return String(v)
  }

  // Deep-but-bounded serialization for a single hook value: caps strings ~200,
  // arrays/objects to ~50 entries, recursion depth 3, and drops cycles. Never
  // throws — a hook holding an exotic value must not break the payload.
  function serializeValue(v, depth, seen) {
    try {
      var t = typeof v
      if (v == null) return v === undefined ? '«undefined»' : null
      if (t === 'function') return 'ƒ ' + (v.name || 'anonymous')
      if (t === 'boolean' || t === 'number') return v
      if (t === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
      if (t === 'symbol' || t === 'bigint') return String(v)
      if (t === 'object') {
        if (v.$$typeof) return '«ReactElement»'
        if (seen.indexOf(v) >= 0) return '«circular»'
        if (depth <= 0) return Array.isArray(v) ? 'Array(' + v.length + ')' : '«object»'
        seen.push(v)
        var result
        if (Array.isArray(v)) {
          result = []
          for (var i = 0; i < v.length && i < 50; i++) result.push(serializeValue(v[i], depth - 1, seen))
          if (v.length > 50) result.push('…(' + (v.length - 50) + ' more)')
        } else if (v instanceof Date) {
          result = v.toISOString()
        } else if (v instanceof Element) {
          result = '«<' + v.tagName.toLowerCase() + '>»'
        } else if (typeof Map !== 'undefined' && v instanceof Map) {
          result = 'Map(' + v.size + ')'
        } else if (typeof Set !== 'undefined' && v instanceof Set) {
          result = 'Set(' + v.size + ')'
        } else {
          result = {}
          var keys = Object.keys(v).slice(0, 50)
          for (var k = 0; k < keys.length; k++) result[keys[k]] = serializeValue(v[keys[k]], depth - 1, seen)
          if (Object.keys(v).length > 50) result['…'] = '(' + (Object.keys(v).length - 50) + ' more keys)'
        }
        seen.pop()
        return result
      }
      return String(v)
    } catch (e) {
      return '«unserializable»'
    }
  }

  // ---- Hooks ----------------------------------------------------------------
  // Walk the selected fiber's memoizedState linked list. React does not tag hook
  // slots with their kind, so we classify best-effort from the slot's SHAPE:
  //   - {current: ...}                       → useRef
  //   - {memoizedState:[value, deps]}        → useMemo / useCallback
  //   - {memoizedState, queue:{dispatch}}    → useState / useReducer (the state)
  //   - {memoizedState, deps} with no value  → useEffect / useLayoutEffect
  // Function components only (tag 0/14/15); class/host fibers have no hook list.
  function hookKind(hook) {
    if (!hook || typeof hook !== 'object') return 'hook'
    var ms = hook.memoizedState
    if (ms && typeof ms === 'object' && 'current' in ms && Object.keys(ms).length === 1) return 'useRef'
    if (Array.isArray(ms) && ms.length === 2 && (Array.isArray(ms[1]) || ms[1] === null)) {
      return typeof ms[0] === 'function' ? 'useCallback' : 'useMemo'
    }
    if (ms && typeof ms === 'object' && ms.tag !== undefined && ms.create !== undefined) return 'useEffect'
    if (hook.queue && hook.queue.dispatch) return 'useState'
    return 'useState'
  }
  function collectHooks(fiber) {
    try {
      if (!fiber || (fiber.tag !== 0 && fiber.tag !== 14 && fiber.tag !== 15)) return null
      var hook = fiber.memoizedState
      // Class components store memoizedState as plain state (no `.next`); bail.
      if (!hook || typeof hook !== 'object' || !('next' in hook)) return null
      var out = []
      var idx = 0
      while (hook && idx < 60) {
        var kind = hookKind(hook)
        var value
        if (kind === 'useRef') value = serializeValue(hook.memoizedState && hook.memoizedState.current, 3, [])
        else if (kind === 'useMemo' || kind === 'useCallback') value = '«' + kind + '»'
        else if (kind === 'useEffect') value = '«effect»'
        else value = serializeValue(hook.memoizedState, 3, [])
        out.push({ index: idx, kind: kind, value: value })
        hook = hook.next
        idx++
      }
      return out
    } catch (e) {
      return null
    }
  }

  // ---- Selection payload ----------------------------------------------------
  var currentEl = null
  function primaryElementOf(fiber) {
    var name = getComponentName(fiber)
    var hosts = allHostElements(fiber, 600)
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute && hosts[i].getAttribute('data-inspect-name') === name)
        return hosts[i]
    }
    return topHostElements(fiber)[0] || hosts[0] || null
  }
  function describeFiber(fiber, preferEl, opts) {
    opts = opts || {}
    var el = preferEl || primaryElementOf(fiber)
    currentEl = el
    var id = pathId(fiber)
    // Track this id so its boundary follows the component as the app scrolls.
    // A live-watch re-describe (keepTracked) must NOT reset tracked/watchId —
    // that would clobber theater drill boxes and hijack the watched component.
    if (!opts.keepTracked) {
      tracked = new Set([id])
      watchId = id
    }
    var css = el ? matchedRulesFor(el) : { matched: [], allMedia: {} }
    return {
      id: id,
      name: getComponentName(fiber),
      tag: el ? el.tagName.toLowerCase() : null,
      box: boxOfFiber(fiber),
      source: sourceOfFiber(fiber) || (el ? sourceOfElement(el) : null),
      path: ancestorChain(fiber),
      css: css.matched,
      allMedia: css.allMedia,
      inherited: el ? inheritedFor(el) : [],
      computed: el ? computedBox(el) : null,
      props: safeProps(fiber),
      hooks: collectHooks(fiber),
      childCount: firstLevelChildComponents(fiber).length,
    }
  }

  // ---- Scroll/resize tracking (keep boundaries glued to components) --------
  // The selection box (and theater drill boxes) are viewport-relative rects; if
  // the app scrolls or resizes, they must be recomputed or they drift/vanish.
  var tracked = new Set()
  // Live Watch: the currently-inspected component's id, re-emitted on each React
  // commit (throttled via watchTimer) so its props/hooks/value pane update live.
  var watchId = null
  var watchTimer = null
  var lastMoveX = -1
  var lastMoveY = -1
  function reboxTracked() {
    if (!tracked.size) return
    var boxes = {}
    var any = false
    tracked.forEach(function (id) {
      var f = fiberByPath(id)
      if (f) {
        var b = boxOfFiber(f)
        if (b) {
          boxes[id] = b
          any = true
        }
      }
    })
    if (any) send({ type: 'boxes', boxes: boxes })
  }
  var reboxRAF = 0
  function onScrollResize() {
    if (reboxRAF) return
    reboxRAF = requestAnimationFrame(function () {
      reboxRAF = 0
      try {
        // Selection (and drill boxes) follow the content. The HOVER box, by
        // contrast, is tied to the cursor — once content scrolls under a still
        // cursor it's stale, so clear it. It stays cleared because scroll-induced
        // mousemoves (same cursor coords) are ignored in onMouseMove below; only
        // a real cursor move re-establishes the hover.
        reboxTracked()
        send({ type: 'hover', box: null })
      } catch (e) {}
    })
  }
  // capture:true so scrolls inside nested scroll containers are caught too.
  window.addEventListener('scroll', onScrollResize, true)
  window.addEventListener('resize', onScrollResize)

  // ---- Swipe (pager) --------------------------------------------------------
  // When the debugger is in full-screen pager mode, a two-finger horizontal
  // trackpad swipe over the preview moves between the preview and styles
  // "windows". The iframe consumes wheel events, so we detect it here and post
  // the intent to the parent. Disabled otherwise so the app scrolls normally.
  var pagerOn = false
  var swipeAccum = 0
  var swipeTimer = 0
  function onWheelSwipe(e) {
    if (!pagerOn) return
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    if (Math.abs(e.deltaX) < 6) return
    swipeAccum += e.deltaX
    clearTimeout(swipeTimer)
    swipeTimer = setTimeout(function () {
      swipeAccum = 0
    }, 180)
    if (Math.abs(swipeAccum) > 80) {
      var dir = swipeAccum > 0 ? 1 : -1
      swipeAccum = 0
      try {
        e.preventDefault()
      } catch (err) {}
      send({ type: 'swipe', dir: dir })
    }
  }
  window.addEventListener('wheel', onWheelSwipe, { passive: false, capture: true })

  // ---- Live preview (CSSOM) -------------------------------------------------
  function findStyleRule(selectorText, mediaText) {
    var sheets = document.styleSheets
    function norm(m) {
      return (m || '').replace(/\s+/g, ' ').trim()
    }
    function search(rules, media) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i]
        if (rule.type === 1 && rule.selectorText === selectorText) {
          if (norm(media) === norm(mediaText)) return rule
        } else if (rule.type === 4) {
          var r = search(rule.cssRules, rule.media && rule.media.mediaText)
          if (r) return r
        } else if (rule.type === 12) {
          var r2 = search(rule.cssRules, media)
          if (r2) return r2
        }
      }
      return null
    }
    for (var s = 0; s < sheets.length; s++) {
      var rules
      try {
        rules = sheets[s].cssRules
      } catch (e) {
        continue
      }
      var hit = search(rules, null)
      if (hit) return hit
    }
    return null
  }
  function previewRule(selectorText, mediaText, prop, value) {
    var rule = findStyleRule(selectorText, mediaText)
    try {
      if (rule) {
        if (value === '' || value == null) rule.style.removeProperty(prop)
        else rule.style.setProperty(prop, value)
        return true
      }
    } catch (e) {}
    if (currentEl) {
      try {
        if (value === '' || value == null) currentEl.style.removeProperty(prop)
        else currentEl.style.setProperty(prop, value)
        return true
      } catch (e) {}
    }
    return false
  }

  // ---- Color parsing / luminance (shared by a11y + tokens) ------------------
  // Parse a CSS color string into {r,g,b,a} 0..255 / 0..1, or null if it can't
  // be resolved. getComputedStyle already returns rgb()/rgba() for used colors,
  // so we mainly parse that; a canvas fallback handles named/hex tokens.
  var _cctx = null
  function toRGBA(str) {
    if (!str) return null
    str = String(str).trim()
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    var m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/i)
    if (m) {
      var a = 1
      if (m[4] != null) a = m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      return { r: +m[1], g: +m[2], b: +m[3], a: a }
    }
    // Fallback: let the browser normalize named/hex/hsl via a canvas.
    try {
      if (!_cctx) _cctx = document.createElement('canvas').getContext('2d')
      _cctx.clearRect(0, 0, 1, 1)
      _cctx.fillStyle = '#000'
      _cctx.fillStyle = str
      var norm = _cctx.fillStyle // '#rrggbb' or 'rgba(...)'
      if (norm[0] === '#') {
        var hex = norm.slice(1)
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
        return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 }
      }
      return toRGBA(norm)
    } catch (e) {
      return null
    }
  }
  function relLuminance(c) {
    function chan(v) {
      v = v / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
  }
  function contrastRatio(fg, bg) {
    var l1 = relLuminance(fg)
    var l2 = relLuminance(bg)
    var hi = Math.max(l1, l2)
    var lo = Math.min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }
  // Composite the used text color over the nearest opaque ancestor background.
  function effectiveBg(el) {
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 40) {
      var c = toRGBA(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0.05) return { r: c.r, g: c.g, b: c.b }
      node = node.parentElement
      depth++
    }
    return { r: 255, g: 255, b: 255 } // assume white page background
  }
  function cssPathOf(el) {
    try {
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id
      var parts = []
      var node = el
      var depth = 0
      while (node && node.nodeType === 1 && depth < 4) {
        var seg = node.tagName.toLowerCase()
        var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
        if (cls.length) seg += '.' + cls.join('.')
        parts.unshift(seg)
        if (node.id) { parts[0] = node.tagName.toLowerCase() + '#' + node.id; break }
        node = node.parentElement
        depth++
      }
      return parts.join(' > ')
    } catch (e) {
      return el.tagName ? el.tagName.toLowerCase() : '?'
    }
  }
  function boxOfEl(el) {
    try {
      var r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    } catch (e) {
      return null
    }
  }
  function isVisible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  function directText(el) {
    var s = ''
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3) s += n.nodeValue
    }
    return s.trim()
  }
  function accessibleName(el) {
    var aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    var labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      var ref = document.getElementById(labelledby.split(/\s+/)[0])
      if (ref && ref.textContent.trim()) return ref.textContent.trim()
    }
    if (el.getAttribute('title') && el.getAttribute('title').trim()) return el.getAttribute('title').trim()
    var txt = (el.textContent || '').trim()
    if (txt) return txt
    // an <img alt> inside counts as the name
    var img = el.querySelector && el.querySelector('img[alt]')
    if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim()
    var valEl = el
    if (valEl.value && String(valEl.value).trim()) return String(valEl.value).trim()
    return ''
  }

  // ---- Accessibility audit --------------------------------------------------
  function auditA11y() {
    var issues = []
    var CAP = 200
    function push(sev, rule, message, el) {
      if (issues.length >= CAP) return
      issues.push({ severity: sev, rule: rule, message: message, selector: cssPathOf(el), box: boxOfEl(el) })
    }
    try {
      var all = document.body ? document.body.querySelectorAll('*') : []
      for (var i = 0; i < all.length && issues.length < CAP; i++) {
        var el = all[i]
        var tag = el.tagName.toLowerCase()
        var cs
        try { cs = getComputedStyle(el) } catch (e) { continue }
        var vis = isVisible(el, cs)

        // Rule 2: <img> without alt (unless presentational).
        if (tag === 'img') {
          var role = el.getAttribute('role')
          var hasAlt = el.hasAttribute('alt')
          if (!hasAlt && role !== 'presentation' && role !== 'none')
            push('error', 'img-alt', '<img> is missing an alt attribute', el)
        }

        // Rule 3: button / link / role=button with no accessible name.
        var roleAttr = el.getAttribute('role')
        var isBtnLike = tag === 'button' || roleAttr === 'button' || (tag === 'a' && el.hasAttribute('href'))
        if (isBtnLike && vis) {
          if (!accessibleName(el))
            push('error', 'control-name', '<' + tag + '> has no accessible name (text, aria-label, or title)', el)
        }

        // Rule 4: form control with no label / aria-label.
        if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          var type = (el.getAttribute('type') || '').toLowerCase()
          if (type !== 'hidden' && vis) {
            var labelled =
              (el.getAttribute('aria-label') || '').trim() ||
              el.getAttribute('aria-labelledby') ||
              el.getAttribute('title') ||
              (el.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')) ||
              el.closest('label')
            if (!labelled) push('error', 'form-label', '<' + tag + '> has no associated <label> or aria-label', el)
          }
        }

        // Rule 5: tap target < 24x24 for interactive elements.
        if (vis && (isBtnLike || tag === 'input' || tag === 'select' || tag === 'textarea')) {
          var r = el.getBoundingClientRect()
          if ((r.width > 0 && r.width < 24) || (r.height > 0 && r.height < 24))
            push('warn', 'tap-target', 'Interactive target is ' + Math.round(r.width) + '×' + Math.round(r.height) + ' (< 24×24 CSS px)', el)
        }

        // Rule 1: text contrast below WCAG AA. Only elements that render their
        // own visible text (direct non-empty text node) — skip containers.
        if (vis) {
          var text = directText(el)
          if (text) {
            var fg = toRGBA(cs.color)
            if (fg && fg.a > 0.1) {
              var bg = effectiveBg(el)
              var ratio = contrastRatio(fg, bg)
              var fontSize = parseFloat(cs.fontSize) || 16
              var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700
              var large = fontSize >= 24 || (fontSize >= 18.66 && bold)
              var min = large ? 3 : 4.5
              if (ratio < min)
                push('warn', 'contrast', 'Text contrast ' + ratio.toFixed(2) + ':1 is below AA (' + min + ':1' + (large ? ', large text' : '') + ')', el)
            }
          }
        }
      }
    } catch (e) {}
    return { issues: issues }
  }

  // ---- Design-token conformance ---------------------------------------------
  // Read every --* custom property resolved on :root into a resolved-color →
  // token-name map, then flag used colors on visible elements that match no
  // token. Pure CSSOM; normalizes everything to rgb via toRGBA.
  function rgbKey(c) {
    return c ? c.r + ',' + c.g + ',' + c.b : null
  }
  function readTokens() {
    var map = {} // 'r,g,b' -> tokenName
    var count = 0
    try {
      var root = document.documentElement
      var cs = getComputedStyle(root)
      // Custom props aren't enumerable via getComputedStyle length in all
      // engines; scrape the authored :root rules for names, then resolve each.
      var names = {}
      var sheets = document.styleSheets
      for (var s = 0; s < sheets.length; s++) {
        var rules
        try { rules = sheets[s].cssRules } catch (e) { continue }
        if (!rules) continue
        for (var i = 0; i < rules.length; i++) {
          var rule = rules[i]
          if (rule.type !== 1 || !rule.style) continue
          for (var j = 0; j < rule.style.length; j++) {
            var prop = rule.style[j]
            if (prop.indexOf('--') === 0) names[prop] = 1
          }
        }
      }
      var keys = Object.keys(names)
      for (var k = 0; k < keys.length; k++) {
        var name = keys[k]
        var raw = cs.getPropertyValue(name).trim()
        if (!raw) continue
        count++
        var col = toRGBA(raw)
        if (col && col.a > 0.05) {
          var key = rgbKey(col)
          if (key && !map[key]) map[key] = name
        }
      }
    } catch (e) {}
    return { map: map, count: count }
  }
  function auditTokens() {
    var offenders = []
    var CAP = 200
    var t = readTokens()
    var map = t.map
    try {
      var all = document.body ? document.body.querySelectorAll('*') : []
      var PROPS = ['color', 'background-color', 'border-color']
      for (var i = 0; i < all.length && offenders.length < CAP; i++) {
        var el = all[i]
        var cs
        try { cs = getComputedStyle(el) } catch (e) { continue }
        if (!isVisible(el, cs)) continue
        for (var p = 0; p < PROPS.length; p++) {
          if (offenders.length >= CAP) break
          var used = cs.getPropertyValue(PROPS[p])
          var col = toRGBA(used)
          if (!col || col.a < 0.05) continue // skip transparent
          // border-color only matters if there's an actual border on that side.
          if (PROPS[p] === 'border-color') {
            var bw = parseFloat(cs.getPropertyValue('border-top-width')) +
              parseFloat(cs.getPropertyValue('border-right-width')) +
              parseFloat(cs.getPropertyValue('border-bottom-width')) +
              parseFloat(cs.getPropertyValue('border-left-width'))
            if (!bw) continue
          }
          var key = rgbKey(col)
          if (map[key]) continue // matches a token → conformant
          offenders.push({
            property: PROPS[p],
            usedValue: 'rgb(' + col.r + ', ' + col.g + ', ' + col.b + ')',
            nearestToken: nearestToken(col, map),
            selector: cssPathOf(el),
            box: boxOfEl(el),
          })
        }
      }
    } catch (e) {}
    return { tokens: t.count, offenders: offenders }
  }
  function nearestToken(col, map) {
    var best = null
    var bestD = Infinity
    var keys = Object.keys(map)
    for (var i = 0; i < keys.length; i++) {
      var parts = keys[i].split(',')
      var dr = col.r - +parts[0], dg = col.g - +parts[1], db = col.b - +parts[2]
      var d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; best = map[keys[i]] }
    }
    // Only suggest if reasonably close (~ within 60 units per channel avg).
    return bestD <= 10000 ? best : null
  }

  // ---- Interaction modes ----------------------------------------------------
  var mode = 'interact' // 'interact' | 'pick' | 'theater'
  var hoverRAF = 0

  function onMouseMove(e) {
    if (mode !== 'pick') return
    // Ignore scroll-induced mousemoves: when content scrolls under a still
    // cursor the browser fires mousemove with UNCHANGED coords. Treating those
    // as real would re-show the hover box mid-scroll. Only act on actual moves.
    if (e.clientX === lastMoveX && e.clientY === lastMoveY) return
    lastMoveX = e.clientX
    lastMoveY = e.clientY
    if (hoverRAF) return
    var x = e.clientX,
      y = e.clientY
    hoverRAF = requestAnimationFrame(function () {
      hoverRAF = 0
      try {
        var el = document.elementFromPoint(x, y)
        var f = el && nearestComponentFiber(getFiberFromDom(el))
        if (!f) return
        send({ type: 'hover', name: getComponentName(f), box: boxOfFiber(f), nameChain: ancestorNames(f) })
      } catch (err) {}
    })
  }
  function onClick(e) {
    if (mode !== 'pick') return
    e.preventDefault()
    e.stopPropagation()
    try {
      var el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el) return
      var f = nearestComponentFiber(getFiberFromDom(el))
      if (!f) return
      send({ type: 'selected', detail: describeFiber(f, el) })
    } catch (err) {}
  }
  function onContextMenu(e) {
    if (mode !== 'pick') return
    e.preventDefault()
    e.stopPropagation()
    try {
      var el = document.elementFromPoint(e.clientX, e.clientY)
      var f = el && nearestComponentFiber(getFiberFromDom(el))
      if (f) send({ type: 'theater', detail: describeFiber(f) })
    } catch (err) {}
  }

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('contextmenu', onContextMenu, true)

  // ---- Navigation detection (SPA route changes) -----------------------------
  ;(function patchHistory() {
    function fire() {
      try {
        tracked.clear() // paths change across routes; drop stale boxes
        send({ type: 'navigated', url: location.href })
      } catch (e) {}
    }
    try {
      var ps = history.pushState,
        rs = history.replaceState
      history.pushState = function () {
        var r = ps.apply(this, arguments)
        setTimeout(fire, 40)
        return r
      }
      history.replaceState = function () {
        var r = rs.apply(this, arguments)
        setTimeout(fire, 40)
        return r
      }
      window.addEventListener('popstate', function () {
        setTimeout(fire, 40)
      })
    } catch (e) {}
  })()

  // ---- Message bridge -------------------------------------------------------
  function send(msg) {
    msg.__fedbg = 1
    try {
      window.parent.postMessage(msg, PARENT_ORIGIN === '*' ? '*' : PARENT_ORIGIN)
    } catch (e) {}
  }

  function describeById(id, preferEl) {
    var f = fiberByPath(id)
    return f ? describeFiber(f, preferEl) : null
  }

  // ---- Live Watch: re-emit the inspected component on each React commit -----
  // The DevTools commit hook calls scheduleWatch(); a short throttle coalesces
  // render bursts, then we re-describe the watched component (keepTracked, so we
  // don't disturb selection/theater state) and post an inspectUpdate. Fully
  // guarded — the agent must never throw into the page during React's commit.
  function scheduleWatch() {
    if (watchTimer || !watchId) return
    watchTimer = setTimeout(function () {
      watchTimer = null
      emitWatchUpdate()
    }, 120)
  }
  function emitWatchUpdate() {
    try {
      if (!watchId) return
      var f = fiberByPath(watchId)
      if (!f) return
      send({ type: 'inspectUpdate', detail: describeFiber(f, null, { keepTracked: true }) })
    } catch (e) {}
  }

  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || d.__fedbg !== 1 || !d.cmd) return
    try {
      switch (d.cmd) {
        case 'hello':
          send({ type: 'ready', mode: mode, url: location.href })
          break
        case 'ping':
          send({ type: 'pong', mode: mode })
          break
        case 'setMode':
          mode = d.mode || 'interact'
          send({ type: 'mode', mode: mode })
          break
        case 'setPager':
          pagerOn = !!d.on
          break
        case 'getTree':
          send({ type: 'tree', nodes: buildTree(d.max), url: location.href })
          break
        case 'select': {
          var det = describeById(d.id)
          if (det) send({ type: 'selected', detail: det })
          break
        }
        case 'selectRelative': {
          var base = fiberByPath(d.id)
          if (!base) break
          var rel = relativeFiber(base, d.dir)
          if (rel) send({ type: 'selected', detail: describeFiber(rel) })
          break
        }
        case 'theater': {
          var dt = describeById(d.id)
          if (dt) send({ type: 'theater', detail: dt })
          break
        }
        case 'getChildren': {
          var fp = fiberByPath(d.id)
          if (!fp) break
          var kids = firstLevelChildComponents(fp).map(function (k) {
            return { id: pathId(k), name: getComponentName(k), box: boxOfFiber(k) }
          })
          kids.forEach(function (k) {
            tracked.add(k.id)
          })
          send({ type: 'children', parentId: d.id, items: kids })
          break
        }
        case 'highlight': {
          var fh = fiberByPath(d.id)
          send({ type: 'hover', name: fh ? getComponentName(fh) : '', box: fh ? boxOfFiber(fh) : null })
          break
        }
        case 'rebox': {
          var boxes = {}
          ;(d.ids || []).forEach(function (id) {
            var fr = fiberByPath(id)
            if (fr) boxes[id] = boxOfFiber(fr)
          })
          send({ type: 'boxes', boxes: boxes })
          break
        }
        case 'scrollTo': {
          var fs = fiberByPath(d.id)
          var els = fs && topHostElements(fs)
          if (els && els[0]) {
            els[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
            // Boxes are viewport-relative, so a smooth scroll leaves the UI's
            // drawn selection box at the old position. Re-emit this fiber's box
            // for ~700ms so the highlight tracks the component into view (App
            // updates selection.box from 'boxes'). The frame runs outside the
            // handler try/catch — wrap it so it never throws into the page.
            var revealStart = 0
            var revealTick = function (ts) {
              try {
                if (!revealStart) revealStart = ts
                var rbx = {}
                rbx[d.id] = boxOfFiber(fs)
                send({ type: 'boxes', boxes: rbx })
                if (ts - revealStart < 700) requestAnimationFrame(revealTick)
              } catch (e) {}
            }
            requestAnimationFrame(revealTick)
          }
          break
        }
        case 'previewRule':
          previewRule(d.selectorText, d.media, d.prop, d.value)
          break
        case 'navigate': {
          // Full, reliable navigation to a merkle route. A full reload is fine:
          // the devMock fixture + HMR re-init cleanly and the agent re-scans on
          // load. Declare every var — strict mode swallows undeclared assigns.
          var url = d.url
          if (url) window.location.assign(url)
          break
        }
        case 'auditA11y':
          send({ type: 'a11y', result: auditA11y() })
          break
        case 'auditTokens':
          send({ type: 'tokens', result: auditTokens() })
          break
        case 'getRoutes':
          send({ type: 'routes', detail: detectRoutes(), url: location.href })
          break
      }
    } catch (err) {
      send({ type: 'error', error: String((err && err.message) || err), cmd: d.cmd })
    }
  })

  function announce() {
    send({ type: 'ready', mode: mode, url: location.href })
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(announce, 0)
  else window.addEventListener('DOMContentLoaded', announce)
  window.addEventListener('load', announce)
})()
