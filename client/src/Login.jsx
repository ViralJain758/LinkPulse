import { useState } from 'react';
import { api, saveSession } from './api.js';

// mode: login | register | forgot | reset. `resetToken` (from the emailed link) opens the reset form.
export default function Login({ onAuth, notice = '', resetToken = null, onResetDone }) {
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [info, setInfo] = useState(notice);
  const [busy, setBusy] = useState(false);

  const go = (next) => {
    setMode(next);
    setError('');
    setErrorCode('');
    setInfo('');
    setPassword('');
    setConfirm('');
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrorCode('');
    setInfo('');
    try {
      if (mode === 'forgot') {
        const res = await api.forgotPassword(email);
        setInfo(res.message);
      } else if (mode === 'reset') {
        if (password !== confirm) throw new Error('The two passwords do not match');
        await api.resetPassword(resetToken, password);
        onResetDone?.();
        setMode('login');
        setPassword('');
        setConfirm('');
        setInfo('Password updated. Sign in with your new password.');
      } else {
        const res = await (mode === 'login' ? api.login : api.register)(email, password);
        if (res.verificationRequired) {
          setMode('login');
          setPassword('');
          setInfo('Account created. We sent a confirmation link to your email: open it, then sign in.');
        } else {
          const session = { token: res.accessToken, refreshToken: res.refreshToken, user: res.user };
          saveSession(session);
          onAuth(session);
        }
      }
    } catch (err) {
      setError(err.message);
      setErrorCode(err.code || '');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      const res = await api.resendVerification(email);
      setError('');
      setErrorCode('');
      setInfo(res.message);
    } catch (err) {
      setError(err.message);
    }
  }

  const titles = {
    login: ['Welcome back.', 'Sign in to your dashboard.'],
    register: ['See who clicks your links.', 'Create a free account to start shortening links.'],
    forgot: ['Forgot your password?', 'Enter your email and we will send you a link to choose a new one.'],
    reset: ['Choose a new password.', 'You will be signed out everywhere and can sign in with the new one.'],
  };
  const [title, sub] = titles[mode];
  const newPassword = mode === 'register' || mode === 'reset';

  return (
    <div className="auth-wrap">
    <main className="auth">
      <div className="brand big-brand">
        <Logo /> LinkPulse
      </div>
      <h1>{title}</h1>
      <p className="muted auth-sub">{sub}</p>
      {info && <p className="notice" role="status">{info}</p>}
      <form onSubmit={submit}>
        {mode !== 'reset' && (
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
        )}
        {mode !== 'forgot' && (
          <label>
            {mode === 'reset' ? 'New password' : 'Password'}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={newPassword ? 'new-password' : 'current-password'}
              minLength={newPassword ? 8 : undefined}
              maxLength={newPassword ? 72 : undefined}
              required
            />
            {newPassword && <small className="muted">At least 8 characters.</small>}
          </label>
        )}
        {mode === 'reset' && (
          <label>
            Repeat new password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
            {errorCode === 'email_not_verified' && <button type="button" className="link-btn" onClick={resend}>Resend confirmation email</button>}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Please wait…' : { login: 'Sign in', register: 'Create account', forgot: 'Send reset link', reset: 'Set new password' }[mode]}
        </button>
      </form>
      {mode === 'login' && (
        <p className="muted auth-foot">
          <button className="link-btn" onClick={() => go('forgot')}>Forgot your password?</button>
        </p>
      )}
      <p className="muted auth-foot">
        {mode === 'register' ? 'Already have an account? ' : mode === 'login' ? 'New here? ' : ''}
        {mode === 'login' && <button className="link-btn" onClick={() => go('register')}>Create an account</button>}
        {mode !== 'login' && <button className="link-btn" onClick={() => go('login')}>{mode === 'register' ? 'Sign in' : 'Back to sign in'}</button>}
      </p>
    </main>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M4 17h6l3-8 5 15 3-7h7" fill="none" stroke="#0b0820" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
