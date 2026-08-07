import { useStore } from '../store'
import type { RuleProv } from '../styleModel'

// The little file:line badge on every editor row / cascade rule — colored by
// origin stratum, click jumps to the defining line (Burrow editor when
// embedded, Monaco Source tab standalone).
export function ProvenanceChip({ prov }: { prov: RuleProv | null }) {
  const openInSource = useStore((s) => s.openInSource)
  if (!prov || !prov.found || !prov.file)
    return (
      <span className="prov-chip none" title="No authored rule — value comes from the computed style">
        computed
      </span>
    )
  const short = prov.file.split('/').pop()
  return (
    <button
      className={'prov-chip ' + prov.origin}
      title={`${prov.origin} · ${prov.file}:${prov.line ?? ''} — open in editor`}
      onClick={() => openInSource(prov.file!, prov.line || 1)}
    >
      {short}
      {prov.line ? ':' + prov.line : ''}
    </button>
  )
}
