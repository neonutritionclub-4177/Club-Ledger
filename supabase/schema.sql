create table if not exists public.clubs (
  id text primary key,
  name text not null,
  approved boolean not null default false,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.club_owners (
  club_id text not null references public.clubs(id) on delete cascade,
  owner_uid text not null,
  owner_name text not null default '',
  mobile text not null default '',
  created_at timestamptz not null default now(),
  primary key (club_id, owner_uid)
);

alter table public.club_owners add column if not exists owner_name text not null default '';
alter table public.club_owners add column if not exists mobile text not null default '';

create table if not exists public.club_ledgers (
  club_id text primary key references public.clubs(id) on delete cascade,
  ledger jsonb not null default '{"customers":[],"orders":[],"lastModified":0}'::jsonb,
  updated_at bigint not null default 0
);

create table if not exists public.owner_requests (
  user_uid text primary key,
  owner_name text not null,
  club_name text not null,
  mobile text not null,
  email text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  reviewed_at bigint,
  archived boolean not null default false,
  archived_at bigint
);

alter table public.owner_requests add column if not exists email text not null default '';
alter table public.owner_requests add column if not exists archived boolean not null default false;
alter table public.owner_requests add column if not exists archived_at bigint;
alter table public.owner_requests drop constraint if exists owner_requests_status_check;
alter table public.owner_requests add constraint owner_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'revoked'));

create index if not exists owner_requests_history_idx
  on public.owner_requests (archived, created_at desc);

create or replace function public.create_owner_request_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_name_value text := nullif(btrim(new.raw_user_meta_data ->> 'owner_name'), '');
  club_name_value text := nullif(btrim(new.raw_user_meta_data ->> 'club_name'), '');
  mobile_value text := nullif(regexp_replace(coalesce(new.raw_user_meta_data ->> 'mobile', ''), '[^0-9]', '', 'g'), '');
begin
  if new.raw_user_meta_data ->> 'role' is distinct from 'owner' then
    return new;
  end if;

  if owner_name_value is null or club_name_value is null
      or mobile_value is null or coalesce(new.email, '') = '' then
    raise exception 'Owner signup requires an email, owner name, club name, and mobile number';
  end if;

  insert into public.owner_requests (
    user_uid, owner_name, club_name, mobile, email, status
  ) values (
    new.id::text, owner_name_value, club_name_value, mobile_value,
    lower(new.email), 'pending'
  )
  on conflict (user_uid) do nothing;

  return new;
end;
$$;

revoke all on function public.create_owner_request_from_auth() from public, anon, authenticated;

drop trigger if exists create_owner_request_after_auth_signup on auth.users;
create trigger create_owner_request_after_auth_signup
  after insert on auth.users
  for each row execute function public.create_owner_request_from_auth();

create table if not exists public.customer_registrations (
  user_uid text primary key,
  club_id text not null references public.clubs(id) on delete cascade,
  customer_name text not null,
  mobile text not null,
  email text not null default '',
  status text not null default 'pending' check (status in ('pending', 'linked', 'rejected')),
  linked_customer_id text,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (club_id, mobile)
);

alter table public.customer_registrations add column if not exists email text not null default '';

create table if not exists public.customer_portals (
  customer_uid text primary key,
  club_id text not null references public.clubs(id) on delete cascade,
  portal jsonb not null,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.platform_admins (
  user_uid text primary key,
  created_at timestamptz not null default now()
);

create index if not exists owner_requests_pending_created_idx
  on public.owner_requests (status, created_at);
create index if not exists customer_registrations_club_status_idx
  on public.customer_registrations (club_id, status, created_at);

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_uid = auth.uid()::text
  );
$$;

create or replace function public.is_club_owner(target_club_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.club_owners
    where club_id = target_club_id
      and owner_uid = auth.uid()::text
  );
$$;

