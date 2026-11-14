-- =====================================================================
-- Commons – database setup. Run once in Supabase > SQL Editor > New query.
-- Safe to run again (it will not duplicate or break anything).
-- =====================================================================

-- ---------- TABLES ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    text unique not null check (char_length(username) between 3 and 15),
  role        text not null default 'member'
              check (role in ('member', 'moderator', 'admin')),
  created_at  timestamptz not null default now()
);

create table if not exists public.rooms (
  id          bigint generated always as identity primary key,
  name        text unique not null,
  description text
);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  room_id     bigint not null references public.rooms(id) on delete cascade,
  user_id     uuid   not null references public.profiles(id),
  content     text   not null check (char_length(content) between 1 and 1000),
  deleted     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists messages_room_time_idx
  on public.messages (room_id, created_at);

-- ---------- AUTO-CREATE A PROFILE ON REGISTRATION ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- ROW LEVEL SECURITY (who may do what) ----------
alter table public.profiles enable row level security;
alter table public.rooms    enable row level security;
alter table public.messages enable row level security;

drop policy if exists "read profiles"  on public.profiles;
drop policy if exists "read rooms"     on public.rooms;
drop policy if exists "read messages"  on public.messages;
drop policy if exists "send own messages" on public.messages;
drop policy if exists "moderators remove messages" on public.messages;

-- Only logged-in users can read anything
create policy "read profiles" on public.profiles
  for select to authenticated using (true);

create policy "read rooms" on public.rooms
  for select to authenticated using (true);

create policy "read messages" on public.messages
  for select to authenticated using (true);

-- You can only post as yourself, and never as already-deleted
create policy "send own messages" on public.messages
  for insert to authenticated
  with check (auth.uid() = user_id and deleted = false);

-- Only moderators/admins can update messages...
create policy "moderators remove messages" on public.messages
  for update to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('moderator', 'admin')
  ));

-- ...and even they can change only the "deleted" column
revoke update on public.messages from authenticated;
grant  update (deleted) on public.messages to authenticated;

-- (No delete policy and no profile-update policy exist, so those are blocked.)

-- ---------- REALTIME ----------
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

-- ---------- STARTER ROOMS ----------
insert into public.rooms (name, description) values
  ('general',   'Talk about anything'),
  ('help',      'Ask questions, get answers'),
  ('projects',  'Share what you are building'),
  ('off-topic', 'Everything else')
on conflict (name) do nothing;

-- =====================================================================
-- AFTER you register your first account (Part 4), run this line in a
-- new query to make yourself a moderator. Replace YOUR_USERNAME.
--
--   update public.profiles set role = 'admin' where username = 'YOUR_USERNAME';
-- =====================================================================

alter table public.rooms
  add column if not exists created_by uuid references public.profiles(id) default auth.uid();

alter table public.rooms drop constraint if exists rooms_name_format;
alter table public.rooms add constraint rooms_name_format check (name ~ '^[a-z0-9-]{2,24}$');

alter table public.rooms drop constraint if exists rooms_desc_len;
alter table public.rooms add constraint rooms_desc_len
  check (description is null or char_length(description) <= 80);

drop policy if exists "create rooms" on public.rooms;
create policy "create rooms" on public.rooms
  for insert to authenticated with check (created_by = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;

-- ---------- Profile photos ----------
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles drop constraint if exists profiles_avatar_url_https;
alter table public.profiles add constraint profiles_avatar_url_https
  check (avatar_url is null or avatar_url ~ '^https://');

-- users may update ONLY their own avatar_url (role stays protected)
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (avatar_url) on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists "avatars read" on storage.objects;
drop policy if exists "avatars insert own" on storage.objects;
drop policy if exists "avatars update own" on storage.objects;
drop policy if exists "avatars delete own" on storage.objects;

create policy "avatars read" on storage.objects
  for select to public using (bucket_id = 'avatars');
create policy "avatars insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

-- ---------- Admin: delete messages ----------
grant delete on public.messages to authenticated;
drop policy if exists "admins delete messages" on public.messages;
create policy "admins delete messages" on public.messages
  for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
-- =====================================================================
-- Delete rooms (earlier step) + PUBLIC / PRIVATE rooms with invitations
-- =====================================================================
alter table public.rooms add column if not exists kind text not null default 'public';
alter table public.rooms drop constraint if exists rooms_kind_check;
alter table public.rooms add constraint rooms_kind_check check (kind in ('public','private'));

create table if not exists public.room_members (
  room_id   bigint not null references public.rooms(id) on delete cascade,
  user_id   uuid   not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create table if not exists public.room_invites (
  id           bigint generated always as identity primary key,
  room_id      bigint not null references public.rooms(id) on delete cascade,
  invited_user uuid   not null references public.profiles(id) on delete cascade,
  invited_by   uuid   not null references public.profiles(id) default auth.uid(),
  status       text   not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at   timestamptz not null default now()
);
create unique index if not exists room_invites_one_pending
  on public.room_invites (room_id, invited_user) where status = 'pending';

-- helpers (security definer = they can look things up without recursion)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;

create or replace function public.room_member(rid bigint, uid uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from room_members where room_id = rid and user_id = uid) $$;

create or replace function public.has_invite(rid bigint) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from room_invites where room_id = rid and invited_user = auth.uid() and status = 'pending') $$;

create or replace function public.can_access_room(rid bigint) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from rooms r where r.id = rid and
     (r.kind = 'public' or exists (select 1 from room_members m where m.room_id = r.id and m.user_id = auth.uid()))) $$;

