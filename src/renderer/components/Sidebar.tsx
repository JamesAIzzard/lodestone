import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Database, Search, Activity, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ServerStatus } from '../../shared/types';

const navItems = [
  { to: '/', label: 'Silos', icon: Database },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Sidebar() {
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    const fetchStatus = () => window.electronAPI?.getServerStatus().then(setStatus);
    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-background">
      {/* App title */}
      <div className="flex h-14 items-center px-5">
        <span className="text-sm font-semibold tracking-wide text-foreground">
          Lodestone
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Status panel */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Ollama</span>
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  status?.ollamaState === 'connected'
                    ? 'bg-emerald-500'
                    : 'bg-red-500',
                )}
              />
              {status?.ollamaState === 'connected' ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Indexed files</span>
            <span className="text-foreground">
              {status?.totalIndexedFiles?.toLocaleString() ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Uptime</span>
            <span className="text-foreground">
              {status ? formatUptime(status.uptimeSeconds) : '—'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
