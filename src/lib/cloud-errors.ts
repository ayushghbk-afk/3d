export function cloudErrorMessage(error: unknown): string {
  const e = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (e?.code === 'PGRST205' || e?.code === '42P01' || e?.code === 'PGRST202' || e?.code === 'PGRST204' || e?.code === '42703') {
    return 'Supabase database setup is incomplete. Run all SQL migrations in supabase/migrations in filename order (see docs/DEPLOYMENT.md), then retry. Your local projects are safe.';
  }
  // .single() on a query RLS filtered to zero rows (not a member, deleted
  // project, or a bad id) — the old wording here was a bare "Project not found".
  if (e?.code === 'PGRST116') {
    return 'Project not found — or your account does not have access. If you were invited, open the invite link to join first, or ask the owner for a new invite.';
  }
  if (e?.code === '42501') {
    return 'Supabase denied access. Check your project role and that all database/storage policies are installed. Your changes remain on this device.';
  }
  if (!e?.message) return 'Could not reach Supabase. Check your connection and project settings, then retry.';
  // Keep the server's own specifics: a bare "Failed to fetch" or "invalid input
  // syntax for type uuid" is the only clue anyone has when a save fails.
  const extras = [e.details, e.hint].map((s) => (s ?? '').trim()).filter(Boolean);
  return extras.length ? `${e.message} (${extras.join(' · ')})` : e.message;
}
