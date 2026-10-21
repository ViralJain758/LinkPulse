import { useEffect, useState } from 'react';
import { api, useFetch } from './api.js';
import { ErrorNote } from './ui.jsx';
import { fmt, fmtDate } from './format.js';
import QrModal from './QrModal.jsx';
import EditModal from './EditModal.jsx';
import ImportModal from './ImportModal.jsx';
import FoldersModal from './FoldersModal.jsx';
import DomainsModal from './DomainsModal.jsx';
import { DomainSelect, FolderSelect, TagsField, textToTags } from './TagsInput.jsx';
import { RoutesField, rowsToRoutes } from './RoutesField.jsx';

const isExhausted = (l) => l.maxClicks != null && l.usedClicks >= l.maxClicks;

function status(link) {
  if (!link.isActive) return { key: 'paused', text: 'Paused' };
  if (link.expiresAt && new Date(link.expiresAt) <= new Date()) return { key: 'expired', text: 'Expired' };
  if (isExhausted(link)) return { key: 'used', text: link.maxClicks === 1 ? 'Used' : 'Limit reached' };
  return { key: 'active', text: 'Active' };
}

function CreateForm({ folders, domains, onCreated }) {
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [expires, setExpires] = useState('');
  const [password, setPassword] = useState('');
  const [maxClicks, setMaxClicks] = useState('');
  const [tags, setTags] = useState('');
  const [folderId, setFolderId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [routes, setRoutes] = useState([]);
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
        ...(textToTags(tags).length > 0 && { tags: textToTags(tags) }),
        ...(folderId && { folderId }),
        ...(domainId && { domainId }),
        ...(routes.length > 0 && { routes: rowsToRoutes(routes) }),
      });
      setUrl('');
      setSlug('');
      setExpires('');
      setPassword('');
      setMaxClicks('');
      setTags('');
      setRoutes([]);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="create" onSubmit={submit}>
      <div className="create-main">
        <label>
          Destination URL
          <input type="url" placeholder="https://example.com/a-long-page" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create link'}</button>
      </div>
      {error && <p className="error full" role="alert">{error}</p>}
      <details className="create-more">
        <summary>More options</summary>
        <div className="create-fields">
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
      <TagsField value={tags} onChange={setTags} />
      <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
      <DomainSelect domains={domains} value={domainId} onChange={setDomainId} />
      <RoutesField value={routes} onChange={setRoutes} />
        </div>
      </details>
    </form>
  );
}

