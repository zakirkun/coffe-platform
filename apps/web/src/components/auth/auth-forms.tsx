'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { queryKeys } from '@/lib/queries/keys';

const SignInValues = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type SignInValues = z.infer<typeof SignInValues>;

const SignUpValues = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
});
type SignUpValues = z.infer<typeof SignUpValues>;

/** Only same-app paths are followed after signing in (no open redirects). */
function safeNext(next: string | null): string | null {
  return next?.startsWith('/') && !next.startsWith('//') ? next : null;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

export function SignInForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const form = useForm<SignInValues>({ resolver: zodResolver(SignInValues), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const { error } = await authClient.signIn.email(values);
    if (error) {
      setFailure(error.message ?? 'Signing in failed.');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    router.replace(next ?? '/');
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby="email-error" {...form.register('email')} />
            <FieldError id="email-error" message={errors.email?.message} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" aria-invalid={Boolean(errors.password)} aria-describedby="password-error" {...form.register('password')} />
            <FieldError id="password-error" message={errors.password?.message} />
          </div>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-sm text-muted-foreground">
            New here?{' '}
            <Link className="underline underline-offset-4" href={next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'}>
              Create an account
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const form = useForm<SignUpValues>({
    resolver: zodResolver(SignUpValues),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    const { error } = await authClient.signUp.email(values);
    if (error) {
      setFailure(error.message ?? 'Creating the account failed.');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    // An invitation link brings its own workspace; everyone else creates one first.
    router.replace(next ?? '/onboarding');
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Then create a workspace for your team.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" autoComplete="name" aria-invalid={Boolean(errors.name)} aria-describedby="name-error" {...form.register('name')} />
            <FieldError id="name-error" message={errors.name?.message} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby="email-error" {...form.register('email')} />
            <FieldError id="email-error" message={errors.email?.message} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} aria-describedby="password-error" {...form.register('password')} />
            <FieldError id="password-error" message={errors.password?.message} />
          </div>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link className="underline underline-offset-4" href={next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'}>
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
