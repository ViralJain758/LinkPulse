import { useEffect, useState } from 'react';
import { clearSession, getSession, setUnauthorizedHandler } from './api.js';
import Login, { Logo } from './Login.jsx';
import Overview from './Overview.jsx';
import LinksPage from './LinksPage.jsx';
import LinkDetail from './LinkDetail.jsx';
import Compare from './Compare.jsx';
import Funnel from './Funnel.jsx';
import { RangeTabs } from './ui.jsx';

export default function App() {
  const [session, setSession] = useState(getSession);
  const [view, setView] = useState({ name: 'overview' });
  const [range, setRange] = useState('7d');

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession();
      setSession(null);
    });
  }, []);

  if (!session) return <Login onAuth={setSession} />;

  const signOut = () => {
    clearSession();
    setSession(null);
    setView({ name: 'overview' });
  };
  const openLink = (link) => setView({ name: 'link', link });
  const tab = view.name === 'link' ? 'links' : view.name;
  const showRange = view.name !== 'links';
  const nav = (name, label) => (
    <button className={tab === name ? 'on' : ''} onClick={() => setView({ name })}>{label}</button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Logo /> LinkPulse</div>
        <nav aria-label="Main">
          {nav('overview', 'Overview')}
          {nav('links', 'Links')}
          {nav('compare', 'Compare')}
          {nav('funnel', 'Funnel')}
        </nav>
        <div className="spacer" />
        {showRange && <RangeTabs value={range} onChange={setRange} />}
        <span className="live" title="Stats refresh every 30 seconds"><i /> Live</span>
        <button className="btn sm" onClick={signOut} title={session.user?.email}>Sign out</button>
      </header>
      <main className="page">
        {view.name === 'overview' && <Overview range={range} onOpenLink={openLink} />}
        {view.name === 'links' && <LinksPage onOpenLink={openLink} />}
        {view.name === 'compare' && <Compare range={range} onOpenLink={openLink} />}
        {view.name === 'funnel' && <Funnel range={range} />}
        {view.name === 'link' && <LinkDetail link={view.link} range={range} onBack={() => setView({ name: 'links' })} />}
      </main>
    </div>
  );
}
