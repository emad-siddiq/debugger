// Self-host Monaco so the Source tab never waits on a CDN fetch.
//
// `@monaco-editor/react` defaults to loading the whole editor from jsdelivr at
// runtime the first time it mounts — a multi-MB round trip that is slow (and can
// stall entirely) inside the dockerized instance, which is exactly the "Source
// takes forever to load" symptom. Here we bundle Monaco locally and wire up its
// language workers through Vite `?worker` imports, so the first open is instant
// and works offline. This module is imported for its side effects (before the
// Editor mounts) — keep the import at the top of SourceTab.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

// Point @monaco-editor/react at the locally-bundled Monaco instead of the CDN.
loader.config({ monaco })
