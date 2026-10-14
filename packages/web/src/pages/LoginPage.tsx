import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { authenticated, login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (authenticated) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M2 12h3l3-7 4 14 3-9 2 2h5" />
            </svg>
          </span>
          rtcstats dashboard
        </div>

        <div>
          <h1 className={styles.title}>Login</h1>
          <p className={styles.subtitle}>Enter the dashboard password to browse calls.</p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? 'Signing in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
