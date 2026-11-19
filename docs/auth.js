(()=>{
'use strict';
const logoutButton=document.getElementById('logout');const $=id=>id==='logout'?logoutButton:document.getElementById(id);let session=null,timer=null,generation=0;
function config(){const c=window.ARL_CONFIG||{};const u=new URL(c.supabaseUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('Project URL ต้องเป็น https://PROJECT.supabase.co');const k=c.supabasePublishableKey||'';if(!k.startsWith('sb_publishable_')){try{let p=k.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');const claims=JSON.parse(atob(p));if(claims.role!=='anon')throw Error();}catch{throw Error('ใส่ Publishable key หรือ legacy anon key ใน public/config.js เท่านั้น ห้ามใช้ secret/service_role');}}return {url:u.origin,key:k};}
function loginAlias(value){const username=String(value||'').trim().toLowerCase();if(!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username))throw Error('Username ต้องมี 3–32 ตัวอักษร a–z, 0–9, จุด, ขีดกลาง หรือขีดล่าง');return username+'@arl-attendance.invalid';}
const status=t=>{$('status').textContent=t;};
function clear(keepLocal=false){document.querySelector('header').appendChild(logoutButton);window.AttendanceDB=null;const keep=keepLocal&&$('workspace').querySelector('iframe')?.contentWindow?.AttendanceManual?.hasEdits();generation++;clearTimeout(timer);session=null;if(!keep)$('workspace').replaceChildren();$('workspace').hidden=!keep;$('login-panel').hidden=false;$('logout').hidden=true;$('account').textContent='';$('password').value='';return keep;}
async function api(path,options={},token){const c=config();const headers={apikey:c.key,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})};if(options.prefer)headers.Prefer=options.prefer;const response=await fetch(c.url+path,{...options,headers,credentials:'omit',cache:'no-store'});let data;try{data=await response.json();}catch{data=null;}if(!response.ok)throw Error(path.startsWith('/functions/v1/user-management')?(data?.message||'User Management ไม่พร้อม · ตรวจ Edge Function / SQL15'): (data?.message?.includes('NOTICE_')||data?.message?.includes('OT_UPLOAD_')||data?.message?.includes('OT_MAILTO_')||data?.message?.includes('CENTRAL_OT_'))?data.message:data?.message?.includes('OT_CHANGED')?'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดและตรวจใหม่ก่อนอนุมัติ':response.status===401||response.status===400?'Login ไม่สำเร็จหรือ Session หมดอายุ ตรวจ Username/Password หากยังเข้าไม่ได้ให้ติดต่อ Admin':'Supabase request ไม่สำเร็จ HTTP '+response.status);return data;}
async function verify(s){if(!s?.access_token||!s?.user?.id)throw Error('ไม่ได้รับ Session ที่ถูกต้อง');const rows=await api('/rest/v1/app_users?select=id,display_name,role,is_active&id=eq.'+encodeURIComponent(s.user.id),{},s.access_token);if(rows.length!==1||!rows[0].is_active||!['SUPER_ADMIN','DEPARTMENT_ADMIN','MANAGER'].includes(rows[0].role))throw Error('บัญชีต้อง active และมี Role/สิทธิ์แผนกที่รองรับ');const sections=await api('/rest/v1/sections?select=id,code,name&is_active=eq.true&order=code',{},s.access_token);const assigned=rows[0].role!=='SUPER_ADMIN'?await api('/rest/v1/user_sections?select=section_id',{},s.access_token):null;return {profile:rows[0],sections:assigned?sections.filter(x=>assigned.some(a=>a.section_id===x.id)):sections};}
function schedule(){clearTimeout(timer);timer=setTimeout(async()=>{const g=generation;try{const s=await api('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})});const info=await verify(s);if(g!==generation)return;session=s;installBridge(info);showAccount(info);schedule();}catch{if(g!==generation)return;const kept=clear(true);status('Session หมดอายุหรือสิทธิ์เปลี่ยน กรุณา Login ใหม่'+(kept?' — เก็บตารางในเครื่องไว้ให้ดาวน์โหลด Excel ก่อน; ไม่มี Token/Database access':''));}},Math.max(1000,(session.expires_in||3600)*1000-60000));}
function showAccount(info){$('account').textContent=info.profile.display_name+' · '+info.profile.role+' · '+info.sections.length+' แผนก';}
function monthBounds(period){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||+period.slice(0,4)<1||+period.slice(0,4)>9998)throw Error('เดือนผิดรูปแบบ');const [y,m]=period.split('-').map(Number);return {start:period+'-01',end:(m===12?String(y+1).padStart(4,'0')+'-01':String(y).padStart(4,'0')+'-'+String(m+1).padStart(2,'0'))+'-01'};}
function installBridge(info){
 const g=generation;
 async function request(path,opts={}){if(g!==generation||!session)throw Error('Session หมดอายุ กรุณา Login ใหม่');const data=await api(path,opts,session.access_token);if(g!==generation||!session)throw Error('Session เปลี่ยน กรุณา Login ใหม่');return data;}
 window.AttendanceDB={profile:info.profile,sections:info.sections,
  getNotice:async()=>request('/rest/v1/rpc/get_attendance_notice',{method:'POST',body:'{}'}),
  saveNotice:async(payload)=>{if(info.profile.role!=='SUPER_ADMIN')throw Error('Central Admin เท่านั้นที่แก้ประกาศได้');return request('/rest/v1/rpc/save_attendance_notice',{method:'POST',body:JSON.stringify(payload)});},
  manageUsers:async(payload)=>{if(info.profile.role!=='SUPER_ADMIN')throw Error('Central Admin เท่านั้น');return request('/functions/v1/user-management',{method:'POST',body:JSON.stringify(payload)});},
  centralSummary:async(period)=>{monthBounds(period);if(info.profile.role!=='SUPER_ADMIN')throw Error('Central only');return request('/rest/v1/rpc/get_central_ot_summary',{method:'POST',body:JSON.stringify({p_period:period+'-01'})});},
  centralAction:async(period,action,summary,id)=>{monthBounds(period);if(info.profile.role!=='SUPER_ADMIN')throw Error('Central only');return request('/rest/v1/rpc/prepare_central_ot_action',{method:'POST',body:JSON.stringify({p_period:period+'-01',p_action:action,p_expected_summary:summary,p_event_id:id})});},
  load:async(period)=>{const bounds=monthBounds(period);let rows=[];for(let offset=0;;offset+=500){const data=await request('/rest/v1/attendance?select=*,attendance_edits(*)&work_date=gte.'+bounds.start+'&work_date=lt.'+bounds.end+'&order=section_id,gid,work_date&limit=500&offset='+offset);rows.push(...data);if(rows.length>12000)throw Error('เกิน 12000 แถวต่อเดือน');if(data.length<500)break;}return rows;},
  getApproval:async(section,period)=>{monthBounds(period);if(!info.sections.some(s=>s.id===section))throw Error('ไม่มีสิทธิ์แผนกนี้');return request('/rest/v1/rpc/get_ot_allowance_approval',{method:'POST',body:JSON.stringify({p_section_id:section,p_period:period+'-01'})});},
  approve:async(section,period,snapshot)=>{monthBounds(period);if(info.profile.role!=='MANAGER'||!info.sections.some(s=>s.id===section))throw Error('Manager ที่ได้รับมอบหมายเท่านั้น');return request('/rest/v1/rpc/approve_ot_allowance',{method:'POST',body:JSON.stringify({p_section_id:section,p_period:period+'-01',p_expected_snapshot:snapshot})});},
  prepareRequestMail:async(section,period,snapshot,id)=>{monthBounds(period);if(info.profile.role!=='DEPARTMENT_ADMIN'||!info.sections.some(s=>s.id===section))throw Error('OT_MAILTO_FORBIDDEN: Assigned TA only');return request('/rest/v1/rpc/prepare_ot_allowance_mailto',{method:'POST',body:JSON.stringify({p_section_id:section,p_period:period+'-01',p_expected_snapshot:snapshot,p_request_id:id})});},
  uploadOT:async(batch,section,period,filename,rows)=>{monthBounds(period);if(info.profile.role!=='DEPARTMENT_ADMIN'||!info.sections.some(s=>s.id===section))throw Error('OT_UPLOAD_FORBIDDEN: TA ของแผนกเท่านั้น');return request('/rest/v1/rpc/upload_ta_ot_allowance',{method:'POST',body:JSON.stringify({p_batch_id:batch,p_section_id:section,p_period:period+'-01',p_filename:filename,p_rows:rows})});},
  importRows:async(rows)=>{if(info.profile.role!=='SUPER_ADMIN')throw Error('Central Admin เท่านั้น');if(!Array.isArray(rows)||!rows.length||rows.length>3100)throw Error('นำเข้าได้ 1–3100 แถวต่อครั้ง');
   let period=null;
   for(const x of rows){
    if(!x||typeof x.work_date!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x.work_date))throw Error('วันที่นำเข้าไม่ถูกต้อง');
    const ym=x.work_date.slice(0,7);monthBounds(ym);const [y,m,d]=x.work_date.split('-').map(Number);
    if(y<2020||y>2100||d>new Date(Date.UTC(y,m,0)).getUTCDate())throw Error('วันที่นำเข้าไม่ถูกต้องหรือปีอยู่นอกช่วง 2020–2100');
    if(period&&period!==ym)throw Error('นำเข้าได้เดือนเดียวต่อครั้ง');period=ym;
    if(!info.sections.some(s=>s.id===x.section_id))throw Error('ไม่มีสิทธิ์นำเข้าแผนกนี้ หรือแผนกไม่ได้เปิดใช้งาน');
   }
   return request('/rest/v1/attendance?on_conflict=section_id,gid,work_date',{method:'POST',body:JSON.stringify(rows),prefer:'resolution=merge-duplicates,return=minimal'});},
  loadHistory:async(period)=>{
   if(info.profile.role!=='SUPER_ADMIN')throw Error('Central Admin เท่านั้น');
   const bounds=monthBounds(period);
   async function pages(query){const rows=[];for(let offset=0;;offset+=500){const data=await request(query+'&limit=500&offset='+offset);rows.push(...data);if(data.length<500)break;}return rows;}
   const results=await Promise.allSettled([
    pages('/rest/v1/attendance_edit_history?select=*&work_date=gte.'+bounds.start+'&work_date=lt.'+bounds.end+'&order=changed_at.desc,id.desc'),
    pages('/rest/v1/ot_allowance_approvals?select=id,section_id,period,approved_by,approved_name,approved_at,department:snapshot->>department&period=eq.'+bounds.start+'&order=approved_at.desc,id.desc'),
    pages('/rest/v1/ot_mailto_request_events?select=id,section_id,period,section_code,requested_by,requested_name,requested_at,row_count,total_ot,total_allowance&period=eq.'+bounds.start+'&order=requested_at.desc,id.desc'),
    pages('/rest/v1/central_ot_events?select=id,period,action,actor_id,actor_name,created_at,summary&period=eq.'+bounds.start+'&order=created_at.desc,id.desc')
   ]);
   if(results[0].status==='rejected')throw results[0].reason;
   const rows=results[0].value;
   if(results[1].status==='fulfilled')for(const a of results[1].value){rows.push({
    id:a.id,event_type:'approval',changed_at:a.approved_at,actor_id:a.approved_by,actor_name:a.approved_name,actor_role:'MANAGER',
    section_code:info.sections.find(s=>s.id===a.section_id)?.code||a.department||'-'
   });}
   else rows.approvalWarning='โหลดประวัติอนุมัติไม่สำเร็จ: '+results[1].reason.message+' · ตรวจ SQL 07/สิทธิ์อ่าน Approval';
   if(results[2].status==='fulfilled')for(const a of results[2].value)rows.push({
    id:a.id,event_type:'request',changed_at:a.requested_at,actor_id:a.requested_by,actor_name:a.requested_name,actor_role:'TA',
    section_code:a.section_code,period:a.period,row_count:a.row_count,total_ot:a.total_ot,total_allowance:a.total_allowance
   });else rows.requestWarning='โหลดประวัติ Request ไม่สำเร็จ · ตรวจ SQL12/สิทธิ์อ่าน';
   if(results[3].status==='fulfilled')for(const a of results[3].value)rows.push({id:a.id,event_type:'central',changed_at:a.created_at,actor_id:a.actor_id,actor_name:a.actor_name,actor_role:'Central Admin',section_code:'All Department',period:a.period,action:a.action});else rows.centralWarning='โหลดประวัติ Central ไม่สำเร็จ · ตรวจ SQL13';
   // Resolve each event's actor UUID, never the currently logged-in viewer or display_name.
   const ids=[...new Set(rows.map(h=>h.actor_id).filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
   const usernames=new Map();
   try{
    for(let offset=0;offset<ids.length;offset+=500){
     const data=await request('/rest/v1/rpc/get_history_actor_usernames',{method:'POST',body:JSON.stringify({p_actor_ids:ids.slice(offset,offset+500)})});
     if(!Array.isArray(data))throw Error('Invalid username response');
     for(const u of data)if(typeof u.username==='string'&&/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(u.username))usernames.set(u.actor_id,u.username);
    }
   }catch{rows.usernameWarning='โหลด Username ไม่ครบ · ตรวจ SQL14/สิทธิ์อ่าน; รายการที่หาไม่พบแสดงชื่อเดิมพร้อมระบุว่าไม่มี Username';}
   for(const h of rows)h.actor_username=usernames.get(h.actor_id)||null;
   rows.sort((a,b)=>Date.parse(b.changed_at)-Date.parse(a.changed_at)||String(b.id).localeCompare(String(a.id),'en',{numeric:true})||String(a.event_type||'edit').localeCompare(String(b.event_type||'edit')));
   return rows;
  },
  saveEdit:async(id,values)=>{if(info.profile.role!=='DEPARTMENT_ADMIN')throw Error('บัญชีแผนกเท่านั้นที่แก้ไขได้');const old=await request('/rest/v1/attendance_edits?select=attendance_id&attendance_id=eq.'+encodeURIComponent(id));return old.length?request('/rest/v1/attendance_edits?attendance_id=eq.'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(values)}):request('/rest/v1/attendance_edits',{method:'POST',body:JSON.stringify({attendance_id:id,...values})});}
 };
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();if($('workspace').querySelector('iframe')?.contentWindow?.AttendanceManual?.hasEdits()&&!confirm('Login ใหม่จะเปิดตารางใหม่และล้างค่าที่คีย์เดิม ดาวน์โหลด Excel เก็บงานก่อน ต้องการ Login ใหม่หรือไม่?'))return;$('login').disabled=true;const g=generation;let candidate;try{status('กำลังตรวจบัญชีและสิทธิ์…');candidate=await api('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:loginAlias($('username').value),password:$('password').value})});const info=await verify(candidate);if(g!==generation)return;session=candidate;$('password').value='';showAccount(info);$('login-panel').hidden=true;$('logout').hidden=false;$('workspace').hidden=false;installBridge(info);const f=document.createElement('iframe');f.title='Excel-first local matching';f.addEventListener('load',()=>{if(!session||g!==generation||$('workspace').querySelector('iframe')!==f)return;f.contentDocument.querySelector('.profile')?.appendChild(logoutButton);});f.src='./excel-first.html?v=arl-0.1.0';$('workspace').replaceChildren(f);schedule();}catch(error){if(candidate?.access_token){try{await api('/auth/v1/logout?scope=local',{method:'POST'},candidate.access_token);}catch{}}clear(true);status(error.message);}finally{$('login').disabled=false;}});
$('logout').addEventListener('click',async()=>{const f=$('workspace').querySelector('iframe');if(f?.contentWindow?.AttendanceManual?.hasEdits()&&!confirm('มีค่าที่คีย์ใน RAM ออกจากระบบแล้วค่าจะหาย ดาวน์โหลด Excel เก็บงานก่อน ต้องการออกหรือไม่?'))return;const token=session?.access_token;clear();status('ออกจากระบบในเครื่องแล้ว');if(token){try{await api('/auth/v1/logout?scope=local',{method:'POST'},token);}catch{status('ออกจากเครื่องแล้ว แต่แจ้ง Supabase ไม่สำเร็จ Token เดิมอาจยังใช้ได้จนหมดอายุ');}}});
window.addEventListener('beforeunload',e=>{if($('workspace').querySelector('iframe')?.contentWindow?.AttendanceManual?.hasEdits()){e.preventDefault();e.returnValue='';}});
try{config();}catch(error){status(error.message);}
})();
