export function cloudErrorMessage(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  if (e?.code === 'PGRST205' || e?.code === '42P01' || e?.code === 'PGRST202' || e?.code === 'PGRST204' || e?.code === '42703') {
    return 'Supabase database setup is incomplete. Run all SQL migrations in supabase/migrations in filename order (see docs/DEPLOYMENT.md), then retry. Your local projects are safe.';
  }
  if (e?.code === '42501') {
    return 'Supabase denied access. Check your project role and that all database/storage policies are installed. Your changes remain on this device.';
  }
  return e?.message || 'Could not reach Supabase. Check your connection and project settings, then retry.';
}
