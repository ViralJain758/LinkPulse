import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const TEMPLATE = `url,slug,tags,folder,expires_at,password,max_clicks
https://example.com/spring-sale,spring-sale,launch|email,Campaigns,,,
https://example.com/docs,,docs,,2027-12-31T23:59:00Z,,
`;

// Spreadsheet apps run text starting with = + - @ as a formula, so prefix those cells
const safeCell = (v) => {
  const s = String(v ?? '');
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
};

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const resultsCsv = (results) =>
  ['row,status,short_url,destination,error', ...results.map((r) =>
    [r.row, r.status, r.link?.shortUrl, r.link?.targetUrl ?? r.url, r.error].map(safeCell).join(',')
  )].join('\n');

// Step 1: pick a CSV, which is checked on the server without creating anything.
// Step 2: confirm, then valid rows are created and problems are listed by row number.
export default function ImportModal({ folders, onClose, onImported }) {
  const ref = useRef(null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [folder, setFolder] = useState('');
  const [tags, setTags] = useState('');
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const options = (extra) => ({ folder, tags, ...extra });

  async function check(text, opts = options()) {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      setPreview(await api.bulkCreate(text, { ...opts, dryRun: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) return setError('That file is larger than 1 MB. Split it into several imports.');
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    check(text);
  }

  // Changing the default folder/tags changes what the check reports (e.g. new folders)
  const recheck = (next) => csv && check(csv, options(next));

  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await api.bulkCreate(csv, options());
      setDone(result);
      setPreview(null);
      if (result.created > 0) onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const problems = (done || preview)?.results.filter((r) => r.status === 'error') ?? [];

  return (
    <dialog ref={ref} className="qr-dialog edit-dialog import-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <h2>Import links from CSV</h2>

      {!done && (
        <>
          <p className="muted">
            One link per row. Needs a header row with a <code>url</code> column; optional columns:{' '}
            <code>slug</code>, <code>tags</code> (separate with |), <code>folder</code>, <code>expires_at</code>, <code>password</code>, <code>max_clicks</code>. Up to 500 rows.{' '}
            <button type="button" className="link-btn" onClick={() => download('linkpulse-template.csv', TEMPLATE)}>Download a template</button>
          </p>
          <label>
            CSV file
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          </label>
          <label>
            Folder for rows without one
            <select value={folder} onChange={(e) => { setFolder(e.target.value); recheck({ folder: e.target.value }); }}>
              <option value="">No folder</option>
              {(folders || []).map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
            </select>
          </label>
          <label>
            Tags added to every row (optional)
            <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => recheck({ tags })} placeholder="import-oct" />
          </label>
        </>
      )}

      {busy && <p className="muted">Working…</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {preview && !busy && (
        <div className="import-summary">
          <p>
            <strong>{preview.valid}</strong> of {preview.total} rows in {fileName || 'the file'} are ready
            {preview.failed > 0 && <>, <strong className="bad">{preview.failed}</strong> have problems and will be skipped</>}.
            {preview.newFolders.length > 0 && <> New folders: {preview.newFolders.join(', ')}.</>}
          </p>
          {preview.ignoredColumns.length > 0 && <p className="muted">Ignored columns: {preview.ignoredColumns.join(', ')}</p>}
        </div>
      )}

      {done && (
        <div className="import-summary">
          <p>
            Created <strong>{done.created}</strong> {done.created === 1 ? 'link' : 'links'}
            {done.failed > 0 && <>, <strong className="bad">{done.failed}</strong> skipped</>}.
          </p>
          <button type="button" className="link-btn" onClick={() => download('linkpulse-import-results.csv', resultsCsv(done.results))}>
            Download results (with short URLs)
          </button>
        </div>
      )}

      {problems.length > 0 && (
        <div className="table-wrap problems">
          <table>
            <thead><tr><th>Row</th><th>Destination</th><th>Problem</th></tr></thead>
            <tbody>
              {problems.slice(0, 50).map((r) => (
                <tr key={r.row}><td>{r.row}</td><td className="target-cell">{r.url || '(empty)'}</td><td>{r.error}</td></tr>
              ))}
            </tbody>
          </table>
          {problems.length > 50 && <small className="muted">Showing the first 50 of {problems.length} problems.</small>}
        </div>
      )}

      <div className="qr-actions">
        {!done && (
          <button className="btn primary" type="button" disabled={busy || !preview || preview.valid === 0} onClick={create}>
            {preview?.valid ? `Create ${preview.valid} ${preview.valid === 1 ? 'link' : 'links'}` : 'Create links'}
          </button>
        )}
        <button className="btn" type="button" onClick={() => ref.current.close()}>{done ? 'Close' : 'Cancel'}</button>
      </div>
    </dialog>
  );
}
