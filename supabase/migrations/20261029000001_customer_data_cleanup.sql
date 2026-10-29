begin;

drop function if exists public.create_owner_pack_request(text, text, text);

create or replace function public.create_owner_pack_request(
  request_id text,
  target_customer_id text,
  target_pack_type text,
  target_total_shakes integer default null,
  target_duration_days integer default null,
  target_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_club_id text;
  v_customer_uid text;
  settings_row public.club_payment_settings%rowtype;
  pack_shakes integer;
  pack_days integer;
  pack_price numeric(12,2);
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  select owners.club_id into target_club_id
    from public.club_owners owners
    where owners.owner_uid = auth.uid()::text
    limit 1;
  if target_club_id is null then
    raise exception 'Club owner access is required' using errcode = '42501';
  end if;

  select entries.entry #>> '{login,uid}' into v_customer_uid
    from public.club_ledgers ledgers,
      lateral jsonb_array_elements(coalesce(ledgers.ledger -> 'customers', '[]'::jsonb)) as entries(entry)
    where ledgers.club_id = target_club_id
      and entries.entry ->> 'id' = target_customer_id
      and coalesce(entries.entry ->> 'deleted', 'false') <> 'true'
    limit 1;
  if v_customer_uid is null or not exists (
    select 1 from public.customer_registrations registration
    where registration.user_uid = v_customer_uid
      and registration.club_id = target_club_id
      and registration.status = 'linked'
  ) then
    raise exception 'A linked customer login is required for in-app payment requests' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_customer_uid, 0));
  if exists (
    select 1 from public.pack_payment_requests requests
    where requests.customer_uid = v_customer_uid
      and requests.status in ('pending', 'payment_submitted')
  ) then
    raise exception 'This customer already has an active pack payment request' using errcode = 'P0001';
  end if;

  select * into settings_row
    from public.club_payment_settings
    where club_id = target_club_id;
  if target_pack_type = 'custom' then
    pack_shakes := coalesce(target_total_shakes, 0);
    pack_days := coalesce(target_duration_days, 30);
    pack_price := target_amount;
  else
    pack_shakes := case target_pack_type
      when '6-day' then 6 when '12-day' then 12 when '26-day' then 26 else 0 end;
    pack_days := pack_shakes;
    pack_price := nullif(settings_row.pack_prices ->> target_pack_type, '')::numeric;
  end if;
  if pack_shakes <= 0 or pack_shakes > 10000 or pack_days <= 0 or pack_days > 3650 or
      pack_price is null or pack_price <= 0 or pack_price > 10000000 or
      coalesce(settings_row.upi_id, '') = '' then
    raise exception 'Choose a valid priced pack and configure a UPI ID in Settings first' using errcode = 'P0001';
  end if;

  insert into public.pack_payment_requests (
    id, club_id, customer_uid, customer_id, pack_type, total_shakes,
    duration_days, amount, upi_id, status, created_at, updated_at
  ) values (
    request_id, target_club_id, v_customer_uid, target_customer_id, target_pack_type,
    pack_shakes, pack_days, pack_price, settings_row.upi_id, 'pending', now_ms, now_ms
  );
  return jsonb_build_object('id', request_id, 'status', 'pending', 'amount', pack_price);
end;
$$;

revoke all on function public.create_owner_pack_request(text, text, text, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.create_owner_pack_request(text, text, text, integer, integer, numeric)
  to authenticated;

create or replace function public.delete_customer_pack_request(target_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_id text;
begin
  delete from public.pack_payment_requests requests
    where requests.id = target_request_id
      and public.is_club_owner(requests.club_id)
    returning requests.id into removed_id;
  if removed_id is null then
    raise exception 'Payment request not found or owner access is required' using errcode = '42501';
  end if;
  return jsonb_build_object('id', removed_id, 'removed', true);
end;
$$;

revoke all on function public.delete_customer_pack_request(text) from public, anon, authenticated;
grant execute on function public.delete_customer_pack_request(text) to authenticated;

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
  customer_uids text[] := array[]::text[];
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if not exists (
    select 1 from public.club_owners owners
    where owners.club_id = target_club_id and owners.owner_uid = actor_uid
  ) then
    raise exception 'Club owner access is required' using errcode = '42501';
  end if;

  select ledgers.ledger into ledger_value
    from public.club_ledgers ledgers
    where ledgers.club_id = target_club_id
    for update;
  if found then
    select entries.entry into customer_value
      from jsonb_array_elements(coalesce(ledger_value -> 'customers', '[]'::jsonb)) as entries(entry)
      where entries.entry ->> 'id' = target_customer_id
      limit 1;
  end if;
  if customer_value is not null and coalesce(customer_value ->> 'deleted', 'false') <> 'true' then
    raise exception 'Move the customer to Deleted before permanent removal' using errcode = 'P0001';
  end if;

  linked_customer_uid := customer_value #>> '{login,uid}';
  select coalesce(
      array_agg(distinct associated.user_uid) filter (where associated.user_uid is not null),
      array[]::text[]
    )
    into customer_uids
    from (
      select linked_customer_uid as user_uid
      union all
      select registrations.user_uid
        from public.customer_registrations registrations
        where registrations.club_id = target_club_id
          and (
            registrations.linked_customer_id = target_customer_id
            or (linked_customer_uid is not null and registrations.user_uid = linked_customer_uid)
          )
      union all
      select requests.customer_uid
        from public.pack_payment_requests requests
        where requests.club_id = target_club_id
          and (
            requests.customer_id = target_customer_id
            or (linked_customer_uid is not null and requests.customer_uid = linked_customer_uid)
          )
    ) as associated;

  delete from public.customer_portals portals
    where portals.club_id = target_club_id
      and portals.customer_uid = any(customer_uids);
  delete from public.customer_registrations registrations
    where registrations.club_id = target_club_id
      and (
        registrations.linked_customer_id = target_customer_id
        or registrations.user_uid = any(customer_uids)
      );
  delete from public.pack_payment_requests requests
    where requests.club_id = target_club_id
      and (
        requests.customer_id = target_customer_id
        or requests.customer_uid = any(customer_uids)
      );

  if customer_value is not null then
    update public.club_ledgers ledgers
      set ledger = jsonb_set(
            coalesce(ledger_value, '{}'::jsonb),
            '{customers}',
            (
              select coalesce(jsonb_agg(entries.entry), '[]'::jsonb)
                from jsonb_array_elements(coalesce(ledger_value -> 'customers', '[]'::jsonb)) as entries(entry)
                where entries.entry ->> 'id' is distinct from target_customer_id
            ),
            true
          ),
          updated_at = now_ms
      where ledgers.club_id = target_club_id;
  end if;

  return jsonb_build_object(
    'customer_uid', linked_customer_uid,
    'customer_uids', to_jsonb(customer_uids),
    'removed', customer_value is not null
  );
end;
$$;

revoke all on function public.permanently_delete_customer(text, text, text)
  from public, anon, authenticated;
grant execute on function public.permanently_delete_customer(text, text, text)
  to service_role;

commit;
