import { useEffect, useRef, useState } from 'react';
import { api, useFetch } from './api.js';
import { fmt } from './format.js';

function CopyValue({ label, value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the text is selectable, so the user can copy it by hand */
    }
  }
  return (
    <div className="dns-row">
      <span className="dns-label">{label}</span>
      <code>{value}</code>
      <button type="button" className="link-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function DomainCard({ domain, onVerify, onRemove, note }) {
  return (
    <li className="domain">
      <div className="domain-head">
        <strong>{domain.host}</strong>
        <span className={`pill ${domain.verified ? 'active' : 'expired'}`}>{domain.verified ? 'Verified' : 'Not verified'}</span>
        {domain.verified && <small className="muted">{fmt(domain.linkCount)} {domain.linkCount === 1 ? 'link' : 'links'}</small>}
        <span className="spacer" />
        {!domain.verified && <button className="btn" type="button" onClick={() => onVerify(domain)}>Check DNS</button>}
        <button className="link-btn danger" type="button" onClick={() => onRemove(domain)}>Remove</button>
      </div>
      {!domain.verified && (
        <div className="dns">
          <p className="muted">Add these two records at your DNS provider, then press Check DNS. Changes can take a few minutes to appear.</p>
          <CopyValue label="1. TXT record (proves you own it): name" value={domain.dns.txtName} />
          <CopyValue label="1. TXT record: value" value={domain.dns.txtValue} />
          <CopyValue label="2. CNAME record (sends visitors here): name" value={domain.host} />
          <CopyValue label="2. CNAME record: value" value={domain.dns.target} />
          <p className="muted small">
            Some DNS providers want only the part before your domain as the name (for go.example.com, the TXT name is <code>_linkpulse.go</code>).
            A bare domain such as example.com cannot have a CNAME; use a subdomain like go.example.com, or an ALIAS/ANAME or A record if your provider offers one.
          </p>
        </div>
      )}
      {note && <p className="muted small" role="status">{note}</p>}
    </li>
  );
}

// Add custom domains, show the DNS records to create, check them, and remove domains.
export default function DomainsModal({ onClose, onChanged }) {
  const ref = useRef(null);
  const { data: domains, error, reload } = useFetch(() => api.domains(), []);
  const [host, setHost] = useState('');
  const [actionError, setActionError] = useState('');
  const [notes, setNotes] = useState({}); // domain id -> message from the last check
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function act(fn) {
    setActionError('');
    setBusy(true);
    try {
      await fn();
      reload();
      onChanged();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const add = async (e) => {
    e.preventDefault();
    if (!host.trim()) return;
    await act(async () => {
      await api.addDomain(host);
      setHost('');
    });
  };

  const verify = (d) =>
    act(async () => {
      const r = await api.verifyDomain(d.id);
      const routing = r.routing ? '' : ' Your CNAME (or A record) does not point here yet, so visitors will not reach this service until it does.';
      setNotes((n) => ({ ...n, [d.id]: r.verified ? `Verified.${routing}` : r.message }));
    });

  const remove = (d) =>
    act(async () => {
      if (d.linkCount > 0) {
        const ok = window.confirm(`${d.host} has ${d.linkCount} link(s). Removing the domain deletes them and their click history, and their short URLs stop working. Continue?`);
        if (!ok) return;
        await api.deleteDomain(d.id, true);
      } else if (window.confirm(`Remove ${d.host}?`)) {
        await api.deleteDomain(d.id);
      }
    });

  return (
    <dialog ref={ref} className="qr-dialog edit-dialog domains-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <h2>Custom domains</h2>
      <p className="muted">Serve your links from your own domain, like go.example.com/sale. Links on a domain are separate from the default domain, so the same slug can exist on both.</p>
      <form className="inline-form" onSubmit={add}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="go.example.com" aria-label="Domain name" maxLength={253} />
        <button className="btn primary" disabled={busy || !host.trim()}>Add</button>
      </form>
      {(actionError || error) && <p className="error" role="alert">{actionError || error}</p>}
      {!domains ? (
        <p className="muted">Loading…</p>
      ) : domains.length === 0 ? (
        <p className="muted">No domains yet.</p>
      ) : (
        <ul className="domain-list">
          {domains.map((d) => (
            <DomainCard key={d.id} domain={d} onVerify={verify} onRemove={remove} note={notes[d.id]} />
          ))}
        </ul>
      )}
      <div className="qr-actions">
        <button className="btn" type="button" onClick={() => ref.current.close()}>Done</button>
      </div>
    </dialog>
  );
}
