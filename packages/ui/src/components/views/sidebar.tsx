import {
  Activity,
  BarChart3,
  CalendarClock,
  LogOut,
  MessageSquare,
  Moon,
  Network,
  Puzzle,
  Server,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { Project, WsStatus } from '../../lib/types';

export type ViewId =
  | 'chat'
  | 'activity'
  | 'memory'
  | 'analytics'
  | 'approvals'
  | 'optimize'
  | 'plugins'
  | 'automation'
  | 'system';

export const NAV_ITEMS: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'memory', label: 'Memory', icon: Network },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'optimize', label: 'Optimize', icon: Sparkles },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'automation', label: 'Automation', icon: CalendarClock },
  { id: 'system', label: 'System', icon: Server },
];

const WS_DOT: Record<WsStatus, string> = {
  open: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  closed: 'bg-destructive',
};

export function Sidebar({
  view,
  onViewChange,
  projects,
  selectedId,
  onSelectProject,
  wsStatus,
  pendingApprovals,
  authMode,
  authed,
  principalName,
  principalRole,
  onLogout,
}: {
  view: ViewId;
  onViewChange: (v: ViewId) => void;
  projects: Project[];
  selectedId: string;
  onSelectProject: (id: string) => void;
  wsStatus: WsStatus;
  pendingApprovals: number;
  authMode: 'off' | 'on' | 'unknown';
  authed: boolean;
  principalName?: string;
  principalRole: string | null;
  onLogout: () => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary/15 text-sidebar-primary">
          <Moon className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">Lunaris</div>
          <div className="text-xs text-muted-foreground">Mission Control</div>
        </div>
      </div>

      {/* Project switcher */}
      <div className="px-3 pb-2">
        <Select value={selectedId} onValueChange={onSelectProject}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={projects.length ? 'Select project' : 'No projects'} />
          </SelectTrigger>
          <SelectContent>
            {projects.length === 0 && (
              <SelectItem value="__none__" disabled>
                No projects
              </SelectItem>
            )}
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          const showBadge = item.id === 'approvals' && pendingApprovals > 0;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onViewChange(item.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{item.label}</span>
              {showBadge && (
                <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                  {pendingApprovals}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Footer: WS status + principal */}
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', WS_DOT[wsStatus])} title={`websocket: ${wsStatus}`} />
          <span className="capitalize">{wsStatus}</span>
        </div>
        {authMode === 'on' && authed && principalName && (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{principalName}</div>
              {principalRole && <div className="truncate text-[11px] text-muted-foreground">{principalRole}</div>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onLogout} title="Sign out">
              <LogOut />
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
