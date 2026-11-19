-- ARL Attendance: database function reference snapshot
-- Reference only. Not a complete migration; existing tables are required.
-- um_* still require identity/security and ARL email-domain review.
-- Do not deploy as an approved production migration.
-- Preserves supplied explicit function privileges for standard Supabase roles.
BEGIN;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.approve_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare snap jsonb; prior public.ot_allowance_approvals%rowtype; person text;
begin
 if not public.attendance_manager_access(p_section_id) then
  raise exception 'Assigned active Manager required';
 end if;
 -- Short global write lock serializes approval with all imports/manual writes.
 -- No waiting for user under this lock: confirmation is completed before RPC.
 -- Lock order matches an import that audits attendance and accesses edits.
 lock table public.app_users,public.user_sections,public.sections in share mode;
 lock table public.attendance in share row exclusive mode;
 lock table public.attendance_edits in share row exclusive mode;
 -- Recheck assignment after lock acquisition, before authorization to approve.
 if not public.attendance_manager_access(p_section_id) then
  raise exception 'Manager access changed';
 end if;
 snap:=public.ot_allowance_snapshot(p_section_id,p_period);
 if p_expected_snapshot is null or p_expected_snapshot is distinct from snap then
  raise exception 'OT_CHANGED: Reload and review the current monthly data before approval';
 end if;
 if jsonb_array_length(snap->'rows')=0 then raise exception 'No positive OT or Allowance to approve'; end if;
 select * into prior from public.ot_allowance_approvals
  where section_id=p_section_id and period=p_period order by id desc limit 1;
 if prior.id is not null and prior.snapshot=snap then
  return jsonb_build_object('status','Approved','approval_id',prior.id,
   'approved_name',prior.approved_name,'approved_at',prior.approved_at,'already_approved',true);
 end if;
 select display_name into strict person from public.app_users where id=auth.uid();
 insert into public.ot_allowance_approvals(section_id,period,snapshot,approved_by,approved_name)
  values(p_section_id,p_period,snap,auth.uid(),person) returning * into prior;
 insert into public.ot_approval_notification_queue(approval_id) values(prior.id);
 return jsonb_build_object('status','Approved','approval_id',prior.id,
  'approved_name',prior.approved_name,'approved_at',prior.approved_at,'already_approved',false);
