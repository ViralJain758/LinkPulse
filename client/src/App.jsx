import { useEffect, useState } from 'react';
import { clearSession, getSession, setUnauthorizedHandler } from './api.js';
import Login, { Logo } from './Login.jsx';
import Overview from './Overview.jsx';
import LinksPage from './LinksPage.jsx';
import LinkDetail from './LinkDetail.jsx';
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Logo /> LinkPulse</div>
        <nav aria-label="Main">
          <button className={tab === 'overview' ? 'on' : ''} onClick={() => setView({ name: 'overview' })}>Overview</button>
          <button className={tab === 'links' ? 'on' : ''} onClick={() => setView({ name: 'links' })}>Links</button>
        </nav>
        <div className="spacer" />
        {showRange && <RangeTabs value={range} onChange={setRange} />}
        <span className="live" title="Stats refresh every 30 seconds"><i /> Live</span>
        <button className="link-btn" onClick={signOut} title={session.user?.email}>Sign out</button>
      </header>
      <main className="page">
        {view.name === 'overview' && <Overview range={range} onOpenLink={openLink} />}
        {view.name === 'links' && <LinksPage onOpenLink={openLink} />}
        {view.name === 'link' && <LinkDetail link={view.link} range={range} onBack={() => setView({ name: 'links' })} />}
      </main>
    </div>
  );
}
