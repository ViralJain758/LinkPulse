// Tags are typed as comma-separated text and sent as an array.
export const tagsToText = (tags) => (tags || []).join(', ');
export const textToTags = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);

export function TagsField({ value, onChange }) {
  return (
    <label>
      Tags (optional)
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="launch, q4, social" maxLength={400} title="Up to 10 tags, separated by commas" />
    </label>
  );
}

export function FolderSelect({ folders, value, onChange, label = 'Folder (optional)' }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No folder</option>
        {(folders || []).map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
    </label>
  );
}

// Only verified domains can hold links. Renders nothing when there are none, so users who never
// add a domain never see it. `valueKey` is what the option's value is: the domain id (create form)
// or its host name (CSV import, which names domains by host).
export function DomainSelect({ domains, value, onChange, valueKey = 'id', label = 'Domain' }) {
  const verified = (domains || []).filter((d) => d.verified);
  if (verified.length === 0) return null;
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default domain</option>
        {verified.map((d) => (
          <option key={d.id} value={d[valueKey]}>{d.host}</option>
        ))}
      </select>
    </label>
  );
}
