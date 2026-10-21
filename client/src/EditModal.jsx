import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { FolderSelect, TagsField, tagsToText, textToTags } from './TagsInput.jsx';
import { RoutesField, routesToRows, rowsToRoutes } from './RoutesField.jsx';

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in the viewer's local time.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Edits the destination, expiry, click limit, tags, folder and routing rules. Only fields that actually changed are sent,
// so saving never re-validates an expiry that has since passed or touches the password.
export default function EditModal({ link, folders, onClose, onSaved }) {
  const ref = useRef(null);
  const initial = {
    url: link.targetUrl,
    expires: toLocalInput(link.expiresAt),
    maxClicks: link.maxClicks == null ? '' : String(link.maxClicks),
    tags: tagsToText(link.tags),
    folderId: link.folderId ?? '',
    routes: routesToRows(link.routes),
  };
  const [url, setUrl] = useState(initial.url);
  const [expires, setExpires] = useState(initial.expires);
  const [maxClicks, setMaxClicks] = useState(initial.maxClicks);
  const [tags, setTags] = useState(initial.tags);
  const [folderId, setFolderId] = useState(initial.folderId);
  const [routes, setRoutes] = useState(initial.routes);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function submit(e) {
    e.preventDefault();
    const body = {};
    if (url !== initial.url) body.url = url;
    if (expires !== initial.expires) body.expiresAt = expires ? new Date(expires).toISOString() : null;
    if (maxClicks !== initial.maxClicks) body.maxClicks = maxClicks ? Number(maxClicks) : null;
    if (tags !== initial.tags) body.tags = textToTags(tags);
    if (folderId !== initial.folderId) body.folderId = folderId || null;
    // Compared as the payload that would be sent, so untouched rules are not re-sent
    if (JSON.stringify(rowsToRoutes(routes)) !== JSON.stringify(rowsToRoutes(initial.routes))) body.routes = rowsToRoutes(routes);
    if (Object.keys(body).length === 0) return ref.current.close();

    setBusy(true);
    setError('');
    try {
      await api.updateLink(link.id, body);
      onSaved();
      ref.current.close();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="qr-dialog edit-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <form onSubmit={submit}>
        <h2>Edit /{link.slug}</h2>
        <label>
          Destination URL
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label>
          Expires
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          <small className="muted">Leave empty for no expiry.</small>
        </label>
        <label>
          Click limit
          <input type="number" min="1" max="1000000" step="1" inputMode="numeric" value={maxClicks} onChange={(e) => setMaxClicks(e.target.value)} placeholder="Unlimited" />
          <small className="muted">
            {link.maxClicks != null ? `${link.usedClicks} of ${link.maxClicks} visits used. ` : ''}
            Empty = unlimited, 1 = one-time. Raising the limit keeps the visits already used.
          </small>
        </label>
        <TagsField value={tags} onChange={setTags} />
        <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
        <RoutesField value={routes} onChange={setRoutes} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="qr-actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button className="btn" type="button" onClick={() => ref.current.close()}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
