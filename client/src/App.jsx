import { useEffect, useState } from 'react';
import { api, clearSession, getSession, saveSession, setUnauthorizedHandler } from './api.js';
import Login, { Logo } from './Login.jsx';
import Overview from './Overview.jsx';
import LinksPage from './LinksPage.jsx';
import LinkDetail from './LinkDetail.jsx';
import Compare from './Compare.jsx';
import Funnel from './Funnel.jsx';
import Admin from './Admin.jsx';
import { RangeTabs } from './ui.jsx';

// Emailed links open the dashboard as /?verify=TOKEN or /?reset=TOKEN. Read them once, at load,
// and take the token out of the address bar so it is not left in history or shared by accident.
const authLink = (() => {
  const params = new URLSearchParams(window.location.search);
  const link = { verify: params.get('verify'), reset: params.get('reset') };
  if (link.verify || link.reset) {
    params.delete('verify');
    params.delete('reset');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }
  return link;
})();
let verifyStarted = false; // a token works once; React may run the effect twice in development

export default function App() {
  const [session, setSession] = useState(getSession);
  const [notice, setNotice] = useState('');
  const [resetToken, setResetToken] = useState(authLink.reset);
  const [resent, setResent] = useState(false);
  const [view, setView] = useState({ name: 'overview' });
  const [range, setRange] = useState('7d');

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession();
      setSession(null);
    });
  }, []);

  useEffect(() => {
    if (!authLink.verify || verifyStarted) return;
    verifyStarted = true;
    api
      .verifyEmail(authLink.verify)
      .then(() => {
        setNotice('Email confirmed. Thank you!');
        const s = getSession();
        if (s?.user) {
          const next = { ...s, user: { ...s.user, emailVerified: true } };
          saveSession(next);
          setSession(next);
        }
      })
      .catch((e) => setNotice(e.message));
  }, []);

  if (resetToken) return <Login resetToken={resetToken} onResetDone={() => setResetToken(null)} onAuth={setSession} />;
  if (!session) return <Login onAuth={setSession} notice={notice} />;

  const signOut = () => {
    api.logout().catch(() => {}); // ends the session on the server; local sign-out does not wait for it
    clearSession();
    setSession(null);
    setView({ name: 'overview' });
  };
  const openLink = (link) => setView({ name: 'link', link });
  const tab = view.name === 'link' ? 'links' : view.name;
  const showRange = view.name !== 'links' && view.name !== 'admin';
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
          {session.user?.isAdmin && nav('admin', 'Admin')}
        </nav>
        <div className="spacer" />
        {showRange && <RangeTabs value={range} onChange={setRange} />}
        <span className="live" title="Stats refresh every 30 seconds"><i /> Live</span>
        <button className="btn sm" onClick={signOut} title={session.user?.email}>Sign out</button>
      </header>
      {(notice || session.user?.emailVerified === false) && (
        <div className="notice banner" role="status">
          {notice || 'Confirm your email address: we sent you a link.'}
          {!notice && !resent && (
            <button className="link-btn" onClick={() => api.resendVerification(session.user.email).then(() => setResent(true)).catch(() => {})}>
              Resend
            </button>
          )}
          {!notice && resent && ' Sent.'}
          {notice && <button className="link-btn" onClick={() => setNotice('')}>Dismiss</button>}
        </div>
      )}
      <main className="page">
        {view.name === 'overview' && <Overview range={range} onOpenLink={openLink} />}
        {view.name === 'links' && <LinksPage onOpenLink={openLink} />}
        {view.name === 'compare' && <Compare range={range} onOpenLink={openLink} />}
        {view.name === 'funnel' && <Funnel range={range} />}
        {view.name === 'admin' && session.user?.isAdmin && <Admin />}
        {view.name === 'link' && <LinkDetail link={view.link} range={range} onBack={() => setView({ name: 'links' })} />}
      </main>
    </div>
  );
}