end $function$;
REVOKE ALL ON FUNCTION public.approve_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.attendance_access(p_section_id bigint, p_central_only boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists (
  select 1 from public.app_users u join public.sections s on s.id = p_section_id
  where u.id = (select auth.uid()) and u.is_active and s.is_active
   and (u.role = 'SUPER_ADMIN' or
    (not p_central_only and u.role = 'DEPARTMENT_ADMIN' and exists (
     select 1 from public.user_sections us where us.user_id=u.id and us.section_id=s.id)))
 );
$function$;
REVOKE ALL ON FUNCTION public.attendance_access(p_section_id bigint, p_central_only boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_access(p_section_id bigint, p_central_only boolean) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.attendance_manager_access(p_section_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists (
  select 1
  from public.app_users u
  join public.user_sections us on us.user_id=u.id
  join public.sections s on s.id=us.section_id
  where u.id=(select auth.uid()) and u.is_active
    and u.role='MANAGER' and s.is_active and s.id=p_section_id
 );
$function$;
REVOKE ALL ON FUNCTION public.attendance_manager_access(p_section_id bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_manager_access(p_section_id bigint) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.attendance_time_iso(v text, d date)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
 if v is null or v='' then return null; end if;
 if v ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return (d::text||'T'||v||':00+07:00')::timestamptz; end if;
 if v !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Timestamp must include timezone'; end if;
 return v::timestamptz;
end $function$;
REVOKE ALL ON FUNCTION public.attendance_time_iso(v text, d date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_time_iso(v text, d date) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.audit_attendance_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 a public.attendance%rowtype; oldj jsonb; newj jsonb;
 f text; fields text[]; who uuid := auth.uid(); display text; role_name text; section_name text; oldo jsonb; newo jsonb; reason text; oldv jsonb; newv jsonb;
begin
 if TG_TABLE_NAME='attendance' then
  -- First matching import is a baseline, not a manual edit. Reimport changes are logged.
  if TG_OP='INSERT' then return NEW; end if;
  a:=NEW;
  fields:=array['section_id','gid','full_name','work_date','day_label','shift','working_in','working_out','real_in','real_out','diff_hhmm','time_clock_data','late_min','auto_xy','leave_units','leave_type','auto_remark','data_status','leave_source','leave_half'];
 else
  select * into strict a from public.attendance where id=NEW.attendance_id;
  fields:=array['ot15','ot20','ot30','total_ot','ot_refer','meal','stand_by','emergency','total_allowance','allowance_refer','manual_remark','manual_xy'];
 end if;
 newj:=to_jsonb(NEW);
 if TG_OP='UPDATE' then oldj:=to_jsonb(OLD); else oldj:='{}'::jsonb; end if;
 select u.display_name,u.role into display,role_name from public.app_users u where u.id=who;
 select s.code into section_name from public.sections s where s.id=a.section_id;
 foreach f in array fields loop
  -- Treat absent old key on first manual save as SQL NULL, keep explicit empty string distinct.
  if coalesce(oldj->f,'null'::jsonb) is distinct from coalesce(newj->f,'null'::jsonb) then
   insert into public.attendance_edit_history(actor_id,actor_name,actor_role,source_table,operation,
    attendance_id,section_id,section_code,gid,full_name,work_date,field_name,old_value,new_value)
   values(who,coalesce(display,case when who is null then 'Database / system' else who::text end),role_name,
    TG_TABLE_NAME,TG_OP,a.id,a.section_id,section_name,a.gid,a.full_name,a.work_date,f,
    coalesce(oldj->f,'null'::jsonb),coalesce(newj->f,'null'::jsonb));
  end if;
 end loop;
 if TG_TABLE_NAME='attendance_edits' then
  oldo:=coalesce(oldj->'time_overrides','{}'::jsonb);newo:=coalesce(newj->'time_overrides','{}'::jsonb);
  reason:=NEW.time_change_reason;
  foreach f in array array['shift','working_in','working_out','real_in','real_out'] loop
   if (oldo ? f) is distinct from (newo ? f) or oldo->f is distinct from newo->f then
    oldv:=jsonb_build_object('mode',case when oldo ? f then 'manual' else 'matching' end,'value',case when oldo ? f then oldo->f else to_jsonb(a)->f end);
    newv:=jsonb_build_object('mode',case when newo ? f then 'manual' else 'matching' end,'value',case when newo ? f then newo->f else to_jsonb(a)->f end);
    insert into public.attendance_edit_history(actor_id,actor_name,actor_role,source_table,operation,
     attendance_id,section_id,section_code,gid,full_name,work_date,field_name,old_value,new_value,change_reason)
    values(who,coalesce(display,case when who is null then 'Database / system' else who::text end),role_name,
     TG_TABLE_NAME,TG_OP,a.id,a.section_id,section_name,a.gid,a.full_name,a.work_date,'manual_'||f,oldv,newv,reason);
   end if;
  end loop;
 end if;
 return NEW;
end $function$;
REVOKE ALL ON FUNCTION public.audit_attendance_changes() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.audit_attendance_leave_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.attendance%rowtype; oldo jsonb; newo jsonb; f text;
 who uuid:=auth.uid(); person text; role_name text; code text;
 oldv jsonb; newv jsonb;
begin
 oldo:=case when TG_OP='INSERT' then '{}'::jsonb else OLD.leave_overrides end;
 newo:=NEW.leave_overrides;
 if oldo is not distinct from newo then return NEW; end if;
 select * into strict a from public.attendance where id=NEW.attendance_id;
 select u.display_name,u.role into person,role_name from public.app_users u where u.id=who;
 select s.code into code from public.sections s where s.id=a.section_id;
 foreach f in array array['leave_units','leave_type','leave_half'] loop
  if (oldo ? f) is distinct from (newo ? f) or oldo->f is distinct from newo->f then
   oldv:=jsonb_build_object('mode',case when oldo ? f then 'manual' else 'matching' end,'value',case when oldo ? f then oldo->f else to_jsonb(a)->f end);
   newv:=jsonb_build_object('mode',case when newo ? f then 'manual' else 'matching' end,'value',case when newo ? f then newo->f else to_jsonb(a)->f end);
   insert into public.attendance_edit_history(actor_id,actor_name,actor_role,source_table,operation,attendance_id,section_id,section_code,gid,full_name,work_date,field_name,old_value,new_value,change_reason)
   values(who,coalesce(person,case when who is null then 'Database / system' else who::text end),role_name,TG_TABLE_NAME,TG_OP,a.id,a.section_id,code,a.gid,a.full_name,a.work_date,'manual_'||f,oldv,newv,NEW.leave_change_reason);
  end if;
 end loop;
 return NEW;
end $function$;
REVOKE ALL ON FUNCTION public.audit_attendance_leave_changes() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.central_ot_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin raise exception 'Central OT event is immutable'; end $function$;
REVOKE ALL ON FUNCTION public.central_ot_immutable() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.claim_ot_requests()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ids uuid[]; result jsonb;
begin
 update public.ot_request_outbox set state='uncertain',finished_at=clock_timestamp(),last_error='Worker lease expired; inspect Flow run history before any resend'
  where state='processing' and claimed_at<clock_timestamp()-interval '10 minutes';
 with candidates as (
  select request_id from public.ot_request_outbox where state='queued' order by request_id for update skip locked limit 3
 ), claimed as (
  update public.ot_request_outbox q set state='processing',attempts=q.attempts+1,claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
  from candidates c where q.request_id=c.request_id returning q.request_id
 ) select array_agg(request_id) into ids from claimed;
 select coalesce(jsonb_agg(jsonb_build_object('request_id',r.id,'department_code',r.department_code,'snapshot',r.snapshot,
  'requested_by',r.requested_name,'requested_at',r.requested_at,'claim_token',q.claim_token)),'[]'::jsonb)
 into result from public.ot_allowance_requests r join public.ot_request_outbox q on q.request_id=r.id where r.id=any(ids);
 return result;
end $function$;
REVOKE ALL ON FUNCTION public.claim_ot_requests() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.finish_ot_request(p_request_id uuid, p_claim_token uuid, p_state text, p_http_status integer, p_error text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
 if p_state not in('accepted','failed','uncertain') then raise exception 'Invalid finish state'; end if;
 update public.ot_request_outbox set state=p_state,finished_at=clock_timestamp(),http_status=p_http_status,last_error=left(p_error,300)
 where request_id=p_request_id and claim_token=p_claim_token and state='processing';
 get diagnostics n=row_count;return n=1;
end $function$;
REVOKE ALL ON FUNCTION public.finish_ot_request(p_request_id uuid, p_claim_token uuid, p_state text, p_http_status integer, p_error text) FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.get_attendance_notice()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
begin
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role in ('SUPER_ADMIN','DEPARTMENT_ADMIN','MANAGER')) then
  raise exception 'NOTICE_FORBIDDEN: Active app account required' using errcode='42501';
 end if;
 return (select jsonb_build_object('period',n.period,'shift_deadline',n.shift_deadline,'ot_deadline',n.ot_deadline,'version',n.version,'updated_at',n.updated_at) from public.attendance_notice n where id=1);
end $function$;
REVOKE ALL ON FUNCTION public.get_attendance_notice() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_attendance_notice() TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.get_central_ot_summary(p_period date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare sec record; snap jsonb; prior public.ot_allowance_approvals%rowtype;
 req public.ot_mailto_request_events%rowtype; depts jsonb:='[]'::jsonb;
 people jsonb; tas jsonb; ot numeric; allowance numeric; totalot numeric:=0; totala numeric:=0;
 lastedit timestamptz; st text;
begin
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='SUPER_ADMIN') then
  raise exception 'CENTRAL_OT_FORBIDDEN: Active Central Admin only'; end if;
 if p_period is null or extract(day from p_period)<>1 or p_period<date '0001-01-01' or p_period>date '9998-12-01' then
  raise exception 'CENTRAL_OT_INVALID: Invalid month'; end if;
 lock table public.app_users,public.user_sections,public.sections in share mode;
 lock table public.attendance in share mode;
 lock table public.attendance_edits in share mode;
 lock table public.ot_allowance_approvals,public.ot_mailto_request_events,public.attendance_edit_history in share mode;
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='SUPER_ADMIN') then
  raise exception 'CENTRAL_OT_FORBIDDEN: Access changed'; end if;
 for sec in select id,code,name from public.sections where is_active order by
  case code when 'RST' then 1 when 'OHL' then 2 when 'TRW_TRD' then 3 when 'DWE' then 4 when 'COM' then 5 when 'PSY_GRS' then 6 when 'PSD_PID' then 7 else 8 end,code loop
  snap:=public.ot_allowance_snapshot(sec.id,p_period);
  select * into prior from public.ot_allowance_approvals where section_id=sec.id and period=p_period order by id desc limit 1;
  select * into req from public.ot_mailto_request_events where section_id=sec.id and period=p_period order by requested_at desc,id desc limit 1;
  select max(changed_at) into lastedit from public.attendance_edit_history
   where section_id=sec.id and work_date>=p_period and work_date<(p_period+interval '1 month')::date
   and field_name in ('section_id','gid','full_name','work_date','auto_remark','manual_remark','ot15','ot20','ot30','meal','stand_by','emergency','ot_refer','allowance_refer');
  st:=case when prior.id is not null and prior.snapshot=snap then 'Approved'
   when prior.id is not null then 'Needs reapproval'
   when (snap->>'source_count')::bigint=0 then 'No data'
   when jsonb_array_length(snap->'rows')=0 then 'No OT/Allowance'
   when req.id is not null and req.snapshot_revision=(snap->>'revision')::bigint then 'Requested'
   else 'Not requested' end;
  select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) order by u.display_name,u.id),'[]'::jsonb) into tas
   from public.app_users u join public.user_sections us on us.user_id=u.id
   where us.section_id=sec.id and u.is_active and u.role='DEPARTMENT_ADMIN';
  if exists(select 1 from jsonb_array_elements(snap->'rows') x group by x->>'gid' having count(distinct x->>'name')>1) then
   raise exception 'CENTRAL_OT_INVALID: Inconsistent employee name in %',sec.code; end if;
  select coalesce(jsonb_agg(jsonb_build_object('gid',gid,'name',name,'ot15',ot15,'ot20',ot20,'ot30',ot30,
   'total_ot',ot15+ot20+ot30,'meal',meal,'stand_by',standby,'emergency',emergency,
   'total_allowance',meal+standby+emergency,'remark',remark) order by gid),'[]'::jsonb)
   into people from (
    select x->>'gid' gid,min(x->>'name') name,
     sum(coalesce((x->>'ot15')::numeric,0)) ot15,sum(coalesce((x->>'ot20')::numeric,0)) ot20,
     sum(coalesce((x->>'ot30')::numeric,0)) ot30,sum(coalesce((x->>'meal')::numeric,0)) meal,
     sum(coalesce((x->>'stand_by')::numeric,0)) standby,sum(coalesce((x->>'emergency')::numeric,0)) emergency,
     coalesce(string_agg(distinct nullif(x->>'remark',''),' | ' order by nullif(x->>'remark','')),'') remark
    from jsonb_array_elements(snap->'rows') x group by x->>'gid'
   ) q;
  select coalesce(sum((x->>'total_ot')::numeric),0),coalesce(sum((x->>'total_allowance')::numeric),0)
   into ot,allowance from jsonb_array_elements(people) x;
  totalot:=totalot+ot;totala:=totala+allowance;
  depts:=depts||jsonb_build_array(jsonb_build_object('section_id',sec.id,'section_code',sec.code,'section_name',sec.name,
   'tas',tas,'status',st,'last_update',greatest(lastedit,prior.approved_at,req.requested_at),
   'approved_at',prior.approved_at,'approved_name',prior.approved_name,'requested_at',req.requested_at,
   'requested_name',req.requested_name,'revision',snap->'revision','source_count',snap->'source_count',
   'row_count',jsonb_array_length(snap->'rows'),'employees',people,'total_ot',ot,'total_allowance',allowance));
 end loop;
 return jsonb_build_object('period',to_char(p_period,'YYYY-MM'),'departments',depts,'total_ot',totalot,'total_allowance',totala);
end $function$;
REVOKE ALL ON FUNCTION public.get_central_ot_summary(p_period date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_central_ot_summary(p_period date) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.get_history_actor_usernames(p_actor_ids uuid[])
 RETURNS TABLE(actor_id uuid, username text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from public.app_users a where a.id=auth.uid() and a.is_active and a.role='SUPER_ADMIN') then
  raise exception 'HISTORY_USERNAME_FORBIDDEN: Active Central Admin only' using errcode='42501';
 end if;
 if p_actor_ids is null or coalesce(cardinality(p_actor_ids),0)>500 then
  raise exception 'HISTORY_USERNAME_INVALID: At most 500 actor IDs' using errcode='22023';
 end if;
 return query
 select u.id, split_part(lower(u.email),'@',1)
 from auth.users u
 where u.id=any(p_actor_ids)
 and lower(u.email) ~ '^[a-z0-9][a-z0-9_.-]{2,31}@mrta-attendance[.]invalid$'
 and exists(
  select 1 from public.attendance_edit_history h where h.actor_id=u.id
  union all select 1 from public.ot_allowance_approvals a where a.approved_by=u.id
  union all select 1 from public.ot_mailto_request_events r where r.requested_by=u.id
  union all select 1 from public.central_ot_events c where c.actor_id=u.id
 );
end;
$function$;
REVOKE ALL ON FUNCTION public.get_history_actor_usernames(p_actor_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_history_actor_usernames(p_actor_ids uuid[]) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.get_ot_allowance_approval(p_section_id bigint, p_period date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare snap jsonb; prior public.ot_allowance_approvals%rowtype;
begin
 if not (public.attendance_access(p_section_id,false)
  or public.attendance_manager_access(p_section_id)) then
  raise exception 'Assigned section read access required';
 end if;
 lock table public.attendance in share mode;
 lock table public.attendance_edits in share mode;
 snap:=public.ot_allowance_snapshot(p_section_id,p_period);
 select * into prior from public.ot_allowance_approvals
  where section_id=p_section_id and period=p_period order by id desc limit 1;
 return jsonb_build_object('snapshot',snap,
  'status',case when prior.id is null then 'Not approved'
   when prior.snapshot=snap then 'Approved' else 'Needs reapproval' end,
  'approval_id',prior.id,'approved_name',prior.approved_name,'approved_at',prior.approved_at);
end $function$;
REVOKE ALL ON FUNCTION public.get_ot_allowance_approval(p_section_id bigint, p_period date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ot_allowance_approval(p_section_id bigint, p_period date) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.get_ot_allowance_request(p_section_id bigint, p_period date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb;
begin
 if not (public.attendance_access(p_section_id,false) or public.attendance_manager_access(p_section_id)) then raise exception 'Assigned section read access required'; end if;
 if p_period is null or extract(day from p_period)<>1 or p_period<date '0001-01-01' or p_period>date '9998-12-01' then raise exception 'Invalid period'; end if;
 select jsonb_build_object('request_id',r.id,'requested_name',r.requested_name,'requested_at',r.requested_at,'state',q.state)
 into v from public.ot_allowance_requests r join public.ot_request_outbox q on q.request_id=r.id
 where r.section_id=p_section_id and r.period=p_period order by r.requested_at desc,r.id desc limit 1;
 return v;
end $function$;
REVOKE ALL ON FUNCTION public.get_ot_allowance_request(p_section_id bigint, p_period date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ot_allowance_request(p_section_id bigint, p_period date) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.ot_allowance_snapshot(p_section_id bigint, p_period date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare n bigint; items jsonb; label text;
begin
 if p_period is null or extract(day from p_period)<>1
  or p_period<date '0001-01-01' or p_period>date '9998-12-01' then
  raise exception 'Period must be first day of month';
 end if;
 select name into strict label from public.sections
  where id=p_section_id and is_active;
 select count(*) into n from public.attendance a
  where a.section_id=p_section_id and a.work_date>=p_period
   and a.work_date<(p_period+interval '1 month')::date;
 if n>12000 then raise exception 'Month exceeds 12000 source rows'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'attendance_id',a.id,'gid',a.gid,'name',a.full_name,'date',a.work_date,
  'ot15',e.ot15,'ot20',e.ot20,'ot30',e.ot30,'total_ot',e.total_ot,
  'meal',e.meal,'stand_by',e.stand_by,'emergency',e.emergency,
  'total_allowance',e.total_allowance,
  'remark',concat_ws(' | ',
    nullif(coalesce(e.manual_remark,a.auto_remark,''),''),
    case when nullif(e.ot_refer,'') is not null then 'OT Refer: '||e.ot_refer end,
    case when nullif(e.allowance_refer,'') is not null then 'Allowance Refer: '||e.allowance_refer end)
 ) order by a.gid,a.work_date,a.id),'[]'::jsonb) into items
 from public.attendance a join public.attendance_edits e on e.attendance_id=a.id
 where a.section_id=p_section_id and a.work_date>=p_period
  and a.work_date<(p_period+interval '1 month')::date
  and (coalesce(e.ot15,0)>0 or coalesce(e.ot20,0)>0 or coalesce(e.ot30,0)>0
   or coalesce(e.meal,0)>0 or coalesce(e.stand_by,0)>0 or coalesce(e.emergency,0)>0);
 return jsonb_build_object('department',label,'period',to_char(p_period,'YYYY-MM'),
  'source_count',n,'revision',coalesce((select revision from public.ot_approval_revisions where section_id=p_section_id and period=p_period),0),'rows',items);
end $function$;
REVOKE ALL ON FUNCTION public.ot_allowance_snapshot(p_section_id bigint, p_period date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ot_allowance_snapshot(p_section_id bigint, p_period date) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.ot_approval_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare sid bigint; d date; oldsid bigint; oldd date;
begin
 if tg_table_name='attendance' then
  if tg_op='UPDATE' and
   row(new.section_id,new.gid,new.full_name,new.work_date,new.auto_remark)
   is not distinct from row(old.section_id,old.gid,old.full_name,old.work_date,old.auto_remark)
   then return null; end if;
  if tg_op<>'DELETE' then sid:=new.section_id; d:=new.work_date; end if;
  if tg_op<>'INSERT' then oldsid:=old.section_id; oldd:=old.work_date; end if;
 else
  if tg_op='UPDATE' and
   row(new.ot15,new.ot20,new.ot30,new.meal,new.stand_by,new.emergency,new.manual_remark,new.ot_refer,new.allowance_refer)
   is not distinct from row(old.ot15,old.ot20,old.ot30,old.meal,old.stand_by,old.emergency,old.manual_remark,old.ot_refer,old.allowance_refer)
   then return null; end if;
  select section_id,work_date into sid,d from public.attendance
   where id=case when tg_op='DELETE' then old.attendance_id else new.attendance_id end;
 end if;
 if sid is not null then
  insert into public.ot_approval_revisions(section_id,period,revision)
   values(sid,date_trunc('month',d)::date,1)
   on conflict(section_id,period) do update set revision=public.ot_approval_revisions.revision+1;
 end if;
 if oldsid is not null and (sid is null or
  row(oldsid,date_trunc('month',oldd)::date) is distinct from row(sid,date_trunc('month',d)::date)) then
  insert into public.ot_approval_revisions(section_id,period,revision)
   values(oldsid,date_trunc('month',oldd)::date,1)
   on conflict(section_id,period) do update set revision=public.ot_approval_revisions.revision+1;
 end if;
 return null;
end $function$;
REVOKE ALL ON FUNCTION public.ot_approval_changed() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.ot_approval_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin
 raise exception 'Approval records are immutable; create a new approval instead';
end $function$;
REVOKE ALL ON FUNCTION public.ot_approval_immutable() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.ot_mailto_event_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin
 raise exception 'Mailto request history is immutable'; end $function$;
REVOKE ALL ON FUNCTION public.ot_mailto_event_immutable() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.ot_request_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin raise exception 'Request events are immutable'; end $function$;
REVOKE ALL ON FUNCTION public.ot_request_immutable() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.prepare_central_ot_action(p_period date, p_action text, p_expected_summary jsonb, p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare ev public.central_ot_events%rowtype; current_summary jsonb; person text;
begin
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='SUPER_ADMIN') then
  raise exception 'CENTRAL_OT_FORBIDDEN: Active Central Admin only'; end if;
 if p_event_id is null or p_action is null or p_action not in ('request_pm','export_txt') or p_expected_summary is null then
  raise exception 'CENTRAL_OT_INVALID: Invalid action/ID'; end if;
 current_summary:=public.get_central_ot_summary(p_period);
 lock table public.central_ot_events in share row exclusive mode;
 select * into ev from public.central_ot_events where id=p_event_id;
 if found then
  if ev.actor_id<>auth.uid() or ev.period<>p_period or ev.action<>p_action or ev.summary is distinct from p_expected_summary then
   raise exception 'CENTRAL_OT_INVALID: Event ID conflict'; end if;
 else
  if current_summary is distinct from p_expected_summary then
   raise exception 'CENTRAL_OT_CHANGED: Data/status changed. Reload and review.'; end if;
  select display_name into strict person from public.app_users where id=auth.uid();
  insert into public.central_ot_events(id,period,action,actor_id,actor_name,summary)
   values(p_event_id,p_period,p_action,auth.uid(),person,current_summary) returning * into ev;
 end if;
 -- No Approved-completeness gate; no PM approval/outbox writes.
 return jsonb_build_object('event_id',ev.id,'created_at',ev.created_at,'action',ev.action,'summary',ev.summary,'state','prepared');
end $function$;
REVOKE ALL ON FUNCTION public.prepare_central_ot_action(p_period date, p_action text, p_expected_summary jsonb, p_event_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_central_ot_action(p_period date, p_action text, p_expected_summary jsonb, p_event_id uuid) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.prepare_ot_allowance_mailto(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare who uuid:=auth.uid(); snap jsonb; ev public.ot_mailto_request_events%rowtype;
 person text; code text; ot numeric; allowance numeric; n integer;
begin
 if who is null or not exists(select 1 from public.app_users u
  join public.user_sections us on us.user_id=u.id join public.sections s on s.id=us.section_id
  where u.id=who and u.is_active and u.role='DEPARTMENT_ADMIN' and us.section_id=p_section_id and s.is_active) then
  raise exception 'OT_MAILTO_FORBIDDEN: Assigned active TA only'; end if;
 if p_request_id is null or p_period is null or extract(day from p_period)<>1
  or p_period<date '0001-01-01' or p_period>date '9998-12-01' then
  raise exception 'OT_MAILTO_INVALID: Invalid month/request ID'; end if;
 lock table public.app_users,public.user_sections,public.sections in share mode;
 lock table public.attendance in share mode;
 lock table public.attendance_edits in share mode;
 lock table public.ot_mailto_request_events in share row exclusive mode;
 if not exists(select 1 from public.app_users u join public.user_sections us on us.user_id=u.id
  join public.sections s on s.id=us.section_id where u.id=who and u.is_active
  and u.role='DEPARTMENT_ADMIN' and us.section_id=p_section_id and s.is_active) then
  raise exception 'OT_MAILTO_FORBIDDEN: TA access changed'; end if;
 select * into ev from public.ot_mailto_request_events where id=p_request_id;
 if found then
  if ev.requested_by<>who or ev.section_id<>p_section_id or ev.period<>p_period then
   raise exception 'OT_MAILTO_INVALID: Request ID conflict'; end if;
 else
  snap:=public.ot_allowance_snapshot(p_section_id,p_period);
  if p_expected_snapshot is null or p_expected_snapshot is distinct from snap then
   raise exception 'OT_MAILTO_CHANGED: Data changed. Reload and request again.'; end if;
  n:=jsonb_array_length(snap->'rows');
  if n=0 then raise exception 'OT_MAILTO_INVALID: No positive OT/Allowance to request'; end if;
  select coalesce(sum(coalesce((x->>'ot15')::numeric,0)+coalesce((x->>'ot20')::numeric,0)+coalesce((x->>'ot30')::numeric,0)),0),
   coalesce(sum(coalesce((x->>'meal')::numeric,0)+coalesce((x->>'stand_by')::numeric,0)+coalesce((x->>'emergency')::numeric,0)),0)
   into ot,allowance from jsonb_array_elements(snap->'rows') x;
  select display_name into strict person from public.app_users where id=who;
  select s.code into strict code from public.sections s where s.id=p_section_id;
  insert into public.ot_mailto_request_events(id,section_id,period,requested_by,requested_name,section_code,snapshot_revision,row_count,total_ot,total_allowance)
   values(p_request_id,p_section_id,p_period,who,person,code,(snap->>'revision')::bigint,n,ot,allowance) returning * into ev;
 end if;
 return jsonb_build_object('request_id',ev.id,'period',to_char(ev.period,'YYYY-MM'),'section_code',ev.section_code,
  'row_count',ev.row_count,'total_ot',ev.total_ot,'total_allowance',ev.total_allowance,
  'requested_at',ev.requested_at,'state','mailto_prepared');
end $function$;
REVOKE ALL ON FUNCTION public.prepare_ot_allowance_mailto(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_ot_allowance_mailto(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.request_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare snap jsonb; prior public.ot_allowance_requests%rowtype; person text; dept text; st text;
begin
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='DEPARTMENT_ADMIN')
  or not public.attendance_access(p_section_id,false) then raise exception 'Assigned active TA required'; end if;
 if p_request_id is null then raise exception 'Request ID required'; end if;
 lock table public.app_users,public.user_sections,public.sections in share mode;
 lock table public.attendance in share row exclusive mode;
 lock table public.attendance_edits in share row exclusive mode;
 lock table public.ot_allowance_requests in share row exclusive mode;
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='DEPARTMENT_ADMIN')
  or not public.attendance_access(p_section_id,false) then raise exception 'TA access changed'; end if;
 -- Same request ID recovers a lost enqueue response even if attendance subsequently changed.
 select * into prior from public.ot_allowance_requests where id=p_request_id;
 if prior.id is not null then
  if prior.requested_by<>auth.uid() or prior.section_id<>p_section_id or prior.period<>p_period
   or p_expected_snapshot is distinct from prior.snapshot then raise exception 'Request ID conflict'; end if;
 else
  snap:=public.ot_allowance_snapshot(p_section_id,p_period);
  if p_expected_snapshot is null or p_expected_snapshot is distinct from snap then raise exception 'OT_CHANGED: Reload and review before Request'; end if;
  if jsonb_array_length(snap->'rows')=0 then raise exception 'No positive OT or Allowance to request'; end if;
  select * into prior from public.ot_allowance_requests where section_id=p_section_id and period=p_period and snapshot_hash=md5(snap::text);
  if prior.id is not null and prior.snapshot is distinct from snap then raise exception 'Snapshot digest conflict'; end if;
  if prior.id is null then
   if exists(select 1 from public.ot_allowance_requests where section_id=p_section_id and requested_at>clock_timestamp()-interval '60 seconds') then
    raise exception 'Please wait 60 seconds before requesting changed data'; end if;
   select display_name into strict person from public.app_users where id=auth.uid();
   select code into strict dept from public.sections where id=p_section_id and is_active;
   insert into public.ot_allowance_requests(id,section_id,period,department_code,snapshot,snapshot_hash,requested_by,requested_name)
    values(p_request_id,p_section_id,p_period,dept,snap,md5(snap::text),auth.uid(),person) returning * into prior;
   insert into public.ot_request_outbox(request_id) values(prior.id);
   return jsonb_build_object('request_id',prior.id,'state','queued','already_requested',false);
  end if;
 end if;
 select state into st from public.ot_request_outbox where request_id=prior.id;
 return jsonb_build_object('request_id',prior.id,'state',st,'already_requested',true);
end $function$;
REVOKE ALL ON FUNCTION public.request_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_ot_allowance(p_section_id bigint, p_period date, p_expected_snapshot jsonb, p_request_id uuid) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.save_attendance_notice(p_period date, p_shift_deadline timestamp with time zone, p_ot_deadline timestamp with time zone, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare n public.attendance_notice%rowtype;
begin
 if not exists(select 1 from public.app_users where id=auth.uid() and is_active and role='SUPER_ADMIN') then
  raise exception 'NOTICE_FORBIDDEN: Central Admin only' using errcode='42501';
 end if;
 if p_period is null or extract(day from p_period)<>1 or p_period not between date '2020-01-01' and date '2100-12-01' or p_shift_deadline is null or p_ot_deadline is null or not isfinite(p_shift_deadline) or not isfinite(p_ot_deadline) then
  raise exception 'NOTICE_INVALID: Month and both deadlines required' using errcode='22023';
 end if;
 select * into n from public.attendance_notice where id=1 for update;
 if not found or p_expected_version is null or n.version<>p_expected_version then
  raise exception 'NOTICE_CHANGED: Reload notice before editing' using errcode='40001';
 end if;
 update public.attendance_notice set period=p_period,shift_deadline=p_shift_deadline,ot_deadline=p_ot_deadline,version=version+1,updated_at=now(),updated_by=auth.uid() where id=1;
 return public.get_attendance_notice();
end $function$;
REVOKE ALL ON FUNCTION public.save_attendance_notice(p_period date, p_shift_deadline timestamp with time zone, p_ot_deadline timestamp with time zone, p_expected_version integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_attendance_notice(p_period date, p_shift_deadline timestamp with time zone, p_ot_deadline timestamp with time zone, p_expected_version integer) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.stamp_attendance_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 new.updated_by := auth.uid(); new.updated_at := now(); return new;
end $function$;
REVOKE ALL ON FUNCTION public.stamp_attendance_edit() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.um_account_state(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select jsonb_build_object('id',a.id,'display_name',a.display_name,'role',a.role,'is_active',a.is_active,
 'username',case when lower(u.email) ~ '^[a-z0-9][a-z0-9_.-]{2,31}@mrta-attendance[.]invalid$' then split_part(lower(u.email),'@',1) else null end,
 'section_ids',coalesce((select jsonb_agg(s.section_id order by s.section_id) from public.user_sections s where s.user_id=a.id),'[]'::jsonb))
 from public.app_users a join auth.users u on u.id=a.id where a.id=p_id;
$function$;
REVOKE ALL ON FUNCTION public.um_account_state(p_id uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.um_begin(p_actor uuid, p_event uuid, p_action text, p_target uuid, p_plan jsonb, p_revision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare old jsonb; clean jsonb; sid bigint; uname text; r text; active boolean; actorname text;
begin
 perform pg_advisory_xact_lock(680015);
 if not exists(select 1 from public.app_users where id=p_actor and is_active and role='SUPER_ADMIN') then raise exception 'UM_FORBIDDEN'; end if;
 if p_action not in ('create','update','reset_password') or p_action is null then raise exception 'UM_INVALID'; end if;
 if exists(select 1 from public.user_admin_events where state='started') then raise exception 'UM_BUSY_OR_UNCERTAIN: Admin must inspect pending operation'; end if;
 if exists(select 1 from public.user_admin_events where id=p_event) then raise exception 'UM_DUPLICATE_EVENT: Refresh before next action'; end if;
 if (select count(*) from public.user_admin_events where actor_id=p_actor and created_at>clock_timestamp()-interval '1 minute')>=30 then raise exception 'UM_RATE_LIMIT'; end if;
 select split_part(lower(email),'@',1) into actorname from auth.users where id=p_actor;
 if p_action<>'create' then
  if p_target=p_actor then raise exception 'UM_SELF_EDIT_FORBIDDEN: Use another Central Admin'; end if;
  old:=public.um_account_state(p_target);
  if old is null then raise exception 'UM_TARGET_NOT_FOUND'; end if;
  if old->>'username' is null then raise exception 'UM_LEGACY_ACCOUNT: Migrate username first'; end if;
  if md5(old::text) is distinct from p_revision then raise exception 'UM_STALE: Refresh users'; end if;
 elsif p_target is not null then raise exception 'UM_INVALID_TARGET'; end if;
 if p_action='reset_password' then clean:=jsonb_build_object('username',old->>'username');
 else
  uname:=lower(trim(p_plan->>'username'));r:=p_plan->>'role';active:=(p_plan->>'is_active')::boolean;
  if uname is null or uname !~ '^[a-z0-9][a-z0-9_.-]{2,31}$' or r is null or r not in ('SUPER_ADMIN','DEPARTMENT_ADMIN','MANAGER') or active is null
   or length(trim(coalesce(p_plan->>'display_name',''))) not between 1 and 100 or jsonb_typeof(p_plan->'section_ids') is distinct from 'array' then raise exception 'UM_INVALID_PROFILE'; end if;
  if exists(select 1 from auth.users where lower(email)=uname||'@mrta-attendance.invalid' and id is distinct from p_target) then raise exception 'UM_USERNAME_EXISTS'; end if;
  if r='SUPER_ADMIN' and jsonb_array_length(p_plan->'section_ids')<>0 then raise exception 'UM_CENTRAL_NO_SECTIONS'; end if;
  if r<>'SUPER_ADMIN' and jsonb_array_length(p_plan->'section_ids')=0 then raise exception 'UM_DEPARTMENT_REQUIRED'; end if;
  if jsonb_array_length(p_plan->'section_ids')>100 then raise exception 'UM_TOO_MANY_SECTIONS'; end if;
  for sid in select value::bigint from jsonb_array_elements_text(p_plan->'section_ids') loop
   if not exists(select 1 from public.sections where id=sid and is_active) then raise exception 'UM_INACTIVE_SECTION'; end if;
  end loop;
  if old->>'role'='SUPER_ADMIN' and (old->>'is_active')::boolean and (r<>'SUPER_ADMIN' or not active)
   and (select count(*) from public.app_users where is_active and role='SUPER_ADMIN')<=1 then raise exception 'UM_LAST_ADMIN'; end if;
  clean:=jsonb_build_object('username',uname,'display_name',trim(p_plan->>'display_name'),'role',r,'is_active',active,
   'section_ids',(select coalesce(jsonb_agg(distinct value::bigint),'[]') from jsonb_array_elements_text(p_plan->'section_ids')));
 end if;
 insert into public.user_admin_events(id,actor_id,actor_username,action,target_id,plan,before_state) values(p_event,p_actor,actorname,p_action,p_target,clean,old);
 return clean;
end;
$function$;
REVOKE ALL ON FUNCTION public.um_begin(p_actor uuid, p_event uuid, p_action text, p_target uuid, p_plan jsonb, p_revision text) FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.um_finish(p_actor uuid, p_event uuid, p_target uuid, p_success boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare ev public.user_admin_events%rowtype; sid bigint;
begin
 perform pg_advisory_xact_lock(680015);
 select * into ev from public.user_admin_events where id=p_event for update;
 if not found or ev.actor_id<>p_actor or ev.state<>'started' then raise exception 'UM_EVENT_INVALID'; end if;
 if not exists(select 1 from public.app_users where id=p_actor and is_active and role='SUPER_ADMIN') then raise exception 'UM_FORBIDDEN'; end if;
 if not p_success then update public.user_admin_events set state='failed',finished_at=clock_timestamp() where id=p_event;return;end if;
 if p_target is null or (ev.target_id is not null and ev.target_id<>p_target) or not exists(select 1 from auth.users where id=p_target and lower(email)=((ev.plan->>'username')||'@mrta-attendance.invalid')) then raise exception 'UM_AUTH_TARGET_MISMATCH'; end if;
 if ev.action<>'create' and (public.um_account_state(p_target) - 'username') is distinct from (ev.before_state - 'username') then raise exception 'UM_PROFILE_CHANGED_DURING_OPERATION'; end if;
 if ev.action in ('create','update') then
  if ev.action='create' and exists(select 1 from public.app_users where id=p_target) then raise exception 'UM_PROFILE_EXISTS';end if;
  if ev.before_state->>'role'='SUPER_ADMIN' and (ev.before_state->>'is_active')::boolean and (ev.plan->>'role'<>'SUPER_ADMIN' or not (ev.plan->>'is_active')::boolean)
   and (select count(*) from public.app_users where is_active and role='SUPER_ADMIN')<=1 then raise exception 'UM_LAST_ADMIN'; end if;
  for sid in select value::bigint from jsonb_array_elements_text(ev.plan->'section_ids') loop
   if not exists(select 1 from public.sections where id=sid and is_active) then raise exception 'UM_INACTIVE_SECTION';end if;
  end loop;
  insert into public.app_users(id,display_name,role,is_active) values(p_target,ev.plan->>'display_name',ev.plan->>'role',(ev.plan->>'is_active')::boolean)
  on conflict(id) do update set display_name=excluded.display_name,role=excluded.role,is_active=excluded.is_active;
  delete from public.user_sections where user_id=p_target;
  insert into public.user_sections(user_id,section_id) select p_target,value::bigint from jsonb_array_elements_text(ev.plan->'section_ids');
 end if;
 update public.user_admin_events set target_id=p_target,state='completed',finished_at=clock_timestamp() where id=p_event;
end;
$function$;
REVOKE ALL ON FUNCTION public.um_finish(p_actor uuid, p_event uuid, p_target uuid, p_success boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.um_list(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare users_json jsonb;
begin
 if not exists(select 1 from public.app_users where id=p_actor and is_active and role='SUPER_ADMIN') then raise exception 'UM_FORBIDDEN'; end if;
 select coalesce(jsonb_agg(st || jsonb_build_object('revision',md5(st::text)) order by st->>'display_name'),'[]') into users_json
 from (select public.um_account_state(id) st from public.app_users) q;
 return jsonb_build_object('users',users_json,'sections',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,'is_active',is_active) order by code),'[]') from public.sections),
 'events',(select coalesce(jsonb_agg(x order by x.created_at desc),'[]') from (select id,actor_username,action,target_id,state,created_at,finished_at,plan->>'username' as target_username from public.user_admin_events order by created_at desc limit 50) x));
end;
$function$;
REVOKE ALL ON FUNCTION public.um_list(p_actor uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.upload_ta_ot_allowance(p_batch_id uuid, p_section_id bigint, p_period date, p_filename text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '5s'
AS $function$
declare
 who uuid:=auth.uid(); person text; item jsonb; f text; n numeric;
 a public.attendance%rowtype; e public.attendance_edits%rowtype;
 prior public.ot_allowance_upload_batches%rowtype;
 old_values jsonb; new_values jsonb; output jsonb;
 fields text[]:=array['ot15','ot20','ot30','meal','stand_by','emergency'];
 changed integer:=0; marker bigint; current_row_count integer;
 existing_remark text; appended_remark text;
begin
 if who is null or not exists(
  select 1 from public.app_users u join public.user_sections us on us.user_id=u.id
  join public.sections s on s.id=us.section_id
  where u.id=who and u.is_active and u.role='DEPARTMENT_ADMIN'
   and us.section_id=p_section_id and s.is_active
 ) then raise exception 'OT_UPLOAD_FORBIDDEN: Assigned active TA only'; end if;
 if p_batch_id is null or p_period is null or extract(day from p_period)<>1
  or p_period<date '0001-01-01' or p_period>date '9998-12-01' then
  raise exception 'OT_UPLOAD_INVALID: Invalid batch or month'; end if;
 if p_filename is null or length(p_filename) not between 1 and 200
  or p_filename ~ '[[:cntrl:]]' or p_filename !~* '\.xlsx$' then
  raise exception 'OT_UPLOAD_INVALID: Invalid filename'; end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' then
  raise exception 'OT_UPLOAD_INVALID: Rows must be an array'; end if;
 if jsonb_array_length(p_rows) not between 1 and 3100 or octet_length(p_rows::text)>4000000 then
  raise exception 'OT_UPLOAD_INVALID: 1-3100 rows, payload at most 4 MB'; end if;
 -- Same global lock order as approval; no lock held while user is reviewing.
 lock table public.app_users,public.user_sections,public.sections in share mode;
 lock table public.attendance in share row exclusive mode;
 lock table public.attendance_edits in share row exclusive mode;
 if not exists(select 1 from public.app_users u join public.user_sections us on us.user_id=u.id
   join public.sections s on s.id=us.section_id where u.id=who and u.is_active
   and u.role='DEPARTMENT_ADMIN' and s.is_active and s.id=p_section_id) then
  raise exception 'OT_UPLOAD_FORBIDDEN: TA access changed'; end if;
 -- UUID request id makes a retry safe even when the previous response was lost.
 select * into prior from public.ot_allowance_upload_batches where id=p_batch_id;
 if found then
  if prior.actor_id=who and prior.section_id=p_section_id and prior.period=p_period
    and prior.filename=p_filename and prior.payload=p_rows then
   return prior.result || jsonb_build_object('already_applied',true);
  end if;
  raise exception 'OT_UPLOAD_INVALID: Batch UUID already used for different data';
 end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'OT_UPLOAD_INVALID: Duplicate attendance rows'; end if;
 -- Validate ALL rows before writing any; generated totals cannot be supplied.
 for item in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(item)<>'object' then raise exception 'OT_UPLOAD_INVALID: Invalid row'; end if;
  if exists(select 1 from jsonb_object_keys(item) k where k not in ('id','gid','date','values','expected','expected_remark'))
   or not (item ?& array['id','gid','date','values','expected']) then
   raise exception 'OT_UPLOAD_INVALID: Invalid row fields'; end if;
  if jsonb_typeof(item->'values') is distinct from 'object'
    or jsonb_typeof(item->'expected') is distinct from 'object' then
   raise exception 'OT_UPLOAD_INVALID: Invalid numeric objects'; end if;
  if exists(select 1 from jsonb_object_keys(item->'values') k where not(k=any(fields)) and k<>'remark')
   or exists(select 1 from jsonb_object_keys(item->'expected') k where not(k=any(fields)))
   or not ((item->'expected') ?& fields)
   or (item->'values')='{}'::jsonb then
   raise exception 'OT_UPLOAD_INVALID: Only six OT/Allowance fields and Remark allowed'; end if;
  select * into a from public.attendance where id=(item->>'id')::uuid;
  if not found or a.section_id<>p_section_id or a.gid is distinct from item->>'gid'
   or a.work_date::text is distinct from item->>'date'
   or a.work_date<p_period or a.work_date>=(p_period+interval '1 month')::date then
   raise exception 'OT_UPLOAD_INVALID: Attendance/GID/date/department mismatch'; end if;
  select * into e from public.attendance_edits where attendance_id=a.id;
  old_values:=jsonb_build_object('ot15',e.ot15,'ot20',e.ot20,'ot30',e.ot30,
     'meal',e.meal,'stand_by',e.stand_by,'emergency',e.emergency);
  if old_values is distinct from item->'expected' then
   raise exception 'OT_UPLOAD_CHANGED: Data changed since preview. Reload and review.'; end if;
  if (item->'values') ? 'remark' then
   if jsonb_typeof(item->'values'->'remark') is distinct from 'string'
     or jsonb_typeof(item->'expected_remark') is distinct from 'string' then
    raise exception 'OT_UPLOAD_INVALID: Remark and expected_remark must be strings'; end if;
   existing_remark:=coalesce(e.manual_remark,a.auto_remark,'');
   if existing_remark is distinct from item->>'expected_remark' then
    raise exception 'OT_UPLOAD_CHANGED: Remark changed since preview. Reload and review.'; end if;
   appended_remark:=btrim(item->'values'->>'remark');
   if length(appended_remark) not between 1 and 1000
     or appended_remark ~ '[\x01-\x08\x0B\x0C\x0E-\x1F]' then
    raise exception 'OT_UPLOAD_INVALID: Remark must be 1-1000 characters without control characters'; end if;
   if btrim(existing_remark)<>'' then appended_remark:=existing_remark||', '||appended_remark; end if;
   if length(appended_remark)>1000 then
    raise exception 'OT_UPLOAD_INVALID: Combined Remark exceeds 1000 characters'; end if;
  end if;
  foreach f in array fields loop
   if (item->'values') ? f then
    if jsonb_typeof(item->'values'->f) is distinct from 'number' then
     raise exception 'OT_UPLOAD_INVALID: Values must be numeric, blank keys omitted'; end if;
    n:=(item->'values'->>f)::numeric;
    if n<0 or n<>round(n,2) or n>(case when f in ('ot15','ot20','ot30') then 9999.99 else 9999999.99 end) then
     raise exception 'OT_UPLOAD_INVALID: Negative/precision/range error'; end if;
   end if;
  end loop;
 end loop;
 select coalesce(max(id),0) into marker from public.attendance_edit_history;
 for item in select value from jsonb_array_elements(p_rows) loop
  select * into e from public.attendance_edits where attendance_id=(item->>'id')::uuid;
  old_values:=jsonb_build_object('ot15',e.ot15,'ot20',e.ot20,'ot30',e.ot30,
    'meal',e.meal,'stand_by',e.stand_by,'emergency',e.emergency);
  new_values:=old_values || ((item->'values')-'remark');
  appended_remark:=e.manual_remark;
  if (item->'values') ? 'remark' then
   select * into a from public.attendance where id=(item->>'id')::uuid;
   existing_remark:=coalesce(e.manual_remark,a.auto_remark,'');
   appended_remark:=btrim(item->'values'->>'remark');
   if btrim(existing_remark)<>'' then appended_remark:=existing_remark||', '||appended_remark; end if;
  end if;
  if new_values is distinct from old_values or appended_remark is distinct from e.manual_remark then
   insert into public.attendance_edits(attendance_id,ot15,ot20,ot30,meal,stand_by,emergency,manual_remark)
   values((item->>'id')::uuid,(new_values->>'ot15')::numeric,(new_values->>'ot20')::numeric,
    (new_values->>'ot30')::numeric,(new_values->>'meal')::numeric,
    (new_values->>'stand_by')::numeric,(new_values->>'emergency')::numeric,appended_remark)
   on conflict(attendance_id) do update set
    ot15=excluded.ot15,ot20=excluded.ot20,ot30=excluded.ot30,
    meal=excluded.meal,stand_by=excluded.stand_by,emergency=excluded.emergency,
    manual_remark=excluded.manual_remark;
   changed:=changed+1;
  end if;
 end loop;
 -- Existing audit/revision triggers record field changes and invalidate old approval.
 -- Attach upload provenance only to this transaction's freshly generated field history.
 update public.attendance_edit_history set
   change_reason='Upload OT&Allowance | '||p_filename||' | Batch '||p_batch_id::text
 where id>marker and actor_id=who and source_table='attendance_edits'
   and section_id=p_section_id
   and attendance_id in(select (x->>'id')::uuid from jsonb_array_elements(p_rows) x);
 select display_name into strict person from public.app_users where id=who;
 output:=jsonb_build_object('batch_id',p_batch_id,'input_rows',jsonb_array_length(p_rows),
    'changed_rows',changed,'already_applied',false);
 insert into public.ot_allowance_upload_batches(id,section_id,period,actor_id,actor_name,filename,payload,result)
  values(p_batch_id,p_section_id,p_period,who,person,p_filename,p_rows,output);
 return output;
end $function$;
REVOKE ALL ON FUNCTION public.upload_ta_ot_allowance(p_batch_id uuid, p_section_id bigint, p_period date, p_filename text, p_rows jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upload_ta_ot_allowance(p_batch_id uuid, p_section_id bigint, p_period date, p_filename text, p_rows jsonb) TO authenticated;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.validate_attendance_leave_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.attendance%rowtype; oldo jsonb; k text; v jsonb;
 n numeric; label text; half text;
begin
 oldo:=case when TG_OP='INSERT' then '{}'::jsonb else OLD.leave_overrides end;
 if jsonb_typeof(NEW.leave_overrides) is distinct from 'object' then raise exception 'leave_overrides must be an object'; end if;
 if oldo is not distinct from NEW.leave_overrides then
  if TG_OP='UPDATE' and NEW.leave_change_reason is distinct from OLD.leave_change_reason then raise exception 'Reason can only change with Leave overrides'; end if;
  return NEW;
 end if;
 select * into strict a from public.attendance where id=NEW.attendance_id;
 if auth.uid() is not null and not exists(select 1 from public.app_users u where u.id=auth.uid() and u.is_active and u.role='DEPARTMENT_ADMIN' and public.attendance_access(a.section_id,false)) then raise exception 'Department Admin for this section required'; end if;
 if NEW.leave_change_reason is null or length(btrim(NEW.leave_change_reason)) not between 3 and 1000 or NEW.leave_change_reason ~ '[[:cntrl:]]' then raise exception 'Leave edit/reset reason required, 3-1000 characters'; end if;
 for k,v in select * from jsonb_each(NEW.leave_overrides) loop
  if k not in ('leave_units','leave_type','leave_half') then raise exception 'Unsupported Leave override field %',k; end if;
  if k='leave_units' and v<>'null'::jsonb then
   if jsonb_typeof(v) is distinct from 'number' then raise exception 'Leave must be numeric'; end if;
   if (v #>> '{}')::numeric not in (0,0.5,1) then raise exception 'Leave must be blank, 0, 0.5 or 1'; end if;
  elsif k='leave_type' and v<>'null'::jsonb then
   if jsonb_typeof(v) is distinct from 'string' or length(v #>> '{}')>200 or (v #>> '{}') ~ '[[:cntrl:]]' then raise exception 'Invalid Leave Type'; end if;
  elsif k='leave_half' and v<>'null'::jsonb then
   if jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') not in ('FULL_DAY','FIRST_HALF','SECOND_HALF','UNRESOLVED') then raise exception 'Invalid Leave Half'; end if;
  end if;
 end loop;
 -- Returning to matching remains possible with an incomplete legacy baseline.
 if NEW.leave_overrides='{}'::jsonb then return NEW; end if;
 n:=case when NEW.leave_overrides ? 'leave_units' then (NEW.leave_overrides->>'leave_units')::numeric else a.leave_units end;
 label:=case when NEW.leave_overrides ? 'leave_type' then NEW.leave_overrides->>'leave_type' else a.leave_type end;
 half:=case when NEW.leave_overrides ? 'leave_half' then NEW.leave_overrides->>'leave_half' else a.leave_half end;
 if n>0 and nullif(btrim(label),'') is null then raise exception 'Leave Type required for positive Leave'; end if;
 if NEW.leave_overrides ? 'leave_units' then
  if not (NEW.leave_overrides ? 'leave_half') then raise exception 'Manual Leave units require Leave Half key'; end if;
  if n=1 and half is distinct from 'FULL_DAY' then raise exception 'Full-day Leave requires FULL_DAY'; end if;
  if n=0.5 and (half is null or half not in ('FIRST_HALF','SECOND_HALF','UNRESOLVED')) then raise exception 'Half-day Leave requires a half-day selection'; end if;
  if (n is null or n=0) and half is not null then raise exception 'No Leave must not have Leave Half'; end if;
 end if;
 return NEW;
end $function$;
REVOKE ALL ON FUNCTION public.validate_attendance_leave_override() FROM PUBLIC, anon, authenticated, service_role;

-- Owner in source: postgres
-- Source ACL: {postgres=X/postgres}
CREATE OR REPLACE FUNCTION public.validate_attendance_time_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.attendance%rowtype; oldo jsonb; k text; v jsonb; t timestamptz;
 wi timestamptz; wo timestamptz; ri timestamptz; ro timestamptz; shift_code text; start_day timestamptz; changed boolean;
begin
 oldo:=case when TG_OP='INSERT' then '{}'::jsonb else OLD.time_overrides end;
 if jsonb_typeof(NEW.time_overrides) is distinct from 'object' then raise exception 'time_overrides must be an object'; end if;
 changed:=oldo is distinct from NEW.time_overrides;
 if not changed and TG_OP='UPDATE' and NEW.time_change_reason is distinct from OLD.time_change_reason then
  raise exception 'Reason can only change with time overrides';
 end if;
 if not changed then return NEW; end if;
 select * into strict a from public.attendance where id=NEW.attendance_id;
 -- Browser time edits are department-only; SQL/service activity remains attributable as system.
 if auth.uid() is not null and not exists(select 1 from public.app_users u where u.id=auth.uid() and u.is_active and u.role='DEPARTMENT_ADMIN' and public.attendance_access(a.section_id,false)) then
  raise exception 'Department Admin for this section required';
 end if;
 if NEW.time_change_reason is null or length(btrim(NEW.time_change_reason)) not between 3 and 1000 or NEW.time_change_reason ~ '[[:cntrl:]]' then raise exception 'Time edit/reset reason required, 3-1000 characters'; end if;
 start_day:=(a.work_date::text||'T00:00:00+07:00')::timestamptz;
 for k,v in select * from jsonb_each(NEW.time_overrides) loop
  if k not in ('shift','working_in','working_out','real_in','real_out') then raise exception 'Unsupported override field %',k; end if;
  if k='shift' then
   if jsonb_typeof(v)<>'string' or (v #>> '{}') !~ '^([A-Z][A-Z0-9]{0,7})?$' then raise exception 'Invalid shift code'; end if;
  elsif v<>'null'::jsonb then
   if jsonb_typeof(v)<>'string' or (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:00[+]07:00$' then raise exception 'Manual time must be Bangkok timestamp'; end if;
   t:=public.attendance_time_iso(v #>> '{}',a.work_date);
   if t<start_day-interval '1 day' or t>start_day+interval '3 days' then raise exception 'Manual time outside work date window'; end if;
  end if;
 end loop;
 -- A reset to {} remains possible even when an old import has incomplete baseline fields.
 if NEW.time_overrides='{}'::jsonb then return NEW; end if;
  -- MRTA17 independent Actual validation
 -- Validate a pair only when that group changed. Do not require repairing unrelated baseline.
 if (oldo - 'real_in' - 'real_out') is distinct from (NEW.time_overrides - 'real_in' - 'real_out') then
  shift_code:=case when NEW.time_overrides ? 'shift' then NEW.time_overrides->>'shift' else a.shift end;
  wi:=public.attendance_time_iso(case when NEW.time_overrides ? 'working_in' then NEW.time_overrides->>'working_in' else a.working_in end,a.work_date);
  wo:=public.attendance_time_iso(case when NEW.time_overrides ? 'working_out' then NEW.time_overrides->>'working_out' else a.working_out end,a.work_date);
  if (wi is null)<>(wo is null) then raise exception 'Working In/Out must be a pair'; end if;
  if coalesce(shift_code,'')='' and wi is not null then raise exception 'Rest day must not have Working times'; end if;
  if coalesce(shift_code,'')<>'' and shift_code not in ('AL','SL','RL','CL','ML','PL') and wi is null then raise exception 'Working shift needs Working times'; end if;
  if wi is not null and (wo<=wi or wo-wi>interval '36 hours') then raise exception 'Invalid Working interval'; end if;
 end if;
 if (oldo - 'shift' - 'working_in' - 'working_out') is distinct from (NEW.time_overrides - 'shift' - 'working_in' - 'working_out') then
  ri:=public.attendance_time_iso(case when NEW.time_overrides ? 'real_in' then NEW.time_overrides->>'real_in' else a.real_in end,a.work_date);
  ro:=public.attendance_time_iso(case when NEW.time_overrides ? 'real_out' then NEW.time_overrides->>'real_out' else a.real_out end,a.work_date);
  if ri is not null and ro is not null and (ro<=ri or ro-ri>interval '36 hours') then raise exception 'Invalid Actual interval'; end if;
 end if;
 return NEW;
end $function$;
REVOKE ALL ON FUNCTION public.validate_attendance_time_override() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
