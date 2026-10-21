// Device and country routing rules for a link: visitors that match a rule are sent to its URL
// instead of the destination. Rules are tried top to bottom and the first match wins.
export const MAX_ROUTES = 10;

const blank = (device = '') => ({ device, country: '', url: '' });

// Rows are what the form edits (all strings); the API takes { device?, country?, url }.
export const routesToRows = (routes) => (routes || []).map((r) => ({ device: r.device || '', country: r.country || '', url: r.url }));
export const rowsToRoutes = (rows) =>
  rows.map((r) => ({
    ...(r.device && { device: r.device }),
    ...(r.country.trim() && { country: r.country.trim().toUpperCase() }),
    url: r.url.trim(),
  }));

export function RoutesField({ value, onChange }) {
  const set = (i, patch) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(value.filter((_, k) => k !== i));
  const add = (...rows) => onChange([...value, ...rows].slice(0, MAX_ROUTES));
  const full = value.length >= MAX_ROUTES;

  return (
    <fieldset className="routes">
      <legend>Device &amp; country routing (optional)</legend>
      {value.length === 0 && (
        <small className="muted">Send iOS visitors to the App Store, Android visitors to Google Play, or people in a country to their own page. Everyone else goes to the destination above.</small>
      )}
      {value.map((r, i) => (
        <div className="route-row" key={i}>
          <select value={r.device} onChange={(e) => set(i, { device: e.target.value })} aria-label={`Rule ${i + 1} device`}>
            <option value="">Any device</option>
            <option value="ios">iOS</option>
            <option value="android">Android</option>
          </select>
          <input
            value={r.country}
            onChange={(e) => set(i, { country: e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() })}
            placeholder="Country"
            pattern="[A-Za-z]{2}"
            title="Optional 2-letter country code, for example DE or IN"
            aria-label={`Rule ${i + 1} country (optional)`}
            autoCapitalize="characters"
          />
          <input
            className="route-url"
            type="url"
            value={r.url}
            onChange={(e) => set(i, { url: e.target.value })}
            placeholder={r.device === 'ios' ? 'https://apps.apple.com/app/…' : r.device === 'android' ? 'https://play.google.com/store/apps/details?id=…' : 'https://…'}
            aria-label={`Rule ${i + 1} URL`}
            required
          />
          <button type="button" className="link-btn danger" onClick={() => remove(i)} aria-label={`Remove rule ${i + 1}`}>Remove</button>
        </div>
      ))}
      <div className="route-actions">
        <button type="button" className="btn" disabled={full} onClick={() => add(blank('ios'), blank('android'))}>App Store &amp; Google Play</button>
        <button type="button" className="btn" disabled={full} onClick={() => add(blank())}>Add rule</button>
        {value.length > 1 && <small className="muted">First matching rule wins. A rule needs a device, a country or both.</small>}
      </div>
    </fieldset>
  );
}
