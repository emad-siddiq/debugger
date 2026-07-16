import { useEffect, useRef, useState } from 'react'
import '../monacoSetup' // self-host Monaco (no CDN fetch) — must load before <Editor>
import Editor from '@monaco-editor/react'
import { useStore } from '../store'
import { apiGet, apiPost, ipc } from '../ipc'
import { embedded, openInBurrow } from '../host'

function langOf(file: string): string {
  if (file.endsWith('.css')) return 'css'
  if (file.endsWith('.json')) return 'json'
  return 'typescript' // .tsx/.ts/.jsx — Monaco's TS mode handles JSX
}

// Configure Monaco's TS/JS workers BEFORE the editor mounts: enable JSX (fixes
// "Cannot use JSX unless the '--jsx' flag is provided" / 17004) and silence
// semantic diagnostics — we're viewing files without the project's full type
// graph, so module/type resolution errors would be pure noise.
function configureMonaco(monaco: any) {
  const ts = monaco.languages.typescript
  const opts = {
    jsx: ts.JsxEmit.React,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowJs: true,
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    isolatedModules: true,
    noEmit: true,
  }
  ts.typescriptDefaults.setCompilerOptions(opts)
  ts.javascriptDefaults.setCompilerOptions(opts)
  const diag = { noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true }
  ts.typescriptDefaults.setDiagnosticsOptions(diag)
  ts.javascriptDefaults.setDiagnosticsOptions(diag)
}

export function SourceTab() {
  const selection = useStore((s) => s.selection)
  const openSource = useStore((s) => s.openSource)
  const toast = useStore((s) => s.toast)
  const [file, setFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const pendingLine = useRef(0)

  const reveal = () => {
    const ed = editorRef.current
    const line = pendingLine.current
    if (ed && line > 0) {
      try {
        ed.revealLineInCenter(line)
        ed.setPosition({ lineNumber: line, column: 1 })
        if (monacoRef.current)
          ed.deltaDecorations(
            [],
            [{ range: new monacoRef.current.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'mono-hl' } }],
          )
      } catch {}
    }
  }

  const load = async (f: string, line: number) => {
    try {
      const res = await apiGet(`/source?file=${encodeURIComponent(f)}`)
      setFile(f)
      setContent(res.content)
      setSavedContent(res.content)
      setDirty(false)
      pendingLine.current = line || 0
      reveal()
    } catch (err: any) {
      toast('error', 'load failed: ' + (err.message || err))
    }
  }

  useEffect(() => {
    if (dirty) return
    if (selection?.source?.file) load(selection.source.file, selection.source.line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.id])

  useEffect(() => {
    if (openSource) load(openSource.file, openSource.line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSource?.nonce])

  const save = async () => {
    if (!file) return
    try {
      await apiPost('/source', { file, content })
      setSavedContent(content)
      setDirty(false)
      toast('ok', 'saved → ' + file.split('/').pop() + ' (Fast Refresh)')
      setTimeout(() => selection && ipc.send('select', { id: selection.id }), 400)
    } catch (err: any) {
      toast('error', 'save failed: ' + (err.message || err))
    }
  }

  const revert = () => {
    setContent(savedContent)
    setDirty(false)
    toast('info', 'reverted unsaved source edits')
  }

  if (!file && !selection) return <div className="empty-tab">Select a component to view its source.</div>

  return (
    <div className="source">
      <div className="src-bar">
        <span className="src-file" title={file || ''}>
          {file || '—'}
          {dirty && <span className="dirty-dot" title="unsaved">●</span>}
        </span>
        {embedded && file && (
          <button
            className="btn"
            title="Open this file in the Burrow editor"
            onClick={() => openInBurrow(file, pendingLine.current || 1)}
          >
            ↗ Open in Burrow
          </button>
        )}
        <button className="btn" disabled={!dirty} onClick={revert} title="Reload from disk (drop unsaved edits)">
          ↩ Revert
        </button>
        <button className="btn primary" disabled={!dirty} onClick={save}>
          💾 Save
        </button>
      </div>
      <div className="editor-wrap">
        {file ? (
          <Editor
            height="100%"
            theme="vs-dark"
            path={file}
            language={langOf(file)}
            loading={<div className="empty-tab">Loading editor…</div>}
            beforeMount={configureMonaco}
            value={content}
            onChange={(v) => {
              setContent(v ?? '')
              setDirty((v ?? '') !== savedContent)
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              monacoRef.current = monaco
              reveal()
            }}
            options={{
              fontSize: 12,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />
        ) : (
          <div className="empty-tab">No source file resolved for this component.</div>
        )}
      </div>
    </div>
  )
}
