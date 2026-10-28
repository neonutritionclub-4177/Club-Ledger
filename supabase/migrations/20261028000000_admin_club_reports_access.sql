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
