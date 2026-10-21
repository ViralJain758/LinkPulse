import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, useFetch } from './api.js';
import { ErrorNote, ExportMenu } from './ui.jsx';
import { RANGES, fmt, fmtBucket } from './format.js';

const MAX = 5;
// Five hues that stay apart on a dark background; dash patterns back them up for colour-blind readers.
const COLORS = ['#8b7bff', '#2dd4bf', '#f5b84f', '#ff7ab6', '#5ab0ff'];
const DASH = [undefined, '6 3', '2 3', '10 3 2 3', '4 4'];

function Tip({ active, payload, label, range, metric }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <span>{fmtBucket(label, range, true)}</span>
      {payload.map((p) => (
        <div key={p.dataKey} className="tip-row">
          <i style={{ background: p.color }} /> {p.name} <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  );
}

export default function Compare({ range, onOpenLink }) {
  const { data: links, error: linksError, reload: reloadLinks } = useFetch(() => api.links(), [], 60000);
  const [picked, setPicked] = useState(null); // null until we choose a sensible default
  const [metric, setMetric] = useState('clicks');
  const [search, setSearch] = useState('');

  // Default to the two most-clicked links so the page is useful straight away
  useEffect(() => {
    if (links && picked === null) {
      setPicked([...links].sort((a, b) => b.clickCount - a.clickCount).slice(0, 2).map((l) => l.id));
    }
  }, [links, picked]);

  const ids = (picked || []).filter((id) => links?.some((l) => l.id === id));
  const ready = ids.length >= 2;
  const { data, error, loading, reload } = useFetch(
    () => (ready ? api.compare(ids, range) : Promise.resolve(null)),
    [ids.join(','), range],
    30000
  );

  const toggle = (id) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX ? cur : [...cur, id]));

  const colorOf = (id) => COLORS[Math.max(0, ids.indexOf(id)) % COLORS.length];

  const rows = useMemo(() => {
    if (!data) return [];
    return data.buckets.map((bucket, i) => {
      const row = { bucket };
      for (const l of data.links) row[`l${l.id}`] = metric === 'clicks' ? l.timeseries[i].clicks : l.timeseries[i].uniqueVisitors;
      return row;
    });
  }, [data, metric]);

  const totalOf = (l) => (metric === 'clicks' ? l.totalClicks : l.uniqueVisitors);
  const best = data ? Math.max(...data.links.map(totalOf), 0) : 0;
  const sum = data ? data.links.reduce((a, l) => a + totalOf(l), 0) : 0;
  const phrase = RANGES.find((r) => r.key === range)?.phrase;

  const shown = (links || []).filter((l) => !search.trim() || (l.slug + ' ' + l.targetUrl).toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare links</h1>
          <p className="muted">Pick 2 to {MAX} links and see how they perform over {phrase}.</p>
        </div>
        <ExportMenu range={range} ids={ids} disabled={!ready} />
      </div>

      <section className="panel picker">
        <div className="picker-head">
          <h2>Links ({ids.length}/{MAX} selected)</h2>
          <input type="search" className="search" placeholder="Filter links" aria-label="Filter links" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {linksError && !links ? (
          <ErrorNote message={linksError} onRetry={reloadLinks} />
        ) : !links ? (
          <div className="skeleton short" aria-label="Loading links" />
        ) : links.length < 2 ? (
          <p className="muted">You need at least two links to compare. Create another on the Links page.</p>
        ) : (
          <div className="pick-list" role="group" aria-label="Links to compare">
            {shown.map((l) => {
              const on = ids.includes(l.id);
              const full = !on && ids.length >= MAX;
              return (
                <button key={l.id} type="button" className={`pick ${on ? 'on' : ''}`} aria-pressed={on} disabled={full} title={full ? `Up to ${MAX} links` : l.targetUrl} onClick={() => toggle(l.id)}>
                  <i className="swatch" style={on ? { background: colorOf(l.id) } : undefined} />
                  <span className="pick-slug">/{l.slug}</span>
                  <small>{fmt(l.clickCount)}</small>
                </button>
              );
            })}
            {shown.length === 0 && <p className="muted">No links match.</p>}
          </div>
        )}
      </section>

      {links && links.length >= 2 && !ready && (
        <div className="empty"><strong>Select at least two links.</strong><p>Choose them above to draw the comparison.</p></div>
      )}

      {ready && error && !data && <ErrorNote message={error} onRetry={reload} />}
      {ready && !data && !error && <div className="skeleton" aria-label="Loading comparison" />}
      {ready && data && (
        <div className={loading ? 'dim' : undefined}>
          <section className="hero compare-hero">
            <div className="compare-head">
              <h2>{metric === 'clicks' ? 'Clicks' : 'Unique visitors'} over time</h2>
              <div className="seg" role="tablist" aria-label="Metric">
                <button role="tab" aria-selected={metric === 'clicks'} className={metric === 'clicks' ? 'on' : ''} onClick={() => setMetric('clicks')}>Clicks</button>
                <button role="tab" aria-selected={metric === 'unique'} className={metric === 'unique' ? 'on' : ''} onClick={() => setMetric('unique')}>Visitors</button>
              </div>
            </div>
            {sum === 0 ? (
              <div className="empty"><strong>No clicks on these links in this period.</strong><p>Try a longer range or other links.</p></div>
            ) : (
              <div className="chart" role="img" aria-label={`${metric === 'clicks' ? 'Clicks' : 'Unique visitors'} over time for ${data.links.map((l) => '/' + l.slug).join(', ')}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="bucket" tickFormatter={(b) => fmtBucket(b, range)} tickLine={false} axisLine={false} minTickGap={28} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                    <YAxis allowDecimals={false} width={34} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                    <Tooltip content={<Tip range={range} metric={metric} />} cursor={{ stroke: 'var(--line-2)' }} />
                    {data.links.map((l, i) => (
                      <Line key={l.id} type="monotone" dataKey={`l${l.id}`} name={`/${l.slug}`} stroke={COLORS[i % COLORS.length]} strokeDasharray={DASH[i % DASH.length]} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className="panel compare-table">
            <h2>Summary</h2>
            <div className="table-wrap flat">
              <table className="plain">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th className="num">Clicks</th>
                    <th className="num">Visitors</th>
                    <th className="num">Clicks / visitor</th>
                    <th>Share of {metric === 'clicks' ? 'clicks' : 'visitors'}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((l, i) => {
                    const share = sum ? Math.round((totalOf(l) / sum) * 100) : 0;
                    return (
                      <tr key={l.id} className={totalOf(l) === best && best > 0 ? 'lead' : undefined}>
                        <td className="cell-link">
                          <button className="row-btn stacked" onClick={() => onOpenLink(links.find((x) => x.id === l.id))}>
                            <span className="slug"><i className="swatch on" style={{ background: COLORS[i % COLORS.length] }} />/{l.slug}</span>
                          </button>
                        </td>
                        <td className="num" data-label="Clicks">{fmt(l.totalClicks)}</td>
                        <td className="num" data-label="Visitors">{fmt(l.uniqueVisitors)}</td>
                        <td className="num" data-label="Clicks / visitor">{l.uniqueVisitors ? (l.totalClicks / l.uniqueVisitors).toFixed(1) : '–'}</td>
                        <td data-label="Share">
                          <div className="share"><span style={{ width: `${share}%`, background: COLORS[i % COLORS.length] }} /><b>{share}%</b></div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
