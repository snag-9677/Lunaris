import { Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginGate({
  user,
  password,
  error,
  setUser,
  setPassword,
  onSubmit,
}: {
  user: string;
  password: string;
  error?: string;
  setUser: (v: string) => void;
  setPassword: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Moon className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">Lunaris</div>
              <div className="text-xs text-muted-foreground">Mission Control</div>
            </div>
          </div>
          <CardTitle className="pt-2">Sign in</CardTitle>
          <CardDescription>Authentication is enabled on this daemon.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-user">User</Label>
              <Input
                id="login-user"
                type="text"
                value={user}
                autoComplete="username"
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <Button type="submit" disabled={user.trim().length === 0}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
