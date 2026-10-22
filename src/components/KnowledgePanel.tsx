import { useEffect, useState } from 'react';
import type { KnowledgeSummary, KnowledgeContext } from '../../shared/protocol';
import { useT } from '../i18n';

export function KnowledgePanel({ onClose, editable, onRequestEdit }: { onClose: () => void; editable: boolean; onRequestEdit: () => Promise<boolean> }) {
  const t = useT().knowledge;
  const [library, setLibrary] = useState<KnowledgeSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<{ name: string; code: string }[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<KnowledgeContext | null>(null);

  useEffect(() => {
    void window.mc.listKnowledge().then(setLibrary).catch(() => setError(t.loadError));
  }, [t.loadError]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); } catch { setError(t.loadError); }
    finally { setBusy(false); }
  }

  return (
    <section className="settings knowledge-panel" aria-label={t.title}>
      <div className="settings-section">📚 {t.title}</div>
      <p className="settings-hint">{t.intro}</p>
      <p className="settings-hint">{t.formats}</p>
      <p className="settings-hint">{t.privacy}</p>
      <p className="settings-hint">{t.limits}</p>
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={busy || !library || !!library.error} onClick={() => void run(async () => {
          const result = await window.mc.importKnowledge();
          setLibrary(result);
          setFailures(result.failures);
          setPreview(null);
        })}>{busy ? t.busy : t.import}</button>
        <button className="btn" disabled={busy} onClick={onClose}>{t.close}</button>
      </div>
      {error && <p className="settings-warn" role="alert">{error}</p>}
      {library?.error && <p className="settings-warn" role="alert">{t.damaged} <button className="btn btn-sm" onClick={() => void window.mc.openLogsFolder()}>{t.openFolder}</button></p>}
      {failures.map((f, i) => <p className="settings-warn" key={i}>{t.failure(f.name, f.code)}</p>)}
      {library && <p className="settings-hint">{t.count(library.documents.length, library.chars)}</p>}
      {library?.documents.length === 0 && <p className="settings-hint">{t.empty}</p>}
      <div className="knowledge-documents">
        {library?.documents.map((doc) => (
          <div className="knowledge-document" key={doc.id}>
            <span title={doc.name}>{doc.name} <small>({doc.chars.toLocaleString()})</small></span>
            {removing === doc.id ? <>
              <button className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
                setLibrary(await window.mc.removeKnowledge(doc.id));
                setRemoving(null);
                setPreview(null);
              })}>{t.confirmRemove}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setRemoving(null)}>{t.cancel}</button>
            </> : <button className="btn btn-sm" disabled={busy} onClick={() => setRemoving(doc.id)}>{t.remove}</button>}
          </div>
        ))}
      </div>
      <form className="knowledge-search" onSubmit={(e) => {
        e.preventDefault();
        if (busy || !query.trim()) return;
        void run(async () => setPreview(await window.mc.searchKnowledge(query)));
      }}>
        <input disabled={!editable} aria-label={t.searchPlaceholder} placeholder={t.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={2000} />
        {!editable && <button type="button" className="btn" onClick={() => void onRequestEdit()}>✎</button>}
        <button className="btn" disabled={busy || !query.trim() || !library?.documents.length}>{t.search}</button>
      </form>
      <p className="settings-hint">{t.searchHint}</p>
      {preview && (preview.sources.length ? <div className="knowledge-preview">
        {preview.sources.map((s) => <details key={`${s.documentId}-${s.chunkIndex}`}>
          <summary>{s.documentName} · {s.chunkIndex + 1}</summary><pre>{s.text}</pre>
        </details>)}
      </div> : <p className="settings-hint">{t.noMatch}</p>)}
    </section>
  );
}
