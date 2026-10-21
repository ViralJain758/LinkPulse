import { useEffect, useRef, useState } from 'react';
import { api, useFetch } from './api.js';
import { fmt } from './format.js';

// Create, rename and delete folders. Deleting a folder keeps its links (they become unfiled).
export default function FoldersModal({ onClose, onChanged }) {
  const ref = useRef(null);
  const { data: folders, error, reload } = useFetch(() => api.folders(), []);
  const [name, setName] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function act(fn) {
    setActionError('');
    try {
      await fn();
      reload();
      onChanged();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await act(() => api.createFolder(name));
    setName('');
  };
  const rename = (f) => {
    const next = window.prompt(`Rename folder "${f.name}" to:`, f.name);
    if (next === null || next.trim() === '' || next === f.name) return;
    act(() => api.renameFolder(f.id, next));
  };
  const remove = (f) => {
    if (window.confirm(`Delete the folder "${f.name}"? Its ${f.linkCount} link(s) are kept and become unfiled.`)) {
      act(() => api.deleteFolder(f.id));
    }
  };

  return (
    <dialog ref={ref} className="qr-dialog edit-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <h2>Folders</h2>
      <form className="inline-form" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder name" maxLength={50} aria-label="New folder name" />
        <button className="btn primary" disabled={!name.trim()}>Add</button>
      </form>
      {(actionError || error) && <p className="error" role="alert">{actionError || error}</p>}
      {!folders ? (
        <p className="muted">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="muted">No folders yet.</p>
      ) : (
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.id}>
              <span className="folder-name">{f.name}</span>
              <small className="muted">{fmt(f.linkCount)} {f.linkCount === 1 ? 'link' : 'links'}</small>
              <button className="link-btn" onClick={() => rename(f)}>Rename</button>
              <button className="link-btn danger" onClick={() => remove(f)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      <div className="qr-actions">
        <button className="btn" type="button" onClick={() => ref.current.close()}>Done</button>
      </div>
    </dialog>
  );
}
