import { useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { fmtTime } from '../../lib/feed';
import type { ChatEntry } from '../../lib/types';

export function ChatView({
  transcript,
  input,
  setInput,
  onSend,
  canSend,
}: {
  transcript: ChatEntry[];
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  canSend: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom as new turns arrive.
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, transcript[transcript.length - 1]?.text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
          {transcript.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-1 py-20 text-center text-muted-foreground">
              <p className="text-sm">No messages yet.</p>
              <p className="text-xs">Describe a goal below to get started.</p>
            </div>
          )}
          {transcript.map((m) => (
            <div
              key={m.id}
              className={cn(
                'flex flex-col gap-1',
                m.role === 'user' ? 'items-end' : 'items-start',
              )}
            >
              <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                <span className={m.role === 'user' ? 'text-info' : 'text-primary'}>{m.role}</span>
                <span>{fmtTime(m.ts)}</span>
              </div>
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border px-3.5 py-2 text-sm shadow-sm',
                  m.role === 'user'
                    ? 'rounded-br-sm border-primary/30 bg-primary/10'
                    : 'rounded-bl-sm border-border bg-card',
                  m.pending && 'animate-pulse text-warning',
                )}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      <form
        className="border-t border-border bg-card/50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            placeholder={canSend ? 'Describe a goal…  (⌘/Ctrl+Enter to send)' : 'Select a project first'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSend}
            rows={2}
            className="resize-none"
          />
          <Button type="submit" disabled={!canSend || input.trim().length === 0} className="h-[60px]">
            <Send /> Send
          </Button>
        </div>
      </form>
    </div>
  );
}
