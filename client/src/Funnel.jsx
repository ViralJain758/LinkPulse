import { useState } from 'react';
import { api, useFetch } from './api.js';
import { ErrorNote, ExportMenu } from './ui.jsx';
import { RANGES, fmt } from './format.js';

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');

export default function Funnel({ range }) {
  const [link, setLink] = useState('');
  const { data: links } = useFetch(() => api.links(), [], 60000);
  const { data, error, loading, reload } = useFetch(() => api.funnel(range, link), [range, link], 30000);
  const phrase = RANGES.find((r) => r.key === range)?.phrase;
  const top = data?.steps[0]?.value ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Visitor funnel</h1>
          <p className="muted">How many clicks turn into people, and how many of them come back, over {phrase}.</p>
        </div>
        <ExportMenu range={range} ids={link ? [link] : []} />
      </div>

      <div className="toolbar">
        <label className="inline-label">
          Scope
          <select value={link} onChange={(e) => setLink(e.target.value)} aria-label="Links to include">
            <option value="">All links</option>
            {(links || []).map((l) => <option key={l.id} value={l.id}>/{l.slug}</option>)}
          </select>
        </label>
      </div>

      {error && !data ? (
        <ErrorNote message={error} onRetry={reload} />
      ) : !data ? (
        <div className="skeleton" aria-label="Loading funnel" />
      ) : top === 0 ? (
        <div className="empty"><strong>No clicks in this period yet.</strong><p>The funnel fills in once your links get visits.</p></div>
      ) : (
        <section className={`panel funnel ${loading ? 'dim' : ''}`}>
          <ol className="funnel-steps">
            {data.steps.map((s, i) => {
              const prev = i ? data.steps[i - 1].value : null;
              return (
                <li key={s.key}>
                  <div className="funnel-meta">
                    <div>
                      <strong>{s.label}</strong>
                      <small className="muted">{s.hint}</small>
                    </div>
                    <div className="funnel-num">
                      <span className="big-num">{fmt(s.value)}</span>
                      {i > 0 && <small className="muted">{pct(s.value, prev)} of previous · {pct(s.value, top)} of clicks</small>}
                    </div>
                  </div>
                  <div className="funnel-track" role="img" aria-label={`${s.label}: ${fmt(s.value)}, ${pct(s.value, top)} of clicks`}>
                    <span style={{ width: `${top ? Math.max((s.value / top) * 100, s.value ? 1.5 : 0) : 0}%`, opacity: 1 - i * 0.18 }} />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="muted funnel-note">Visitors are counted from a one-way hash of the IP address, so the same person on two networks counts twice and people sharing a network count once. LinkPulse never stores raw IPs.</p>
        </section>
      )}
    </>
  );
}
