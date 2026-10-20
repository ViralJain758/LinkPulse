import { api, useFetch } from './api.js';
import Analytics from './Analytics.jsx';
import { ErrorNote } from './ui.jsx';
import { fmt } from './format.js';

export default function Overview({ range, onOpenLink }) {
  // Polls every 30s so new clicks show up without a manual refresh.
  const { data, error, loading, reload } = useFetch(() => api.overview(range), [range], 30000);

  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return <p className="muted">Loading your stats…</p>;

  return (
    <div className={loading ? 'dim' : undefined}>
      <Analytics stats={data} range={range} facts={[['Links', fmt(data.totalLinks)]]}>
        <section className="wide">
          <h2>Top links</h2>
          {data.topLinks.length === 0 ? (
            <p className="muted">No link has been clicked in this range.</p>
          ) : (
            <ol className="top-links">
              {data.topLinks.map((l) => (
                <li key={l.id}>
                  <button className="row-btn" onClick={() => onOpenLink({ id: l.id, slug: l.slug, targetUrl: l.targetUrl })}>
                    <span className="slug">/{l.slug}</span>
                    <span className="target">{l.targetUrl}</span>
                    <span className="bar-num">{fmt(l.clicks)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </Analytics>
    </div>
  );
}
