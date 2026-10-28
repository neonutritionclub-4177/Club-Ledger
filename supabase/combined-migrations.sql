-- Run once in Supabase SQL Editor for projects that already ran schema.sql.
-- This combines the non-empty migrations in timestamp order. The earlier
-- club-ledger-storage migration is empty and has no SQL to apply.
begin;

grant usage on schema public to authenticated;
grant select, insert, update on public.club_ledgers to authenticated;
grant select, insert, update on public.customer_registrations to authenticated;

drop policy if exists "Customers and club owners can read registrations" on public.customer_registrations;
create policy "Customers and club owners can read registrations"
  on public.customer_registrations for select to authenticated
  using (user_uid = auth.uid()::text or public.is_club_owner(club_id));

drop policy if exists "Platform admins can read all club ledgers" on public.club_ledgers;
create policy "Platform admins can read all club ledgers"
  on public.club_ledgers for select to authenticated
  using (public.is_platform_admin());

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

revoke all on function public.permanently_delete_customer(text, text, text)
  from public, anon, authenticated;
grant execute on function public.permanently_delete_customer(text, text, text)
  to service_role;

commit;