export default function LinksPage({ onOpenLink }) {
  const [folder, setFolder] = useState(''); // '' = all, 'none' = unfiled, else a folder id
  const [domain, setDomain] = useState(''); // '' = all, 'none' = default domain, else a domain id
  const [tag, setTag] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState(''); // search, after a short pause in typing
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const { data: links, error, reload } = useFetch(() => api.links({ folder, domain, tag, q }), [folder, domain, tag, q], 30000);
  const { data: folders, reload: reloadFolders } = useFetch(() => api.folders(), [], 30000);
  const { data: tags, reload: reloadTags } = useFetch(() => api.tags(), [], 30000);
  const { data: domains, reload: reloadDomains } = useFetch(() => api.domains(), [], 30000);
  const verifiedDomains = (domains || []).filter((d) => d.verified);
  const reloadAll = () => {
    reload();
    reloadFolders();
    reloadTags();
    reloadDomains();
  };
  const filtering = Boolean(folder || domain || tag || q);
  const clearFilters = () => {
    setFolder('');
    setDomain('');
    setTag('');
    setSearch('');
  };
  // A deleted folder (or removed tag) must not leave the list filtered by something that is gone
  useEffect(() => {
    if (folder && folder !== 'none' && folders && !folders.some((f) => f.id === folder)) setFolder('');
  }, [folders, folder]);
  const [showImport, setShowImport] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const [showDomains, setShowDomains] = useState(false);
  // A removed domain must not leave the list filtered by something that is gone
  useEffect(() => {
    if (domain && domain !== 'none' && domains && !domains.some((d) => d.id === domain)) setDomain('');
  }, [domains, domain]);
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
      reloadAll();
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
      <div className="page-head"><h1>Links</h1></div>
      {qrLink && <QrModal link={qrLink} onClose={() => setQrLink(null)} />}
      {editLink && <EditModal link={editLink} folders={folders} onClose={() => setEditLink(null)} onSaved={reloadAll} />}
      {showImport && <ImportModal folders={folders} domains={domains} onClose={() => setShowImport(false)} onImported={reloadAll} />}
      {showFolders && <FoldersModal onClose={() => setShowFolders(false)} onChanged={reloadAll} />}
      {showDomains && <DomainsModal onClose={() => setShowDomains(false)} onChanged={reloadAll} />}
      <CreateForm folders={folders} domains={domains} onCreated={reloadAll} />
      <div className="toolbar">
        <input type="search" className="search" placeholder="Search slug, URL or tag" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search links" />
        <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Filter by folder">
          <option value="">All folders</option>
          <option value="none">Unfiled</option>
          {(folders || []).map((f) => (
            <option key={f.id} value={f.id}>{f.name} ({fmt(f.linkCount)})</option>
          ))}
        </select>
        {verifiedDomains.length > 0 && (
          <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Filter by domain">
            <option value="">All domains</option>
            <option value="none">Default domain</option>
            {verifiedDomains.map((d) => (
              <option key={d.id} value={d.id}>{d.host}</option>
            ))}
          </select>
        )}
        <div className="toolbar-actions">
          <button className="btn" type="button" onClick={() => setShowFolders(true)}>Folders</button>
          <button className="btn" type="button" onClick={() => setShowDomains(true)}>Domains</button>
          <button className="btn" type="button" onClick={() => setShowImport(true)}>Import CSV</button>
        </div>
      </div>
      {tags?.length > 0 && (
        <div className="tag-bar" aria-label="Filter by tag">
          {tags.map((t) => (
            <button key={t.name} type="button" className={`chip ${tag === t.name ? 'on' : ''}`} aria-pressed={tag === t.name} onClick={() => setTag(tag === t.name ? '' : t.name)}>
              {t.name} <small>{fmt(t.linkCount)}</small>
            </button>
          ))}
        </div>
      )}
      {actionError && <ErrorNote message={actionError} />}
      {error && !links ? (
        <ErrorNote message={error} onRetry={reload} />
      ) : !links ? (
        <div className="skeleton" aria-label="Loading links" />
      ) : links.length === 0 && filtering ? (
        <div className="empty">
          <strong>No links match.</strong>
          <p><button className="link-btn" onClick={clearFilters}>Clear filters</button></p>
        </div>
      ) : links.length === 0 ? (
        <div className="empty">
          <strong>No links yet.</strong>
          <p>Paste a destination URL above to create your first short link, or import many at once from a CSV file.</p>
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
                    <td className="cell-link">
                      <button className="row-btn stacked" onClick={() => onOpenLink(l)}>
                        <span className="slug">/{l.slug}</span>
                        <span className="target">{l.targetUrl}</span>
                      </button>
                      {(l.folderName || l.domain || l.tags.length > 0) && (
                        <div className="meta">
                          {l.domain && (
                            <button type="button" className="chip domain-chip" title="Show links on this domain" onClick={() => setDomain(l.domainId)}>{l.domain}</button>
                          )}
                          {l.folderName && (
                            <button type="button" className="chip folder" title="Show this folder" onClick={() => setFolder(l.folderId)}>{l.folderName}</button>
                          )}
                          {l.tags.map((t) => (
                            <button key={t} type="button" className={`chip ${tag === t ? 'on' : ''}`} title="Filter by this tag" onClick={() => setTag(t)}>#{t}</button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num" data-label="Clicks">{fmt(l.clickCount)}</td>
                    <td className="status-wrap" data-label="Status">
                      <div className="status-cell">
                      <span className={`pill ${s.key}`}>{s.text}</span>
                      {l.hasPassword && <span className="pill tag" title="Visitors must enter a password">Password</span>}
                      {l.maxClicks === 1 && s.key !== 'used' && <span className="pill tag" title="Stops working after one visit">One-time</span>}
                      {l.maxClicks > 1 && (
                        <span className="pill tag" title="Stops working after this many visits">{fmt(l.usedClicks)} / {fmt(l.maxClicks)} visits</span>
                      )}
                      {l.routes.length > 0 && (
                        <span className="pill tag" title="Sends visitors to different URLs by device or country">{l.routes.length} routing {l.routes.length === 1 ? 'rule' : 'rules'}</span>
                      )}
                      {l.expiresAt && s.key === 'active' && <small className="muted">Until {fmtDate(l.expiresAt)}</small>}
                      </div>
                    </td>
                    <td className="muted created" data-label="Created">{fmtDate(l.createdAt)}</td>
                    <td className="actions-cell">
                      <div className="actions">
                      <button className="act primary" onClick={() => copy(l)}>{copied === l.id ? 'Copied' : 'Copy link'}</button>
                      <button className="act" onClick={() => setQrLink(l)}>QR code</button>
                      <button className="act" onClick={() => setEditLink(l)}>Edit</button>
                      {l.maxClicks != null && l.usedClicks > 0 && (
                        <button className="act" onClick={() => resetCount(l)}>{isExhausted(l) ? 'Re-arm' : 'Reset count'}</button>
                      )}
                      <button className="act" onClick={() => setPassword(l)}>{l.hasPassword ? 'Change password' : 'Add password'}</button>
                      <button className="act" onClick={() => toggle(l)}>{l.isActive ? 'Pause' : 'Resume'}</button>
                      <button className="act danger" onClick={() => remove(l)}>Delete</button>
                      </div>
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
