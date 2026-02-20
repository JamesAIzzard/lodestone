import { HashRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import SilosView from './views/SilosView';
import SearchView from './views/SearchView';
import ActivityView from './views/ActivityView';
import SettingsView from './views/SettingsView';
import OnboardingView from './views/OnboardingView';

export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* Onboarding has its own full-screen layout (no sidebar) */}
        <Route path="/onboarding" element={<OnboardingView />} />

        {/* Main app layout with sidebar */}
        <Route
          path="*"
          element={
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <main className="flex-1 overflow-y-auto">
                <Routes>
                  <Route path="/" element={<SilosView />} />
                  <Route path="/search" element={<SearchView />} />
                  <Route path="/activity" element={<ActivityView />} />
                  <Route path="/settings" element={<SettingsView />} />
                </Routes>
              </main>
            </div>
          }
        />
      </Routes>
    </HashRouter>
  );
}
