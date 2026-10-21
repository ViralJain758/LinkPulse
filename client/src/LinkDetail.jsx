import { api, useFetch } from './api.js';
import Analytics from './Analytics.jsx';
import { ErrorNote } from './ui.jsx';

export default function LinkDetail({ link, range, onBack }) {
  const { data, error, loading, reload } = useFetch(() => api.linkStats(link.id, range), [link.id, range], 30000);
  const shortUrl = link.shortUrl || `/${link.slug}`;

  return (
    <>
      <button className="link-btn back" onClick={onBack}>
        ← Back to links
      </button>
      <div className="detail-head">
        <h1>/{link.slug}</h1>
        <p className="muted">
          {shortUrl} redirects to <a href={link.targetUrl} target="_blank" rel="noreferrer">{link.targetUrl}</a>
        </p>
      </div>
      {error && !data ? (
        <ErrorNote message={error} onRetry={reload} />
      ) : !data ? (
        <div className="skeleton" aria-label="Loading stats" />
      ) : (
        <div className={loading ? 'dim' : undefined}>
          <Analytics stats={data} range={range} />
        </div>
      )}
    </>
  );
}