-- the Coordinator (creator) is automatically a member
create or replace function public.add_creator_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'private' and new.created_by is not null then
    insert into room_members (room_id, user_id) values (new.id, new.created_by) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists on_private_room_created on public.rooms;
create trigger on_private_room_created after insert on public.rooms
  for each row execute function public.add_creator_member();

-- accepting an invitation (only the invited person can call it)
create or replace function public.accept_invite(invite_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare inv room_invites;
begin
  select * into inv from room_invites where id = invite_id and invited_user = auth.uid() and status = 'pending';
  if not found then raise exception 'Invitation not found'; end if;
  insert into room_members (room_id, user_id) values (inv.room_id, auth.uid()) on conflict do nothing;
  update room_invites set status = 'accepted' where id = invite_id;
end $$;
grant execute on function public.accept_invite(bigint) to authenticated;

-- ROOMS: public = admin creates/deletes; private = anyone creates, only Coordinator deletes
alter table public.room_members enable row level security;
alter table public.room_invites enable row level security;
drop policy if exists "read rooms" on public.rooms;
drop policy if exists "create rooms" on public.rooms;
drop policy if exists "delete rooms" on public.rooms;
create policy "read rooms" on public.rooms for select to authenticated
  using (kind = 'public' or created_by = auth.uid() or room_member(id, auth.uid()) or has_invite(id));
create policy "create rooms" on public.rooms for insert to authenticated
  with check ((kind = 'public' and is_admin()) or (kind = 'private' and created_by = auth.uid()));
create policy "delete rooms" on public.rooms for delete to authenticated
  using ((kind = 'public' and is_admin()) or (kind = 'private' and created_by = auth.uid()));
grant delete on public.rooms to authenticated;

-- MEMBERS: members can see who is in their group
drop policy if exists "read members" on public.room_members;
create policy "read members" on public.room_members for select to authenticated
  using (room_member(room_id, auth.uid()));

-- INVITES: Coordinator sends; the invited person sees, accepts (rpc) or declines
drop policy if exists "read invites" on public.room_invites;
drop policy if exists "send invites" on public.room_invites;
drop policy if exists "decline invites" on public.room_invites;
drop policy if exists "cancel invites" on public.room_invites;
create policy "read invites" on public.room_invites for select to authenticated
  using (invited_user = auth.uid() or invited_by = auth.uid());
create policy "send invites" on public.room_invites for insert to authenticated
  with check (invited_by = auth.uid()
    and exists (select 1 from rooms r where r.id = room_id and r.kind = 'private' and r.created_by = auth.uid())
    and not room_member(room_id, invited_user));
create policy "decline invites" on public.room_invites for update to authenticated
  using (invited_user = auth.uid()) with check (invited_user = auth.uid() and status = 'declined');
create policy "cancel invites" on public.room_invites for delete to authenticated
  using (invited_by = auth.uid());
grant select on public.room_members to authenticated;
grant select, insert, delete on public.room_invites to authenticated;
revoke update on public.room_invites from authenticated;
grant update (status) on public.room_invites to authenticated;

-- MESSAGES: only people who can access the room can read/post
drop policy if exists "read messages" on public.messages;
drop policy if exists "send own messages" on public.messages;
drop policy if exists "moderators remove messages" on public.messages;
drop policy if exists "admins delete messages" on public.messages;
create policy "read messages" on public.messages for select to authenticated
  using (can_access_room(room_id));
create policy "send own messages" on public.messages for insert to authenticated
  with check (auth.uid() = user_id and deleted = false and can_access_room(room_id));
create policy "moderators remove messages" on public.messages for update to authenticated
  using (can_access_room(room_id) and exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('moderator','admin')));
create policy "admins delete messages" on public.messages for delete to authenticated
  using (is_admin() and exists (select 1 from rooms r where r.id = room_id and r.kind = 'public'));

do $$ begin alter publication supabase_realtime add table public.room_invites;
exception when duplicate_object then null; end $$;

-- =====================================================================
-- Users can delete their OWN message within 10 minutes of sending it
-- =====================================================================
alter table public.messages add column if not exists deleted_by uuid references public.profiles(id);
revoke update on public.messages from authenticated;
grant update (deleted, deleted_by) on public.messages to authenticated;
drop policy if exists "delete own recent messages" on public.messages;
create policy "delete own recent messages" on public.messages for update to authenticated
  using (user_id = auth.uid() and deleted = false
         and created_at > now() - interval '10 minutes' and can_access_room(room_id))
  with check (user_id = auth.uid() and deleted = true and deleted_by = auth.uid());
