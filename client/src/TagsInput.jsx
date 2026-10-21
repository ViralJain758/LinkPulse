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
