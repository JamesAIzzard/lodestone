import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Database, Search, Activity, Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ServerStatus } from '../../shared/types';
import logoUrl from '../../../assets/icon.png';

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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true',
  );

  useEffect(() => {
    const fetchStatus = () => window.electronAPI?.getServerStatus().then(setStatus);
    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  };

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border bg-background transition-all duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* App title */}
      <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'px-5')}>
        {collapsed ? (
          <img src={logoUrl} alt="Lodestone" className="h-7 w-7" />
        ) : (
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="" className="h-6 w-6 shrink-0" />
            <span className="text-sm font-semibold tracking-wide text-foreground">Lodestone</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className={cn('flex flex-1 flex-col gap-1', collapsed ? 'px-2' : 'px-3')}>
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center rounded-md py-2 text-sm font-medium transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                collapsed ? 'justify-center px-2' : 'gap-3 px-3',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className={cn('px-2 pb-1', collapsed ? 'flex justify-center' : '')}>
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex w-full items-center rounded-md p-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
            collapsed ? 'justify-center' : 'gap-2',
          )}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <>
              <ChevronLeft className="h-3 w-3" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>

      {/* Status panel */}
      <div className={cn('border-t border-border py-4', collapsed ? 'px-2' : 'px-5')}>
        {collapsed ? (
          <div className="flex justify-center">
            <span
              title={
                status?.ollamaState === 'connected' ? 'Ollama: Connected' : 'Ollama: Disconnected'
              }
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                status?.ollamaState === 'connected' ? 'bg-emerald-500' : 'bg-red-500',
              )}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Ollama</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'inline-block h-2 w-2 rounded-full',
                    status?.ollamaState === 'connected' ? 'bg-emerald-500' : 'bg-red-500',
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
        )}
      </div>
    </aside>
  );
}
