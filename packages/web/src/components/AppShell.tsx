import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { useTheme } from '../lib/theme.js';
import styles from './AppShell.module.css';

function WaveMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M2 12h3l3-7 4 14 3-9 2 2h5" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: 'dark' | 'light' }) {
  return theme === 'dark' ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <span className={styles.mark}><WaveMark /></span>
          rtcstats <span className={styles.brandSub}>dashboard</span>
        </Link>
        <div className={styles.spacer} />
        <button
          type="button"
          className={styles.iconButton}
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          <ThemeIcon theme={theme} />
        </button>
        <button type="button" className={styles.textButton} onClick={() => void logout()}>
          Log out
        </button>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
