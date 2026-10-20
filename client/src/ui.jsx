import { RANGES, fmt } from './format.js';

export function RangeTabs({ value, onChange }) {
  return (
    <div className="seg" role="tablist" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={value === r.key}
          className={value === r.key ? 'on' : ''}
          onClick={() => onChange(r.key)}
        >
          {r.key}
        </button>
      ))}
    </div>
  );
}

// Ranked horizontal bars: easier to compare than pies, and handles long names.
export function BarList({ items, total, label = (n) => n, empty = 'No data in this range.' }) {
  if (!items?.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.clicks), 1);
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.name}>
          <span className="bar-fill" style={{ width: `${(i.clicks / max) * 100}%` }} />
          <span className="bar-name">{label(i.name)}</span>
          <span className="bar-num">
            {fmt(i.clicks)}
            <small>{total ? `${Math.round((i.clicks / total) * 100)}%` : ''}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

export const ErrorNote = ({ message, onRetry }) => (
  <div className="error" role="alert">
    {message}
    {onRetry && (
      <button className="link-btn" onClick={onRetry}>
        Try again
      </button>
    )}
  </div>
);
