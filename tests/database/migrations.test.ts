import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { setupSql } from '../../scripts/generate-supabase-setup.mjs';

// Real PostgreSQL (WASM), with only the managed auth/storage/realtime primitives
// stubbed. This catches forward references, RLS recursion, grants and policy SQL.
let db: PGlite;
const owner = '00000000-0000-4000-8000-000000000001';
const editor = '00000000-0000-4000-8000-000000000002';
const viewer = '00000000-0000-4000-8000-000000000003';
const outsider = '00000000-0000-4000-8000-000000000004';
const project = '10000000-0000-4000-8000-000000000001';
const asset = '20000000-0000-4000-8000-000000000001';
const migrations = new URL('../../supabase/migrations/', import.meta.url);

async function asUser(id: string) {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', true);`);
}
async function topic(value = `project:${project}`) {
  await db.query("select set_config('realtime.topic', $1, true)", [value]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create schema storage;
    create schema realtime;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create table storage.buckets (id text primary key, name text not null, public boolean default false);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets(id), name text not null,
      unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    create table realtime.messages (
      id uuid primary key default gen_random_uuid(), extension text not null, payload jsonb
    );
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$
      select current_setting('realtime.topic', true);
    $$;
    grant usage on schema auth, storage, realtime to anon, authenticated;
    grant select, insert, update, delete on storage.objects, realtime.messages to anon, authenticated;
  `);
  const sql = await readFile(new URL('../../supabase/setup.sql', import.meta.url), 'utf8');
  // Keep the one-paste SQL editor setup identical to the canonical migrations.
  expect(sql).toBe(await setupSql());
  await db.exec(sql);
  await db.exec(`
    insert into auth.users(id) values ('${owner}'), ('${editor}'), ('${viewer}'), ('${outsider}');
    insert into public.profiles(id, display_name) values ('${owner}', 'Owner'), ('${editor}', 'Editor'), ('${viewer}', 'Viewer');
    insert into public.projects(id, owner_id, invite_code) values ('${project}', '${owner}', 'correct-code');
    insert into public.project_members(project_id, user_id, role) values
      ('${project}', '${owner}', 'owner'), ('${project}', '${editor}', 'editor'), ('${project}', '${viewer}', 'viewer');
    insert into public.assets(id, project_id, name) values ('${asset}', '${project}', 'model.glb');
  `);
});
beforeEach(async () => { await db.exec('begin;'); });
afterEach(async () => { await db.exec('rollback; reset role;'); });
afterAll(async () => { await db?.close(); });

describe('fresh schema and RLS', () => {
  it('creates all fifteen public tables with RLS enabled', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class join pg_namespace n on n.oid = relnamespace where n.nspname = 'public' and relkind = 'r'",
    );
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
  });
  it('lets owners create a project, owner membership, scene and profile', async () => {
    await asUser(owner);
    const { rows } = await db.query<{ id: string }>("insert into public.projects(name, owner_id) values ('New', auth.uid()) returning id");
    await db.query("insert into public.project_members(project_id,user_id,role) values ($1,auth.uid(),'owner')", [rows[0].id]);
    await db.query('insert into public.scenes(project_id) values ($1)', [rows[0].id]);
    await db.exec("insert into public.profiles(id,display_name) values (auth.uid(),'Updated') on conflict (id) do update set display_name = excluded.display_name;");
  });
  it('reads membership and teammate profiles without recursive policy errors', async () => {
    await asUser(editor);
    expect((await db.query('select * from public.project_members')).rows).toHaveLength(3);
    expect((await db.query('select * from public.profiles')).rows).toHaveLength(3);
  });
  it('hides projects from unrelated authenticated users', async () => {
    await asUser(outsider);
    expect((await db.query('select * from public.projects')).rows).toHaveLength(0);
    expect((await db.query('select * from public.assets')).rows).toHaveLength(0);
  });
  it('allows editor changes but gives viewers read-only access', async () => {
    await asUser(editor);
    expect((await db.query("update public.projects set name = 'Edited' returning id")).rows).toHaveLength(1);
    await asUser(viewer);
    expect((await db.query("update public.projects set name = 'Denied' returning id")).rows).toHaveLength(0);
    expect((await db.query('select * from public.projects')).rows).toHaveLength(1);
  });
  it('does not let editors take project ownership', async () => {
    await asUser(editor);
    await expect(db.query('update public.projects set owner_id = auth.uid() where id = $1', [project])).rejects.toThrow(/ownership/);
  });
  it('does not let editors rotate admin invite codes', async () => {
    await asUser(editor);
    await expect(db.query("update public.projects set invite_code = 'hijacked' where id = $1", [project])).rejects.toThrow(/owners and admins/);
  });
  it('treats the actual owner as owner even with a stale membership role', async () => {
    await db.exec(`update public.project_members set role = 'viewer' where user_id = '${owner}';`);
    await asUser(owner);
    expect((await db.query<{ role: string }>('select public.project_role($1) as role', [project])).rows[0].role).toBe('owner');
  });
  it('can safely rerun the additive repair migration', async () => {
    await db.exec(await readFile(new URL('20260908000003_cloud_repairs.sql', migrations), 'utf8'));
    expect((await db.query('select * from public.projects')).rows).toHaveLength(1);
  });
});

describe('invites', () => {
  it.each([null, '', 'wrong-code'])('rejects missing/invalid code %s', async (code) => {
    await asUser(outsider);
    await expect(db.query('select public.join_project($1, $2)', [project, code])).rejects.toThrow(/Invalid invite code/);
  });
  it('joins with a valid code as viewer and does not demote existing members', async () => {
    await asUser(outsider);
    await db.query('select public.join_project($1, $2)', [project, 'correct-code']);
    expect((await db.query<{ role: string }>('select public.project_role($1) as role', [project])).rows[0].role).toBe('viewer');
    await asUser(editor);
    await db.query('select public.join_project($1, $2)', [project, 'correct-code']);
    expect((await db.query<{ role: string }>('select public.project_role($1) as role', [project])).rows[0].role).toBe('editor');
  });
  it('does not allow anonymous joins', async () => {
    await db.exec('set role anon;');
    await expect(db.query('select public.join_project($1, $2)', [project, 'correct-code'])).rejects.toThrow(/permission denied/);
  });
});

describe('upserts and private Realtime', () => {
  it.each(['assets', 'thumbnails'])('lets editors upload and overwrite %s without opening writes to outsiders', async (bucket) => {
    await asUser(editor);
    const path = `${project}/file`;
    await db.query('insert into storage.objects(bucket_id,name) values ($1,$2)', [bucket, path]);
    expect((await db.query('update storage.objects set name = name where bucket_id = $1 returning id', [bucket])).rows).toHaveLength(1);
    await asUser(outsider);
    expect((await db.query('update storage.objects set name = name where bucket_id = $1 returning id', [bucket])).rows).toHaveLength(0);
  });
  it('allows existing asset metadata to be upserted', async () => {
    await asUser(editor);
    const result = await db.query('insert into public.assets(id,project_id,name) values ($1,$2,$3) on conflict (id) do update set name = excluded.name returning name', [asset, project, 'updated.glb']);
    expect(result.rows).toEqual([{ name: 'updated.glb' }]);
  });
  it('lets editors broadcast and members read, but not outsiders', async () => {
    await asUser(editor);
    await topic();
    await db.exec("insert into realtime.messages(extension) values ('broadcast');");
    await asUser(viewer);
    expect((await db.query('select * from realtime.messages')).rows).toHaveLength(1);
    await asUser(outsider);
    expect((await db.query('select * from realtime.messages')).rows).toHaveLength(0);
  });
  it('lets viewers track presence but not broadcast edits', async () => {
    await asUser(viewer);
    await topic();
    await db.exec("insert into realtime.messages(extension) values ('presence');");
    await expect(db.exec("insert into realtime.messages(extension) values ('broadcast');")).rejects.toThrow(/row-level security/);
  });
  it('handles malformed channel topics without a UUID cast failure', async () => {
    await asUser(editor);
    await topic('project:not-a-uuid');
    expect((await db.query('select * from realtime.messages')).rows).toHaveLength(0);
    expect((await db.query('select public.realtime_project_id($1) as id', ['project:bad'])).rows).toEqual([{ id: null }]);
  });
});
