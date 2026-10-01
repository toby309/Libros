-- =====================================================================
-- Book Giveaway — database schema
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. BOOKS: one row per Amazon redemption link
-- ---------------------------------------------------------------------
create table if not exists public.books (
  id                     bigserial primary key,
  redemption_url         text        not null unique,          -- a link can exist only once
  claimed                boolean     not null default false,
  claimed_by_email       text        unique,                   -- an email can hold only one link
  claimed_at             timestamptz,
  email_sent             boolean     not null default false,
  email_sent_at          timestamptz,
  email_last_attempt_at  timestamptz,
  email_error            text,
  created_at             timestamptz not null default now(),
  constraint claim_is_consistent check (
    (claimed and claimed_by_email is not null and claimed_at is not null)
    or (not claimed and claimed_by_email is null)
  ),
  constraint email_is_normalized check (
    claimed_by_email is null or claimed_by_email = lower(btrim(claimed_by_email))
  )
);

create index if not exists books_unclaimed_idx on public.books (id) where not claimed;

-- Nobody can read this table through the public API. Only the server
-- (service_role key, kept in env vars) can touch it.
alter table public.books enable row level security;
revoke all on public.books from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. RATE LIMITS (per hashed IP, fixed time windows)
-- ---------------------------------------------------------------------
create table if not exists public.rate_limits (
  key           text        not null,
  window_start  timestamptz not null,
  hits          integer     not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.hit_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits   integer;
begin
  insert into rate_limits (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1
  returning hits into v_hits;

  -- occasional cleanup of old windows
  if random() < 0.02 then
    delete from rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. CLAIM — the only way a link is ever handed out.
--    Runs as one transaction: either the email gets exactly one link,
--    or nothing changes.
--
--    Returns:
--      status       'new' | 'existing' | 'sold_out' | 'invalid'
--      url          the link for THIS email (null if sold out)
--      should_send  true if the server should send (or re-send) the email now
--      email_sent   whether the email has already gone out successfully
-- ---------------------------------------------------------------------
drop function if exists public.claim_book(text);
create function public.claim_book(p_email text)
returns table (status text, url text, should_send boolean, email_sent boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_row   books%rowtype;
begin
  if v_email = '' or length(v_email) > 254 or position('@' in v_email) = 0 then
    return query select 'invalid'::text, null::text, false, false;
    return;
  end if;

  -- Serialize requests for the SAME email (double-taps, two tabs, etc.)
  perform pg_advisory_xact_lock(hashtextextended(v_email, 0));

  -- Already claimed? Return the same link. Never consume a new one.
  select * into v_row from books where claimed_by_email = v_email;
  if found then
    -- Re-send the email only if it never went out and the last attempt
    -- was more than 2 minutes ago (avoids duplicate sends on double-taps).
    if not v_row.email_sent
       and (v_row.email_last_attempt_at is null or v_row.email_last_attempt_at < now() - interval '2 minutes') then
      update books set email_last_attempt_at = now() where id = v_row.id;
      return query select 'existing'::text, v_row.redemption_url, true, false;
    else
      return query select 'existing'::text, v_row.redemption_url, false, v_row.email_sent;
    end if;
    return;
  end if;

  -- New email: lock the next free link. SKIP LOCKED means two people
  -- submitting at the same instant each lock a DIFFERENT row.
  update books
     set claimed = true,
         claimed_by_email = v_email,
         claimed_at = now(),
         email_last_attempt_at = now()
   where id = (
     select id from books
      where not claimed
      order by id
      limit 1
      for update skip locked
   )
  returning * into v_row;

  if not found then
    return query select 'sold_out'::text, null::text, false, false;
    return;
  end if;

  return query select 'new'::text, v_row.redemption_url, true, false;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Record the result of the email send
-- ---------------------------------------------------------------------
create or replace function public.record_email_result(p_email text, p_sent boolean, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update books
     set email_sent    = email_sent or p_sent,
         email_sent_at = case when p_sent then now() else email_sent_at end,
         email_error   = case when p_sent then null else left(p_error, 500) end
   where claimed_by_email = lower(btrim(p_email));
$$;

-- ---------------------------------------------------------------------
-- 5. Is anything left? (returns only a number — never URLs)
-- ---------------------------------------------------------------------
create or replace function public.books_remaining()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from books where not claimed;
$$;

-- Functions: only the server may call them.
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_book(text)                        from public, anon, authenticated;
revoke all on function public.record_email_result(text, boolean, text) from public, anon, authenticated;
revoke all on function public.books_remaining()                       from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
grant execute on function public.claim_book(text)                        to service_role;
grant execute on function public.record_email_result(text, boolean, text) to service_role;
grant execute on function public.books_remaining()                       to service_role;

-- ---------------------------------------------------------------------
-- 6. TRACKING VIEWS — open these in Supabase → Table Editor / SQL Editor
--      select * from giveaway_stats;
--      select * from giveaway_claims;
-- ---------------------------------------------------------------------
create or replace view public.giveaway_stats with (security_invoker = on) as
select
  count(*)                                         as total_books,
  count(*) filter (where claimed)                  as claimed,
  count(*) filter (where not claimed)              as remaining,
  count(*) filter (where claimed and email_sent)     as emails_sent,
  count(*) filter (where claimed and not email_sent) as emails_not_sent
from public.books;

create or replace view public.giveaway_claims with (security_invoker = on) as
select
  id,
  claimed_by_email as email,
  redemption_url,
  claimed_at,
  email_sent,
  email_sent_at,
  email_error
from public.books
where claimed
order by claimed_at desc;

revoke all on public.giveaway_stats  from anon, authenticated;
revoke all on public.giveaway_claims from anon, authenticated;
