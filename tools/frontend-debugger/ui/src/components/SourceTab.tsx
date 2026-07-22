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

// A vibrant Burrow-Dark Monaco theme mirroring the workbench Xcode-inspired
// palette. Stock 'vs-dark' paints strings a muddy orange (#CE9178) and keeps the
// rest low-saturation, so code reads flat; these tokens are brighter/saturated so
// syntax jumps out (magenta keywords, salmon strings, gold numbers, cyan types).
// Monaco's Monarch TS tokenizer is coarse (no per-function token), so we colour
// the token kinds it actually emits.
function defineBurrowTheme(monaco: any) {
  monaco.editor.defineTheme('burrow-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'F2F2F4' },
      { token: 'comment', foreground: '79858F' },
      { token: 'string', foreground: 'FF6B5E' },
      { token: 'string.escape', foreground: 'FF9182' },
      { token: 'regexp', foreground: 'FF9182' },
      { token: 'number', foreground: 'E7D07A' },
      { token: 'keyword', foreground: 'FF6FB5' },
      { token: 'type', foreground: '6FDCFF' },
      { token: 'type.identifier', foreground: '6FDCFF' },
      { token: 'identifier', foreground: 'F2F2F4' },
      { token: 'delimiter', foreground: 'C8C8CC' },
      { token: 'delimiter.bracket', foreground: 'C8C8CC' },
      { token: 'tag', foreground: 'FF6FB5' },
      { token: 'attribute.name', foreground: 'D3985E' },
      { token: 'attribute.value', foreground: 'FF6B5E' },
      { token: 'constant', foreground: 'DDB7FF' },
      // CSS
      { token: 'attribute.value.css', foreground: 'E7D07A' },
      { token: 'attribute.value.number.css', foreground: 'E7D07A' },
      { token: 'attribute.value.unit.css', foreground: 'E7D07A' },
      { token: 'keyword.css', foreground: 'FF6FB5' },
    ],
    colors: {
      'editor.background': '#25262D',
      'editor.foreground': '#F2F2F4',
      'editorLineNumber.foreground': '#6E6F76',
      'editorLineNumber.activeForeground': '#F2F2F4',
      'editorCursor.foreground': '#F2F2F4',
      'editor.selectionBackground': '#3F638B80',
      'editor.lineHighlightBackground': '#2E313A',
      'editorIndentGuide.background': '#3A3C44',
      'editorIndentGuide.activeBackground': '#5A5C64',
      'editorBracketMatch.background': '#41444C',
      'editorBracketMatch.border': '#6A6D76',
    },
  })
}

// Configure Monaco's TS/JS workers BEFORE the editor mounts: enable JSX (fixes
// "Cannot use JSX unless the '--jsx' flag is provided" / 17004) and silence
// semantic diagnostics — we're viewing files without the project's full type
// graph, so module/type resolution errors would be pure noise. Also registers the
// Burrow-Dark theme so the editor never flashes stock 'vs-dark'.
function configureMonaco(monaco: any) {
  defineBurrowTheme(monaco)
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
            theme="burrow-dark"
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
              // Heavier code font so syntax reads bolder (matches the workbench SF
              // Mono). fontWeight applies to normal tokens; 600 = semibold.
              fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
              fontWeight: '600',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              // Thin gutter: fold chevron tucked right against the line number
              // ("212 ›"). Drop the unused glyph margin and the decorations gap,
              // and cap the line-number column so nothing is wasted.
              glyphMargin: false,
              lineDecorationsWidth: 0,
              lineNumbersMinChars: 2,
              folding: true,
              showFoldingControls: 'always',
              foldingHighlight: false,
            }}
          />
        ) : (
          <div className="empty-tab">No source file resolved for this component.</div>
        )}
      </div>
    </div>
  )
}
