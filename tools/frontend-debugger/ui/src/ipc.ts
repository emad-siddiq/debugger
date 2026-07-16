type Handler = (msg: any) => void

let frame: Window | null = null
const handlers = new Set<Handler>()

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data
  if (!d || d.__fedbg !== 1 || !d.type) return
  handlers.forEach((h) => h(d))
})

export const ipc = {
  setFrame(w: Window | null) {
    frame = w
  },
  send(cmd: string, extra: Record<string, unknown> = {}) {
    if (!frame) return
    frame.postMessage({ __fedbg: 1, cmd, ...extra }, '*')
  },
  // Jump the embedded target to a merkle route (full navigation; the agent
  // re-scans the tree on load — see the `navigate` case in agent/agent.js).
  navigate(url: string) {
    this.send('navigate', { url })
  },
  on(h: Handler): () => void {
    handlers.add(h)
    return () => {
      handlers.delete(h)
    }
  },
}

// --- REST helpers to the debugger backend ---------------------------------
export async function apiGet<T = any>(path: string): Promise<T> {
  const r = await fetch('/api' + path)
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
  return r.json()
}

export async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText)
  return r.json()
}
