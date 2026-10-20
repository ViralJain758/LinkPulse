import { useState } from 'react';
import { api, useFetch } from './api.js';
import { ErrorNote } from './ui.jsx';
import { fmt, fmtDate } from './format.js';
import QrModal from './QrModal.jsx';
import EditModal from './EditModal.jsx';

const isExhausted = (l) => l.maxClicks != null && l.usedClicks >= l.maxClicks;

function status(link) {
  if (!link.isActive) return { key: 'paused', text: 'Paused' };
  if (link.expiresAt && new Date(link.expiresAt) <= new Date()) return { key: 'expired', text: 'Expired' };
  if (isExhausted(link)) return { key: 'used', text: link.maxClicks === 1 ? 'Used' : 'Limit reached' };
  return { key: 'active', text: 'Active' };
}

function CreateForm({ onCreated }) {
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [expires, setExpires] = useState('');
  const [password, setPassword] = useState('');
  const [maxClicks, setMaxClicks] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createLink({
        url,
        ...(slug && { slug }),
        ...(expires && { expiresAt: new Date(expires).toISOString() }),
        ...(password && { password }),
        ...(maxClicks && { maxClicks: Number(maxClicks) }),
      });
      setUrl('');
      setSlug('');
      setExpires('');
      setPassword('');
      setMaxClicks('');
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="create" onSubmit={submit}>
      <label className="grow">
        Destination URL
        <input type="url" placeholder="https://example.com/a-long-page" value={url} onChange={(e) => setUrl(e.target.value)} required />
      </label>
      <label>
        Custom slug (optional)
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="spring-sale" pattern="[A-Za-z0-9_\-]{3,32}" title="3-32 characters: letters, numbers, - or _" />
      </label>
      <label>
        Expires (optional)
        <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <label>
        Password (optional)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} maxLength={72} autoComplete="new-password" placeholder="Visitors must enter it" />
      </label>
      <label>
        Click limit (optional)
        <input type="number" min="1" max="1000000" step="1" inputMode="numeric" value={maxClicks} onChange={(e) => setMaxClicks(e.target.value)} placeholder="Unlimited (1 = one-time)" />
      </label>
      <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create link'}</button>
      {error && <p className="error full" role="alert">{error}</p>}
    </form>
  );
}

export default function LinksPage({ onOpenLink }) {
  const { data: links, error, reload } = useFetch(() => api.links(), [], 30000);
  const [copied, setCopied] = useState(null);
  const [actionError, setActionError] = useState('');
  const [qrLink, setQrLink] = useState(null);
  const [editLink, setEditLink] = useState(null);

  async function copy(link) {
    try {
      await navigator.clipboard.writeText(link.shortUrl);
      setCopied(link.id);
      setTimeout(() => setCopied((c) => (c === link.id ? null : c)), 1500);
    } catch {
      setActionError('Copy failed. Select the link text and copy it manually.');
    }
  }

  async function act(fn) {
    setActionError('');
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const toggle = (l) => act(() => api.updateLink(l.id, { isActive: !l.isActive }));
  const resetCount = (l) => act(() => api.updateLink(l.id, { resetClicks: true }));
  const setPassword = (l) => {
    const next = window.prompt(`New password for /${l.slug} (min 4 characters). Leave empty to remove the password.`);
    if (next === null) return;
    act(() => api.updateLink(l.id, { password: next === '' ? null : next }));
  };
  const remove = (l) => {
    if (window.confirm(`Delete /${l.slug}? Its click history is deleted too and the short link stops working.`)) {
      act(() => api.deleteLink(l.id));
    }
  };

  return (
    <>
      <h1>Links</h1>
      {qrLink && <QrModal link={qrLink} onClose={() => setQrLink(null)} />}
      {editLink && <EditModal link={editLink} onClose={() => setEditLink(null)} onSaved={reload} />}
      <CreateForm onCreated={reload} />
      {actionError && <ErrorNote message={actionError} />}
      {error && !links ? (
        <ErrorNote message={error} onRetry={reload} />
      ) : !links ? (
        <p className="muted">Loading links…</p>
      ) : links.length === 0 ? (
        <div className="empty">
          <strong>No links yet.</strong>
          <p>Paste a destination URL above to create your first short link.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th className="num">Clicks</th>
                <th>Status</th>
                <th>Created</th>
                <th><span className="sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const s = status(l);
                return (
                  <tr key={l.id}>
                    <td>
                      <button className="row-btn stacked" onClick={() => onOpenLink(l)}>
                        <span className="slug">/{l.slug}</span>
                        <span className="target">{l.targetUrl}</span>
                      </button>
                    </td>
                    <td className="num">{fmt(l.clickCount)}</td>
                    <td>
                      <span className={`pill ${s.key}`}>{s.text}</span>
                      {l.hasPassword && <span className="pill tag" title="Visitors must enter a password">Password</span>}
                      {l.maxClicks === 1 && s.key !== 'used' && <span className="pill tag" title="Stops working after one visit">One-time</span>}
                      {l.maxClicks > 1 && (
                        <span className="pill tag" title="Stops working after this many visits">{fmt(l.usedClicks)} / {fmt(l.maxClicks)} visits</span>
                      )}
                      {l.expiresAt && s.key === 'active' && <small className="muted"> until {fmtDate(l.expiresAt)}</small>}
                    </td>
                    <td className="muted">{fmtDate(l.createdAt)}</td>
                    <td className="actions">
                      <button className="link-btn" onClick={() => copy(l)}>{copied === l.id ? 'Copied' : 'Copy link'}</button>
                      <button className="link-btn" onClick={() => setQrLink(l)}>QR code</button>
                      <button className="link-btn" onClick={() => setEditLink(l)}>Edit</button>
                      {l.maxClicks != null && l.usedClicks > 0 && (
                        <button className="link-btn" onClick={() => resetCount(l)}>{isExhausted(l) ? 'Re-arm' : 'Reset count'}</button>
                      )}
                      <button className="link-btn" onClick={() => setPassword(l)}>{l.hasPassword ? 'Change password' : 'Add password'}</button>
                      <button className="link-btn" onClick={() => toggle(l)}>{l.isActive ? 'Pause' : 'Resume'}</button>
                      <button className="link-btn danger" onClick={() => remove(l)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
