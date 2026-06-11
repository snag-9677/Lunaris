import { Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { extractCost, extractModel, extractTool, fmtTime, nsColorClass } from '../../lib/feed';
import type { FeedEvent } from '../../lib/types';

function FeedRow({ ev }: { ev: FeedEvent }) {
  const ns = ev.kind.split('.')[0] ?? 'event';
  const model = extractModel(ev.payload);
  const tool = extractTool(ev.payload, ev.kind);
  const cost = extractCost(ev.payload);
  return (
    <div className="flex items-baseline gap-2 overflow-hidden border-b border-border/40 px-4 py-1.5 text-xs">
      <Badge variant="outline" className={`shrink-0 font-mono ${nsColorClass(ns)}`}>
        {ev.kind}
      </Badge>
      <span className="shrink-0 font-mono text-muted-foreground">{fmtTime(ev.ts)}</span>
      {model && <span className="truncate font-mono text-info">{model}</span>}
      {tool && <span className="truncate font-mono text-warning">{tool}</span>}
      {cost !== undefined && <span className="shrink-0 font-mono text-success">${cost.toFixed(4)}</span>}
      {ev.taskId && <span className="shrink-0 font-mono text-muted-foreground">{ev.taskId.slice(0, 8)}</span>}
      <span className="ml-auto shrink-0 truncate font-mono text-muted-foreground">{ev.projectId}</span>
    </div>
  );
}

export function ActivityView({ events }: { events: FeedEvent[] }) {
  return (
    <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 py-20 text-center text-muted-foreground">
          <Activity className="h-6 w-6 opacity-50" />
          <p className="text-sm">Waiting for events…</p>
        </div>
      ) : (
        <div className="py-1">
          {events.map((ev) => (
            <FeedRow key={ev.eventId} ev={ev} />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
