import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarList } from './ui.jsx';
import { RANGES, capitalize, countryName, fmt, fmtBucket } from './format.js';

function ChartTip({ active, payload, range }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tip">
      <strong>{fmt(p.clicks)}</strong> {p.clicks === 1 ? 'click' : 'clicks'}
      <span>{fmtBucket(p.bucket, range, true)}</span>
    </div>
  );
}

function Timeseries({ data, range }) {
  return (
    <div className="chart" role="img" aria-label="Clicks over time">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b) => fmtBucket(b, range)}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
          />
          <YAxis
            allowDecimals={false}
            width={34}
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
          />
          <Tooltip content={<ChartTip range={range} />} cursor={{ stroke: 'var(--accent)', strokeOpacity: 0.3 }} />
          <Area
            type="monotone"
            dataKey="clicks"
            stroke="var(--accent)"
            strokeWidth={2.5}
            fill="var(--accent)"
            fillOpacity={0.1}
            activeDot={{ r: 5, fill: 'var(--accent)', stroke: '#fff', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Shared by the account overview and a single link: both endpoints return the same shape.
export default function Analytics({ stats, range, facts = [], children }) {
  const { totalClicks, uniqueVisitors, timeseries, referrers, devices, browsers, operatingSystems, countries } = stats;
  const phrase = RANGES.find((r) => r.key === range)?.phrase;
  const peak = timeseries.reduce((a, b) => (b.clicks > a.clicks ? b : a), { clicks: 0 });

  const summary = [
    ['Unique visitors', fmt(uniqueVisitors)],
    ['Busiest ' + (range === '24h' ? 'hour' : 'day'), peak.clicks ? `${fmtBucket(peak.bucket, range)} (${fmt(peak.clicks)})` : '–'],
    ['Top source', referrers[0]?.name ?? '–'],
    ...facts,
  ];

  return (
    <>
      <section className="hero">
        <div className="hero-head">
          <div>
            <div className="big">{fmt(totalClicks)}</div>
            <p className="muted">{totalClicks === 1 ? 'click' : 'clicks'} in {phrase}</p>
          </div>
          <dl className="facts">
            {summary.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        {totalClicks === 0 ? (
          <div className="empty">
            <strong>No clicks in this period yet.</strong>
            <p>Share a short link and clicks will appear here within a few seconds. Bots and link previews are not counted.</p>
          </div>
        ) : (
          <Timeseries data={timeseries} range={range} />
        )}
      </section>

      <div className="sections">
        {children /* e.g. top links on the overview */}
        <section>
          <h2>Sources</h2>
          <BarList items={referrers} total={totalClicks} />
        </section>
        <section>
          <h2>Devices</h2>
          <BarList items={devices} total={totalClicks} label={capitalize} />
        </section>
        <section>
          <h2>Browsers</h2>
          <BarList items={browsers} total={totalClicks} />
        </section>
        <section>
          <h2>Operating systems</h2>
          <BarList items={operatingSystems} total={totalClicks} />
        </section>
        <section>
          <h2>Countries</h2>
          <BarList
            items={countries}
            total={totalClicks}
            label={countryName}
            empty="No country data. It appears when the server runs behind Cloudflare, Vercel or CloudFront."
          />
        </section>
      </div>
    </>
  );
}