create or replace function public.is_club_customer(target_customer_uid text, target_club_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_club_owner(target_club_id) and exists (
    select 1
    from public.customer_registrations
    where user_uid = target_customer_uid
      and club_id = target_club_id
  );
$$;

create or replace function public.review_owner_request(request_uid text, approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.owner_requests%rowtype;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access is required' using errcode = '42501';
  end if;

  select *
    into request_row
    from public.owner_requests
    where user_uid = request_uid
    for update;

  if not found then
    raise exception 'Owner request not found' using errcode = 'P0002';
  end if;
  if request_row.status <> 'pending' then
    raise exception 'Owner request is no longer pending' using errcode = 'P0001';
  end if;

  if approve then
    insert into public.clubs (id, name, approved, created_at)
    values (request_uid, request_row.club_name, true, now_ms)
    on conflict (id) do update set name = excluded.name, approved = true;

    insert into public.club_owners (club_id, owner_uid, owner_name, mobile)
    values (request_uid, request_uid, request_row.owner_name, request_row.mobile)
    on conflict (club_id, owner_uid) do update
      set owner_name = excluded.owner_name, mobile = excluded.mobile;

    insert into public.club_ledgers (club_id)
    values (request_uid)
    on conflict (club_id) do nothing;

    update public.owner_requests
      set status = 'approved', reviewed_at = now_ms
      where user_uid = request_uid;
  else
    update public.owner_requests
      set status = 'rejected', reviewed_at = now_ms
      where user_uid = request_uid;
  end if;

  return jsonb_build_object('user_uid', request_uid, 'status', case when approve then 'approved' else 'rejected' end);
end;
$$;

create or replace function public.set_owner_request_archived(request_uid text, archive_request boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access is required' using errcode = '42501';
  end if;

  update public.owner_requests
    set archived = archive_request,
        archived_at = case when archive_request
          then (extract(epoch from clock_timestamp()) * 1000)::bigint
          else null
        end
    where user_uid = request_uid;

  if not found then
    raise exception 'Owner request not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.set_owner_access(request_uid text, restore_access boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.owner_requests%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access is required' using errcode = '42501';
  end if;

  select * into request_row
    from public.owner_requests
    where user_uid = request_uid
    for update;

  if not found then
    raise exception 'Owner request not found' using errcode = 'P0002';
  end if;

  if restore_access and request_row.status <> 'revoked' then
    raise exception 'Only a revoked owner can be restored' using errcode = 'P0001';
  elsif not restore_access and request_row.status <> 'approved' then
    raise exception 'Only an approved owner can be revoked' using errcode = 'P0001';
  end if;

  if restore_access then
    update public.clubs set approved = true, name = request_row.club_name
      where id = request_uid;
    insert into public.club_owners (club_id, owner_uid, owner_name, mobile)
      values (request_uid, request_uid, request_row.owner_name, request_row.mobile)
      on conflict (club_id, owner_uid) do update
        set owner_name = excluded.owner_name, mobile = excluded.mobile;
    update public.owner_requests
      set status = 'approved',
          reviewed_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
      where user_uid = request_uid;
  else
    update public.clubs set approved = false where id = request_uid;
    delete from public.club_owners
      where club_id = request_uid and owner_uid = request_uid;
    update public.owner_requests
      set status = 'revoked',
          reviewed_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
      where user_uid = request_uid;
  end if;
end;
$$;

create or replace function public.admin_update_owner_details(
  actor_uid text,
  request_uid text,
  new_owner_name text,
  new_club_name text,
  new_mobile text,
  new_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.owner_requests%rowtype;
begin
  if not exists (
    select 1 from public.platform_admins where user_uid = actor_uid
  ) then
    raise exception 'Platform administrator access is required' using errcode = '42501';
  end if;

  select * into request_row from public.owner_requests
    where user_uid = request_uid for update;
  if not found then
    raise exception 'Owner request not found' using errcode = 'P0002';
  end if;

  update public.owner_requests
    set owner_name = new_owner_name,
        club_name = new_club_name,
        mobile = new_mobile,
        email = lower(new_email)
    where user_uid = request_uid;

  if request_row.status in ('approved', 'revoked') then
    update public.clubs set name = new_club_name where id = request_uid;
    update public.club_owners
      set owner_name = new_owner_name, mobile = new_mobile
      where club_id = request_uid and owner_uid = request_uid;
  end if;
end;
$$;

create or replace function public.permanently_delete_customer(
  target_club_id text,
  target_customer_id text,
  actor_uid text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ledger_value jsonb;
  customer_value jsonb;
  linked_customer_uid text;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if not exists (
    select 1 from public.club_owners
    where club_id = target_club_id and owner_uid = actor_uid
  ) then
    raise exception 'Club owner access is required' using errcode = '42501';
  end if;

  select ledger into ledger_value
    from public.club_ledgers
    where club_id = target_club_id
    for update;
  if not found then
    return jsonb_build_object('customer_uid', null, 'removed', false);
  end if;

  select entry into customer_value
    from jsonb_array_elements(coalesce(ledger_value -> 'customers', '[]'::jsonb)) as entries(entry)
    where entry ->> 'id' = target_customer_id
    limit 1;
  if customer_value is null then
    return jsonb_build_object('customer_uid', null, 'removed', false);
  end if;
  if coalesce(customer_value ->> 'deleted', 'false') <> 'true' then
    raise exception 'Move the customer to Deleted before permanent removal' using errcode = 'P0001';
  end if;

  linked_customer_uid := customer_value #>> '{login,uid}';
  if linked_customer_uid is not null then
    delete from public.customer_portals as portals
      where portals.customer_uid = linked_customer_uid
        and portals.club_id = target_club_id;
  end if;
  delete from public.customer_registrations
    where club_id = target_club_id
      and (
        linked_customer_id = target_customer_id
        or (linked_customer_uid is not null and user_uid = linked_customer_uid)
      );

  update public.club_ledgers
    set ledger = jsonb_set(
          coalesce(ledger_value, '{}'::jsonb),
          '{customers}',
          (
            select coalesce(jsonb_agg(entry), '[]'::jsonb)
            from jsonb_array_elements(coalesce(ledger_value -> 'customers', '[]'::jsonb)) as entries(entry)
            where entry ->> 'id' <> target_customer_id
          ),
          true
        ),
        updated_at = now_ms
    where club_id = target_club_id;

  return jsonb_build_object('customer_uid', linked_customer_uid, 'removed', true);
end;
$$;

alter table public.clubs enable row level security;
alter table public.club_owners enable row level security;
alter table public.club_ledgers enable row level security;
alter table public.owner_requests enable row level security;
alter table public.customer_registrations enable row level security;
alter table public.customer_portals enable row level security;
alter table public.platform_admins enable row level security;

revoke all on public.clubs, public.club_owners, public.club_ledgers,
  public.owner_requests, public.customer_registrations, public.customer_portals,
  public.platform_admins from anon, authenticated;
grant select on public.clubs to anon;
grant usage on schema public to authenticated;
grant select on public.clubs, public.club_owners, public.owner_requests,
  public.customer_registrations, public.customer_portals, public.platform_admins
  to authenticated;
grant select, insert, update on public.club_ledgers to authenticated;
grant select, insert, update on public.customer_registrations to authenticated;
grant insert, update, delete on public.customer_portals to authenticated;
revoke all on function public.is_platform_admin() from public, anon, authenticated;
revoke all on function public.is_club_owner(text) from public, anon, authenticated;
revoke all on function public.is_club_customer(text, text) from public, anon, authenticated;
revoke all on function public.review_owner_request(text, boolean) from public, anon, authenticated;
revoke all on function public.set_owner_request_archived(text, boolean) from public, anon, authenticated;
revoke all on function public.set_owner_access(text, boolean) from public, anon, authenticated;
revoke all on function public.admin_update_owner_details(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.permanently_delete_customer(text, text, text) from public, anon, authenticated;
grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.is_club_owner(text) to anon, authenticated;
grant execute on function public.is_club_customer(text, text) to authenticated;
grant execute on function public.review_owner_request(text, boolean) to authenticated;
grant execute on function public.set_owner_request_archived(text, boolean) to authenticated;
grant execute on function public.set_owner_access(text, boolean) to authenticated;
grant execute on function public.admin_update_owner_details(text, text, text, text, text, text) to service_role;
grant execute on function public.permanently_delete_customer(text, text, text) to service_role;

drop policy if exists "Approved clubs are visible" on public.clubs;
create policy "Approved clubs are visible"
  on public.clubs for select to anon, authenticated
  using (approved or public.is_club_owner(id) or public.is_platform_admin());

drop policy if exists "Owners can read club memberships" on public.club_owners;
create policy "Owners can read club memberships"
  on public.club_owners for select to authenticated
  using (owner_uid = auth.uid()::text or public.is_club_owner(club_id) or public.is_platform_admin());

drop policy if exists "Club owners can access their ledger" on public.club_ledgers;
create policy "Club owners can access their ledger"
  on public.club_ledgers for all to authenticated
  using (public.is_club_owner(club_id))
  with check (public.is_club_owner(club_id));
drop policy if exists "Platform admins can read all club ledgers" on public.club_ledgers;
create policy "Platform admins can read all club ledgers"
  on public.club_ledgers for select to authenticated
  using (public.is_platform_admin());

drop policy if exists "Users and admins can read owner requests" on public.owner_requests;
create policy "Users and admins can read owner requests"
  on public.owner_requests for select to authenticated
  using (user_uid = auth.uid()::text or public.is_platform_admin());

drop policy if exists "Customers and club owners can read registrations" on public.customer_registrations;
create policy "Customers and club owners can read registrations"
  on public.customer_registrations for select to authenticated
  using (user_uid = auth.uid()::text or public.is_club_owner(club_id));
drop policy if exists "Customers can submit their registration" on public.customer_registrations;
create policy "Customers can submit their registration"
  on public.customer_registrations for insert to authenticated
  with check (
    user_uid = auth.uid()::text
    and status = 'pending'
    and linked_customer_id is null
    and exists (
      select 1 from public.clubs
      where clubs.id = customer_registrations.club_id
        and clubs.approved
    )
  );
drop policy if exists "Club owners can link or reject registrations" on public.customer_registrations;
create policy "Club owners can link or reject registrations"
  on public.customer_registrations for update to authenticated
  using (public.is_club_owner(club_id))
  with check (public.is_club_owner(club_id));

drop policy if exists "Customers and club owners can read portal cards" on public.customer_portals;
create policy "Customers and club owners can read portal cards"
  on public.customer_portals for select to authenticated
  using (customer_uid = auth.uid()::text or public.is_club_owner(club_id));
drop policy if exists "Club owners can update portal cards" on public.customer_portals;
create policy "Club owners can update portal cards"
  on public.customer_portals for insert to authenticated
  with check (public.is_club_owner(club_id) and public.is_club_customer(customer_uid, club_id));
drop policy if exists "Club owners can edit portal cards" on public.customer_portals;
create policy "Club owners can edit portal cards"
  on public.customer_portals for update to authenticated
  using (public.is_club_owner(club_id) and public.is_club_customer(customer_uid, club_id))
  with check (public.is_club_owner(club_id) and public.is_club_customer(customer_uid, club_id));
drop policy if exists "Club owners can remove portal cards" on public.customer_portals;
create policy "Club owners can remove portal cards"
  on public.customer_portals for delete to authenticated
  using (public.is_club_owner(club_id));

drop policy if exists "Platform admins can read their own admin record" on public.platform_admins;
create policy "Platform admins can read their own admin record"
  on public.platform_admins for select to authenticated
  using (user_uid = auth.uid()::text);

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['club_ledgers', 'customer_registrations', 'customer_portals']
    loop
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end
$$;
