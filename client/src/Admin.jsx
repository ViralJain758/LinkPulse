import { useEffect, useState } from 'react';
import { api, useFetch } from './api.js';
import { ErrorNote } from './ui.jsx';
import { fmtDate } from './format.js';

const TABS = [
  ['reports', 'Reports'],
  ['links', 'Links'],
  ['users', 'Users'],
  ['activity', 'Activity'],
];
const REASONS = {
  phishing: 'Phishing or scam',
  malware: 'Malware',
  spam: 'Spam',
  illegal: 'Illegal content',
  copyright: 'Copyright',
  other: 'Other',
};

// A button that asks for a reason (kept in the audit trail) before it does something drastic.
function ReasonAction({ label, placeholder, confirm, required = true, danger = true, onDone, onError }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button className={`act${danger ? ' danger' : ''}`} onClick={() => setOpen(true)}>{label}</button>;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await confirm(reason.trim());
      setOpen(false);
      setReason('');
      onDone();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="reason-form" onSubmit={submit}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} maxLength={500} required={required} autoFocus aria-label={placeholder} />
      <button className={`act${danger ? ' danger' : ''}`} disabled={busy}>{busy ? 'Working…' : `Confirm: ${label.toLowerCase()}`}</button>
      <button type="button" className="act" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

// One-click action with no reason (lifting a takedown)
function Quick({ label, run, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="act"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await run();
          onDone();
        } catch (err) {
          onError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}

const Owner = ({ owner }) =>
  owner ? <>Owner {owner.email}{owner.disabled && <span className="pill removed" style={{ marginLeft: 6 }}>Suspended</span>}</> : <>Link deleted by its owner</>;

function LinkActions({ link, onDone, onError }) {
  return link.isDisabled ? (
    <Quick label="Restore link" run={() => api.adminEnableLink(link.id)} onDone={onDone} onError={onError} />
  ) : (
    <ReasonAction label="Take down link" placeholder="Reason (shown to the owner)" confirm={(r) => api.adminDisableLink(link.id, r)} onDone={onDone} onError={onError} />
  );
}

function UserActions({ user, onDone, onError }) {
  if (!user) return null;
  return user.disabled ? (
    <Quick label="Restore account" run={() => api.adminEnableUser(user.id)} onDone={onDone} onError={onError} />
  ) : (
    <ReasonAction label="Suspend account" placeholder="Reason (kept in the audit trail)" confirm={(r) => api.adminDisableUser(user.id, r)} onDone={onDone} onError={onError} />
  );
}

function Reports({ setError }) {
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useFetch(() => api.adminReports(status), [status], 30000);
  return (
    <>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Report status">
          <option value="open">Open</option>
          <option value="actioned">Actioned</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {data && data.length === 0 && <p className="muted">{status === 'open' ? 'No open reports.' : 'Nothing here.'}</p>}
      <ul className="admin-list">
        {(data || []).map((r) => {
          const link = r.linkId ? { id: r.linkId, isDisabled: r.linkDisabled } : null;
          return (
            <li key={r.id} className="admin-item">
              <div className="top">
                <span className="pill removed">{REASONS[r.reason] || r.reason}</span>
                <strong>{r.shortUrl}</strong>
                {r.reportsForLink > 1 && <span className="pill tag">{r.reportsForLink} reports on this link</span>}
                {r.status !== 'open' && <span className="pill tag">{r.status}</span>}
              </div>
              <p className="url">Goes to {r.targetUrl}</p>
              {r.details && <p className="details">{r.details}</p>}
              <p className="meta">
                {fmtDate(r.createdAt)}{r.reporterEmail ? ` · reporter ${r.reporterEmail}` : ' · anonymous'} · <Owner owner={r.owner} />
                {r.resolutionNote && ` · ${r.resolutionNote}`}
              </p>
              <div className="actions">
                {link && <LinkActions link={link} onDone={reload} onError={setError} />}
                {r.owner && <UserActions user={r.owner} onDone={reload} onError={setError} />}
                {r.status === 'open' && (
                  <ReasonAction label="Dismiss" danger={false} required={false} placeholder="Note (optional)" confirm={(n) => api.adminDismissReport(r.id, n)} onDone={reload} onError={setError} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function useSearch() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  return [search, setSearch, q];
}

function Links({ setError }) {
  const [search, setSearch, q] = useSearch();
  const { data, error, reload } = useFetch(() => api.adminLinks(q), [q]);
  return (
    <>
      <div className="toolbar">
        <input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by slug, domain or destination" aria-label="Search links" />
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {data && data.length === 0 && <p className="muted">No links match.</p>}
      <ul className="admin-list">
        {(data || []).map((l) => (
          <li key={l.id} className="admin-item">
            <div className="top">
              <strong>{l.shortUrl}</strong>
              {l.isDisabled && <span className="pill removed">Taken down</span>}
              {!l.isActive && <span className="pill paused">Paused</span>}
              {l.reportCount > 0 && <span className="pill tag">{l.reportCount} {l.reportCount === 1 ? 'report' : 'reports'}</span>}
            </div>
            <p className="url">Goes to {l.targetUrl}</p>
            <p className="meta">{fmtDate(l.createdAt)} · <Owner owner={l.owner} />{l.disabledReason && ` · Reason: ${l.disabledReason}`}</p>
            <div className="actions">
              <LinkActions link={l} onDone={reload} onError={setError} />
              <UserActions user={l.owner} onDone={reload} onError={setError} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Users({ setError }) {
  const [search, setSearch, q] = useSearch();
  const { data, error, reload } = useFetch(() => api.adminUsers(q), [q]);
  return (
    <>
      <div className="toolbar">
        <input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email" aria-label="Search users" />
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {data && data.length === 0 && <p className="muted">No users match.</p>}
      <ul className="admin-list">
        {(data || []).map((u) => (
          <li key={u.id} className="admin-item">
            <div className="top">
              <strong>{u.email}</strong>
              {u.isAdmin && <span className="pill tag">Admin</span>}
              {u.isDisabled && <span className="pill removed">Suspended</span>}
              {u.reportCount > 0 && <span className="pill tag">{u.reportCount} {u.reportCount === 1 ? 'report' : 'reports'}</span>}
            </div>
            <p className="meta">Joined {fmtDate(u.createdAt)} · {u.linkCount} {u.linkCount === 1 ? 'link' : 'links'}{u.disabledReason && ` · Reason: ${u.disabledReason}`}</p>
            {!u.isAdmin && (
              <div className="actions">
                <UserActions user={{ id: u.id, disabled: u.isDisabled }} onDone={reload} onError={setError} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Activity() {
  const { data, error, reload } = useFetch(() => api.adminActions(), []);
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.length) return <p className="muted">No moderation actions yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id}>
              <td data-label="When">{fmtDate(a.createdAt)}</td>
              <td data-label="Admin">{a.admin || 'deleted admin'}</td>
              <td data-label="Action">{a.action.replace('_', ' ')}</td>
              <td data-label="Target">{a.targetType} #{a.targetId}</td>
              <td data-label="Reason">{a.reason || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const [tab, setTab] = useState('reports');
  const [error, setError] = useState('');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="muted">Review abuse reports and take down links or accounts. Every action is logged.</p>
        </div>
      </div>
      <div className="seg admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => { setTab(key); setError(''); }}>{label}</button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {tab === 'reports' && <Reports setError={setError} />}
      {tab === 'links' && <Links setError={setError} />}
      {tab === 'users' && <Users setError={setError} />}
      {tab === 'activity' && <Activity />}
    </>
  );
}
