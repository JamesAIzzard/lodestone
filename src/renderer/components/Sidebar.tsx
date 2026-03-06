import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { Database, Search, Activity, Settings, ChevronLeft, ChevronRight, BrainCircuit, Boxes, FileStack, Clock } from 'lucide-react';
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

const NARROW_THRESHOLD = 640;

export default function Sidebar() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') === 'true',
  );
  const [forceCollapsed, setForceCollapsed] = useState(
    () => window.innerWidth < NARROW_THRESHOLD,
  );

  useEffect(() => {
    const fetchStatus = () => window.electronAPI?.getServerStatus().then(setStatus);
    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    // Allow other components (e.g. Settings) to trigger an immediate refresh
    const handleCloudChange = () => fetchStatus();
    window.addEventListener('cloud-url-changed', handleCloudChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener('cloud-url-changed', handleCloudChange);
    };
  }, []);

  useEffect(() => {
    window.electronAPI?.getAppVersion().then(setVersion);
  }, []);

  useEffect(() => {
    const handleResize = () => setForceCollapsed(window.innerWidth < NARROW_THRESHOLD);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isCollapsed = collapsed || forceCollapsed;

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
        isCollapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* App title */}
      <div className={cn('flex h-14 shrink-0 items-center', isCollapsed ? 'justify-center px-2' : 'px-5')}>
        {isCollapsed ? (
          <img src={logoUrl} alt="Lodestone" className="h-7 w-7" />
        ) : (
          <div className="flex w-full items-center gap-2.5">
            <img src={logoUrl} alt="" className="h-6 w-6 shrink-0" />
            <span className="text-sm font-semibold tracking-wide text-foreground">Lodestone</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className={cn('flex flex-1 flex-col gap-1', isCollapsed ? 'px-2' : 'px-3')}>
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={isCollapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center rounded-md py-2 text-sm font-medium transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isCollapsed ? 'justify-center px-2' : 'gap-3 px-3',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!isCollapsed && label}
          </NavLink>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className={cn('px-2 pb-1', isCollapsed ? 'flex justify-center' : '')}>
        <button
          onClick={toggleCollapsed}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex w-full items-center rounded-md p-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
            isCollapsed ? 'justify-center' : 'gap-2',
          )}
        >
          {isCollapsed ? (
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
      <div className={cn('border-t border-border py-4', isCollapsed ? 'px-2' : 'px-5')}>
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-3">
            <Boxes
              className={cn(
                'h-3.5 w-3.5',
                status?.ollamaState === 'connected' ? 'text-emerald-400' : 'text-red-400',
              )}
              title={status?.ollamaState === 'connected' ? 'Ollama: Connected' : 'Ollama: Disconnected'}
            />
            <BrainCircuit
              className={cn(
                'h-3.5 w-3.5',
                !status?.cloudUrl
                  ? 'text-muted-foreground/30'
                  : status.cloudConnected
                    ? 'text-emerald-400'
                    : 'text-red-400',
              )}
              title={
                !status?.cloudUrl
                  ? 'Cloud memories: not configured'
                  : status.cloudConnected
                    ? 'Cloud memories: connected'
                    : 'Cloud memories: offline'
              }
            />
            <FileStack
              className="h-3.5 w-3.5 text-muted-foreground/60"
              title={`Indexed files: ${status?.totalIndexedFiles?.toLocaleString() ?? '—'}`}
            />
            <Clock
              className="h-3.5 w-3.5 text-muted-foreground/60"
              title={`Uptime: ${status ? formatUptime(status.uptimeSeconds) : '—'}`}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Boxes className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  status?.ollamaState === 'connected' ? 'text-emerald-400' : 'text-red-400',
                )} />
                Ollama
              </span>
              <span>{status?.ollamaState === 'connected' ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <BrainCircuit className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  !status?.cloudUrl
                    ? 'text-muted-foreground/30'
                    : status.cloudConnected
                      ? 'text-emerald-400'
                      : 'text-red-400',
                )} />
                Cloud memories
              </span>
              <span>
                {status?.cloudUrl
                  ? status.cloudConnected ? 'Connected' : 'Offline'
                  : <span className="text-muted-foreground/50">Not configured</span>}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <FileStack className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                Indexed files
              </span>
              <span className="text-foreground">
                {status?.totalIndexedFiles?.toLocaleString() ?? '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                Uptime
              </span>
              <span className="text-foreground">
                {status ? formatUptime(status.uptimeSeconds) : '—'}
              </span>
            </div>
            {version && (
              <div className="mt-1 text-muted-foreground/50">
                v{version}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
