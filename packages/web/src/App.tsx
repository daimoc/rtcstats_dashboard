import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { AuthProvider, ProtectedRoute } from './lib/auth.js';
import { LoginPage } from './pages/LoginPage.js';
import { SessionBrowserPage } from './pages/SessionBrowserPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { getBasePath } from './lib/config.js';

export function App() {
  const [basePath, setBasePath] = useState<string | null>(null);

  useEffect(() => {
    getBasePath().then(setBasePath);
  }, []);

  if (basePath === null) {
    return null;
  }

  return (
    <BrowserRouter basename={basePath === '/' ? undefined : basePath}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell><SessionBrowserPage /></AppShell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sessions/:dumpId"
            element={
              <ProtectedRoute>
                <AppShell><SessionDetailPage /></AppShell>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
