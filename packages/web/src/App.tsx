import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth.js';
import { LoginPage } from './pages/LoginPage.js';
import { SessionBrowserPage } from './pages/SessionBrowserPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><SessionBrowserPage /></ProtectedRoute>} />
          <Route path="/sessions/:dumpId" element={<ProtectedRoute><SessionDetailPage /></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
