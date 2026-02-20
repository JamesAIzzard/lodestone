import { HashRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import SilosView from './views/SilosView';
import SearchView from './views/SearchView';
import ActivityView from './views/ActivityView';
import SettingsView from './views/SettingsView';

export default function App() {
  return (
    <HashRouter>
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
    </HashRouter>
  );
}
