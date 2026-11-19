
(() => {

  const departmentAliases = Object.freeze({"PSD/PID":"PSD_PID","PSY/GRS":"PSY_GRS","TRW/TRD":"TRW_TRD"});
  const departmentLabels = Object.freeze({"PSD_PID":"PSD/PID","PSY_GRS":"PSY/GRS","TRW_TRD":"TRW/TRD"});
  const canonicalDepartment = code => Object.prototype.hasOwnProperty.call(departmentAliases, code) ? departmentAliases[code] : code;
  const displayDepartment = code => Object.prototype.hasOwnProperty.call(departmentLabels, code) ? departmentLabels[code] : code;

  const MAX_FILE = 10 * 1024 * 1024;
  const MAX_XML = 128 * 1024 * 1024;
  const MAX_TOTAL = 256 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function fail(message) { throw new Error(message); }
  const crcTable = Array.from({length:256}, (_, i) => {
    let c = i; for (let k=0;k<8;k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  function crc32(bytes) { let c=0xffffffff; for (const b of bytes) c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
  function zipDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--) {
      if (view.getUint32(p,true)===0x06054b50 && p+22+view.getUint16(p+20,true)===bytes.length) { eocd=p; break; }
    }
    if (eocd<0) fail('ไฟล์ไม่ใช่ XLSX ZIP ที่รองรับ');
    const count=view.getUint16(eocd+10,true), size=view.getUint32(eocd+12,true), start=view.getUint32(eocd+16,true);
    if (view.getUint16(eocd+4,true)!==0 || view.getUint16(eocd+6,true)!==0 || view.getUint16(eocd+8,true)!==count || count>128 || start+size>eocd) fail('ไม่รองรับ ZIP แบบนี้');
    const entries=new Map();let p=start;let total=0;
    for (let i=0;i<count;i++) {
      if (p+46>start+size || view.getUint32(p,true)!==0x02014b50) fail('ZIP directory เสียหาย');
      const flags=view.getUint16(p+8,true),method=view.getUint16(p+10,true),crc=view.getUint32(p+16,true);
      const packed=view.getUint32(p+20,true),raw=view.getUint32(p+24,true),nameLength=view.getUint16(p+28,true),extra=view.getUint16(p+30,true),comment=view.getUint16(p+32,true),offset=view.getUint32(p+42,true);
      if (p+46+nameLength+extra+comment>start+size) fail('ZIP directory เสียหาย');
      const name=decoder.decode(bytes.subarray(p+46,p+46+nameLength));
      if (flags & 1 || ![0,8].includes(method) || raw>MAX_XML || raw===0xffffffff || packed===0xffffffff || offset===0xffffffff || view.getUint16(p+34,true)!==0 || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') || entries.has(name)) fail('พบโครงสร้าง ZIP ที่ไม่รองรับ');
      total+=raw;if(total>MAX_TOTAL)fail('ไฟล์ Excel มีขนาดภายในใหญ่เกินกำหนด');
      entries.set(name,{name,flags,method,crc,packed,raw,offset});p+=46+nameLength+extra+comment;
    }
    if(p!==start+size)fail('ZIP directory เสียหาย');
    return { entries, view, start };
  }
  async function unzipText(bytes, directory, name) {
    const entry=directory.entries.get(name);if(!entry)fail('ไม่พบส่วนประกอบ Excel: '+name);
    const p=entry.offset,view=directory.view;
    if(p+30>directory.start || view.getUint32(p,true)!==0x04034b50 || view.getUint16(p+8,true)!==entry.method || view.getUint16(p+6,true)!==entry.flags)fail('ZIP entry เสียหาย');
    const n=view.getUint16(p+26,true),extra=view.getUint16(p+28,true),start=p+30+n+extra;
    if(start+entry.packed>directory.start || decoder.decode(bytes.subarray(p+30,p+30+n))!==name)fail('ZIP entry เสียหาย');
    const packed=bytes.subarray(start,start+entry.packed);let raw;
    if(entry.method===0)raw=packed;
    else {
      let stream;
      try { stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
      catch { fail('เบราว์เซอร์ไม่รองรับ XLSX reader นี้ กรุณาใช้ Chrome หรือ Edge รุ่นปัจจุบัน'); }
      const reader=stream.getReader(),chunks=[];let length=0;
      try {
        while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;
          if(length>entry.raw || length>MAX_XML){await reader.cancel();fail('ข้อมูลภายใน Excel ใหญ่เกินกำหนด');}chunks.push(item.value);}
      }finally{reader.releaseLock();}
      raw=new Uint8Array(length);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}
    }
    if(raw.length!==entry.raw || crc32(raw)!==entry.crc)fail('ตรวจความสมบูรณ์ของไฟล์ Excel ไม่ผ่าน');
    return decoder.decode(raw);
  }
  function xml(text) {
    if(/<!DOCTYPE|<!ENTITY/i.test(text))fail('ไม่รองรับ XML ที่ประกาศ entity');
    const doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.getElementsByTagName('parsererror').length || doc.getElementsByTagNameNS('*','parsererror').length)fail('XML ใน Excel เสียหาย');return doc;
  }
  function elements(root,name){return Array.from(root.getElementsByTagNameNS('*',name));}
  function textRuns(root){return elements(root,'t').map(e=>e.textContent).join('');}
  function column(n){let out='';while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;}
  async function readWorksheet(file, expectedName = 'ShiftPlan', allowShiftHeaderFormulas = expectedName==='ShiftPlan') {
    if(!file || !file.name.toLowerCase().endsWith('.xlsx') || file.size<22 || file.size>MAX_FILE)fail('ใช้ไฟล์ .xlsx ขนาดไม่เกิน 10 MB เท่านั้น');
    const bytes=new Uint8Array(await file.arrayBuffer());const directory=zipDirectory(bytes);
    const workbook=xml(await unzipText(bytes,directory,'xl/workbook.xml'));
    const sheets=elements(workbook,'sheet');
    const chosen=expectedName===null?sheets.slice(0,1):sheets.filter(sheet=>sheet.getAttribute('name')===expectedName);if(chosen.length!==1)fail(expectedName===null?'ไม่พบชีตแรกในไฟล์':'ต้องพบชีต '+expectedName+' หนึ่งชีต');
    const rels=xml(await unzipText(bytes,directory,'xl/_rels/workbook.xml.rels'));
    const id=chosen[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
    const rel=elements(rels,'Relationship').find(r=>r.getAttribute('Id')===id);
    if(!rel || rel.getAttribute('TargetMode')==='External')fail('ไม่พบชีต ShiftPlan');
    const target=rel.getAttribute('Target');
    if(!target || target.includes('..') || target.includes('\\') || target.includes(':'))fail('Sheet path ไม่รองรับ');
    const sheetPath=target.startsWith('/')?target.slice(1):'xl/'+target;
    if(!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath))fail('Sheet path ไม่รองรับ');
    let strings=[];
    if(directory.entries.has('xl/sharedStrings.xml'))strings=elements(xml(await unzipText(bytes,directory,'xl/sharedStrings.xml')),'si').map(textRuns);
    const sheetText=await unzipText(bytes,directory,sheetPath);
    // Formatting-only nodes in some approved files exceed 60 MB. Never build a DOM for them.
    if(/<!DOCTYPE|<!ENTITY/i.test(sheetText))fail('ไม่รองรับ XML ที่ประกาศ entity');
    const root=sheetText.match(/<((?:[A-Za-z_][\w.-]*:)?worksheet)(?=[\s>])[^>]*>/);
    if(!root)fail('ไม่พบ worksheet root');
    const data=sheetText.match(/<((?:[A-Za-z_][\w.-]*:)?sheetData)(?=[\s>\/])[^>]*>[\s\S]*?<\/\1\s*>/)
      ||sheetText.match(/<((?:[A-Za-z_][\w.-]*:)?sheetData)(?=[\s\/])[^>]*\/\s*>/);
    if(!data)fail('ไม่พบ sheetData ใน worksheet');
    if(data[0].length>4*1024*1024)fail('ข้อมูล cell ใน worksheet เกินขีดจำกัด 4 MB');
    const sheet=xml(root[0]+data[0]+'</'+root[1]+'>');
    const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    if(sheet.documentElement.localName!=='worksheet'||sheet.documentElement.namespaceURI!==ns||sheet.getElementsByTagNameNS(ns,'sheetData').length!==1)fail('XML namespace ของ worksheet ไม่รองรับ');
    const cells=new Map();
    for(const cell of elements(sheet,'c')){
      const address=cell.getAttribute('r');if(!/^[A-Z]{1,3}[1-9][0-9]{0,4}$/.test(address)||cells.has(address))fail('ตำแหน่ง cell ไม่รองรับ');
      const kind=cell.getAttribute('t'),formula=elements(cell,'f').length>0;let value='';
      if(kind==='inlineStr')value=textRuns(cell);
      else { const raw=elements(cell,'v')[0]?.textContent??'';
        if(kind==='s'){const index=Number(raw);if(raw===''||!Number.isInteger(index)||index<0||index>=strings.length)fail('Shared string เสียหาย');value=strings[index];}
        else if(kind==='e')fail('Excel มี error cell');else value=raw;
      }
      cells.set(address,{value:String(value).trim(),formula,formulaText:elements(cell,'f')[0]?.textContent??''});
    }
    function get(address){const c=cells.get(address);if(c?.formula&&!(allowShiftHeaderFormulas&&/^(?:[D-Z]|A[A-I])[2-6]$/.test(address)&&c.value!==''))fail('ไม่รองรับสูตรในข้อมูลพนักงาน/กะ หรือหัวสูตรที่ไม่มีค่า cached');return c?.value??'';}
    return {get,cells,date1904:['1','true'].includes(elements(workbook,'workbookPr')[0]?.getAttribute('date1904'))};
  }
  async function read(file,scope='TEST'){
    const {get,cells}=await readWorksheet(file,null,true);
    const sectionCode=canonicalDepartment(get('B2'));if(!(scope==='TEST'?/^TEST_[A-Z0-9_]{1,24}$/.test(sectionCode):(scope==='REAL'?/^[A-Z][A-Z0-9_]{0,23}$/.test(sectionCode)&&sectionCode!=='TEST'&&sectionCode!=='REAL'&&!sectionCode.startsWith('TEST_'):sectionCode===scope)))fail('Section ในไฟล์ไม่ตรงขอบเขตบัญชีที่ Login');
    const year=Number(get('B3')),month=Number(get('B4'));
    if(!Number.isInteger(year)||year<2020||year>2100||!Number.isInteger(month)||month<1||month>12)fail('ปีหรือเดือนไม่ถูกต้อง');
    if(!['Emp No.','GID No.'].includes(get('A6'))||get('B6')!=='Firstname'||!['Lastname','Surname'].includes(get('C6')))fail('Header ไม่ตรง template');
    const count=new Date(Date.UTC(year,month,0)).getUTCDate();
    for(let day=1;day<=count;day++){const v=get(column(day+3)+'6'),date=new Date(Date.UTC(1899,11,30)+Number(v)*86400000),expected=year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');if(v!==String(day)&&(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==expected))fail('Header วันที่ไม่ตรงเดือน');}
    
    const employees=[],employeeRows=[];let legendRow=0;
    for(let row=7;row<=200;row++){
      const gid=get('A'+row);if(gid==='Shift - Description'){legendRow=row;break;}
      // Skip approved aggregate COUNTIF rows, not employee cells.
      if(!/^[A-Z0-9]{8,}$/.test(gid) && /^COUNTIF\([A-Z]+[0-9]+:[A-Z]+[0-9]+,/i.test(cells.get('D'+row)?.formulaText||''))continue;
      const days=Array.from({length:count},(_,i)=>get(column(i+4)+row));
      if(!gid && !get('B'+row) && !get('C'+row) && days.every(v=>v===''))continue;
      if(!(scope==='TEST'?/^TESTEMP[0-9]{3}$/.test(gid):(/^[A-Z0-9]{8}$/.test(gid)||(sectionCode==='OHL'&&["Z00PRTR08", "Z00PRTR09", "Z00PRTR10", "Z00PRTR11", "Z00PRTR12", "Z00PRTR13", "Z00PRTR14", "Z00PRTR15", "Z00PRTR16", "Z00PRTRORLTK02", "Z00PRTRORLTK01"].includes(gid)))))fail('รูปแบบ GID ไม่ตรงขอบเขตบัญชี');
      if(count<31 && get(column(count+4)+row)!=='')fail('ข้อมูลกะเกินจำนวนวันในเดือน');
      const name=[get('B'+row),get('C'+row)].filter(Boolean).join(' ').trim();if(!name)fail('ชื่อพนักงานว่าง');employees.push({gid,name,days});employeeRows.push(row);
    }
    if(!legendRow||employees.length<1||employees.length>100)fail('รองรับ 1–100 คน และต้องมีตารางคำอธิบายกะ');
    const definitions=[],legendCodes=new Map();
    for(let row=legendRow+1;row<=legendRow+32;row++){
      const label=get('A'+row),times=get('B'+row).replace(/(\d{1,2})\.(\d{2})/g,'$1:$2').replace(/\b(\d):/g,'0$1:');if(!label&&!times)break;
      const code=/^([A-Z][A-Z0-9]{0,7})\s*-\s*.+$/.exec(label);
      const time=/^([0-2][0-9]:[0-5][0-9])\s*-\s*([0-2][0-9]:[0-5][0-9])$/.exec(times);
      if(!code||!time)fail('ตารางคำอธิบายกะไม่ถูกต้อง');
      const definition={code:code[1],start:time[1],end:time[2]},previous=legendCodes.get(definition.code);
      if(previous){if(previous.start!==definition.start||previous.end!==definition.end)fail('รหัสกะซ้ำแต่เวลาไม่ตรงกัน '+definition.code);continue;}
      legendCodes.set(definition.code,definition);definitions.push(definition);
    }
    const legendErrors=[];
    for(let i=0;i<employees.length;i++)for(let day=0;day<count;day++){
      const code=employees[i].days[day];if(code!==''&&!legendCodes.has(code)){
        const row=employeeRows[i],col=column(day+4);legendErrors.push({row,column:col,cell:col+row,code});
      }
    }
    return {sectionCode,year,month,employees,definitions,legendErrors};
  }
  window.AttendanceXlsx={read,readWorksheet};
})();

;

(() => {
  function csv(text) {
    const rows=[];let row=[],value='',quoted=false,afterQuote=false;
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;afterQuote=true;}}else value+=c;continue;}
      if(afterQuote && c!==',' && c!=='\r' && c!=='\n' && c!==' ' && c!=='\t')throw Error('รูปแบบ CSV หลังเครื่องหมาย quote ไม่ถูกต้อง');
      if(c==='"'){if(value.trim()!=='')throw Error('รูปแบบ CSV quote ไม่ถูกต้อง');value='';quoted=true;afterQuote=false;}
      else if(c===','){row.push(value.trim());value='';afterQuote=false;}
      else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value.trim());if(row.some(v=>v!==''))rows.push(row);row=[];value='';afterQuote=false;}
      else if(!afterQuote)value+=c;
    }
    if(quoted)throw Error('CSV มี quote ที่ไม่ปิด');row.push(value.trim());if(row.some(v=>v!==''))rows.push(row);return rows;
  }
  function thaiTime(text) {
    const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i.exec(text);
    if(!m)throw Error('วันเวลาไม่ตรง M/D/YYYY h:mm:ss AM/PM');
    const month=Number(m[1]),day=Number(m[2]),year=Number(m[3]),hour12=Number(m[4]),minute=Number(m[5]),second=Number(m[6]);
    if(year<2020||year>2100||month<1||month>12||day<1||hour12<1||hour12>12||minute>59||second>59)throw Error('วันเวลาไม่ถูกต้อง');
    const hour=hour12%12+(m[7].toUpperCase()==='PM'?12:0);
    const local=new Date(Date.UTC(year,month-1,day,hour,minute,second));
    if(local.getUTCFullYear()!==year||local.getUTCMonth()!==month-1||local.getUTCDate()!==day)throw Error('วันที่ไม่มีในปฏิทิน');
    return new Date(local.getTime()-7*60*60*1000).toISOString();
  }
  function arlTime(text) {
    const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if(!m)throw Error('ARL All Today ต้องใช้ DD/MM/YYYY HH:mm:ss แบบ 24 ชั่วโมง');
    const [day,month,year,hour,minute,second]=m.slice(1).map(Number);
    if(year<2020||year>2100||month<1||month>12||day<1||hour>23||minute>59||second>59)throw Error('วันเวลา ARL ไม่ถูกต้อง');
    const local=new Date(Date.UTC(year,month-1,day,hour,minute,second));
    if(local.getUTCFullYear()!==year||local.getUTCMonth()!==month-1||local.getUTCDate()!==day)throw Error('วันที่ ARL ไม่มีในปฏิทิน');
    return new Date(local.getTime()-7*60*60*1000).toISOString();
  }
  function readArlRows(rows,context) {
    const maxPunches=context.maxPunches===50000?50000:10000;
    const allowed=new Set(context.gids||[]),punches=[],unmatched=[];
    const stats={dataRows:0,skippedOtherGID:0,skippedOutsidePeriod:0,footerRows:0};
    for(const [index,row] of rows.entries()){
      const sourceRow=index+1;
      if(row.length!==9||row[0]!=='S')throw Error('ARL All Today แถว '+sourceRow+': ต้องมี 9 คอลัมน์และรหัสรายการ S');
      stats.dataRows++;
      let time;try{time=arlTime(row[5]);}catch(e){throw Error('ARL All Today แถว '+sourceRow+': '+e.message);}
      const gid=row[2].trim().toUpperCase();
      if(gid&&(!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(gid)||gid.startsWith('TESTEMP')||gid.startsWith('TEST_')))throw Error('ARL All Today แถว '+sourceRow+': GID ไม่ถูกต้อง');
      if(context.keepAllGIDs!==true&&!allowed.has(gid)){stats.skippedOtherGID++;continue;}
      if(time<context.fromUTC||time>=context.toUTC){stats.skippedOutsidePeriod++;continue;}
      // Only GID and timestamp are mapped from the supplied ARL report.
      // Other column meanings and ENTRY/EXIT direction are NOT inferred.
      // Matching assigns in/out by shift windows as before.
      const device='';
      if(!gid&&context.keepAllGIDs===true)unmatched.push({time,device,sourceRow,event:'PUNCH',rawCells:[...row]});
      else punches.push({gid,time,device});
      if(punches.length+unmatched.length>maxPunches)throw Error('รองรับไม่เกิน '+maxPunches.toLocaleString('en-US')+' Punch ต่อไฟล์หลังกรอง');
    }
    if(!punches.length&&!unmatched.length)throw Error('ไม่พบ Punch ARL ที่นำเข้าได้ในช่วงเวลาที่เลือก');
    return {year:context.year,month:context.month,punches,unmatched,sourceCounts:stats};
  }
  async function read(file,context) {
    if(!file||!file.name.toLowerCase().endsWith('.txt')||file.size>10*1024*1024)throw Error('ใช้ไฟล์ .txt ไม่เกิน 10 MB');
    const bytes=new Uint8Array(await file.arrayBuffer());let encoding='utf-8';
    if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';
    else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
    else {const sample=bytes.subarray(0,Math.min(bytes.length,4096));let odd=0,even=0;for(let i=0;i<sample.length;i++)if(sample[i]===0){if(i%2)odd++;else even++;}
      if(odd>sample.length/5)encoding='utf-16le';else if(even>sample.length/5)encoding='utf-16be';}
    const text=new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');const rows=csv(text);
    const expected=['Division','Cardholder Name','Employee ID','Entry Clock','Entry Card','Entry Date/Time','Exit Clock','Exit Card','Exit Date/Time','Time Worked'];
    const mrtaHeader=rows.length&&rows[0].length===10&&rows[0].every((v,i)=>v===expected[i]);
    if(!mrtaHeader){
      if(rows.length&&rows[0].length===9&&rows[0][0]==='S'&&/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(rows[0][5]))return readArlRows(rows,context);
      throw Error('รูปแบบ All Today ไม่ตรง: ใช้ ARL 9 คอลัมน์ไม่มี Header หรือ MRTA 10 คอลัมน์พร้อม Header');
    }
    const maxPunches=context.maxPunches===50000?50000:10000;const allowed=new Set(context.gids);const stats={dataRows:0,skippedOtherGID:0,skippedOutsidePeriod:0,footerRows:0};const punches=[],unmatched=[];
    for(const [index,row] of rows.slice(1).entries()){
      const sourceRow=index+2;
      if(row.length===1&&row[0]==='End of Time and Attendance Detail Report'){stats.footerRows++;continue;}
      if(row.length!==10)throw Error('พบแถวที่มีจำนวนคอลัมน์ไม่ครบ กรุณาตรวจไฟล์');stats.dataRows++;
      const gid=row[2].trim().toUpperCase();if(context.keepAllGIDs===true){if(gid&&(!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(gid)||gid.startsWith('TESTEMP')||gid.startsWith('TEST_')))throw Error('แถว '+sourceRow+': GID ไม่ถูกต้องสำหรับ All Today: '+gid);}else if(!allowed.has(gid)){stats.skippedOtherGID++;continue;}
      let found=false;
      for(const [dateIndex,deviceIndex] of [[5,3],[8,6]]){
        if(!row[dateIndex])continue;found=true;let time;try{time=thaiTime(row[dateIndex]);}catch(e){throw Error('แถวข้อมูล '+sourceRow+': '+e.message);}
        if(time<context.fromUTC||time>=context.toUTC){stats.skippedOutsidePeriod++;continue;}
        const device=row[deviceIndex].trim();if(device.length>128)throw Error('ชื่อเครื่องสแกนยาวเกินกำหนด');
        if(!gid&&context.keepAllGIDs===true)unmatched.push({time,device,sourceRow,event:dateIndex===5?'ENTRY':'EXIT',rawCells:[...row]});else punches.push({gid,time,device});if(punches.length+unmatched.length>maxPunches)throw Error('รองรับไม่เกิน '+maxPunches.toLocaleString('en-US')+' Punch ต่อไฟล์หลังกรอง');
      }
      if(!found)throw Error('แถว '+sourceRow+': ไม่พบเวลา Punch');
    }
    if(!punches.length&&!unmatched.length)throw Error('ไม่พบ Punch ที่นำเข้าได้ในช่วงเวลาที่เลือก');
    return{year:context.year,month:context.month,punches,unmatched,sourceCounts:stats};
  }
  async function readAuto(file,context){const data=await read(file,{gids:context.gids,keepAllGIDs:context.keepAllGIDs===true,maxPunches:context.maxPunches,fromUTC:'2019-12-31T17:00:00.000Z',toUTC:'2099-12-31T17:00:00.000Z'});if(data.sourceCounts.skippedOutsidePeriod)throw Error('Punch date outside supported range; no upload');return{punches:data.punches,unmatched:data.unmatched,sourceCounts:data.sourceCounts};}
  window.AttendanceClock={read,readAuto,thaiTime};
})();

;

(() => {
 function dateValue(value){
  if(/^\d+(\.\d+)?$/.test(value)){const number=Number(value);if(!Number.isInteger(number))throw Error('Time Off Date ต้องเป็นวันเต็ม');return new Date(Date.UTC(1899,11,30)+number*86400000).toISOString().slice(0,10);}
  if(/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value))return value.slice(0,10);
  throw Error('รูปแบบ Time Off Date ไม่รองรับ');
 }
 async function read(file,context){
  const {get,cells}=await window.AttendanceXlsx.readWorksheet(file,null);
  const headers=['Time Off Date','Day of the Week','Worker','Employee ID','Time Off/Absence Table','Time Off Type','Units','Unit of Time'];
  for(let i=0;i<8;i++)if(get(String.fromCharCode(65+i)+'1')!==headers[i])throw Error('Header ในชีตแรกไม่ตรง Workday template');
  let last=1;for(const key of cells.keys()){const m=/^[A-H](\d+)$/.exec(key);if(m)last=Math.max(last,Number(m[1]));}
  if(last>5001)throw Error('รองรับไม่เกิน5,000แถวในไฟล์ก่อนกรอง');const allowed=new Set(context.gids),rows=[];let skippedOther=0;
  for(let row=2;row<=last;row++){
   const gid=get('D'+row).toUpperCase();if(!gid&&!get('A'+row)&&!get('F'+row)&&!get('G'+row))continue;
   if(!allowed.has(gid)){skippedOther++;continue;}
   const units=Number(get('G'+row));if(![0.5,1].includes(units)||get('H'+row)!=='Days')throw Error('รองรับUnits0.5หรือ1 และUnit of Time=Daysเท่านั้น');
   const date=dateValue(get('A'+row)),type=get('F'+row);if(!type)throw Error('Time Off Type ว่าง');rows.push({gid,date,type,units});if(rows.length>10000)throw Error('รองรับไม่เกิน10,000รายการต่อไฟล์');
  }
  return{rows,skippedOther};
 }
 window.AttendanceLeave={read};
})();

;

(() => {
 const enc=new TextEncoder();
 const escape=v=>String(v??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
 function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
 function zip(files){
  const local=[],central=[];let offset=0;
  for(const[name,text]of files){const path=enc.encode(name),data=enc.encode(text),checksum=crc(data),header=new Uint8Array(30+path.length),h=new DataView(header.buffer);
   h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(12,33,true);h.setUint32(14,checksum,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,path.length,true);header.set(path,30);
   const directory=new Uint8Array(46+path.length),d=new DataView(directory.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x0800,true);d.setUint16(14,33,true);d.setUint32(16,checksum,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,path.length,true);d.setUint32(42,offset,true);directory.set(path,46);local.push(header,data);central.push(directory);offset+=header.length+data.length;
  }
  const size=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 }
 function col(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
 function time(v){return v?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v)):'';}
 function date(v){return Number(v.slice(8))+'-'+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(v.slice(5,7))-1]+'-'+v.slice(2,4);}
 function duration(a,b){if(!a||!b)return '';const minutes=Math.floor((Date.parse(b)-Date.parse(a))/60000);return minutes>=0?String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0'):'';}
 function textCell(address,value,style){return '<c r="'+address+'" t="inlineStr" s="'+style+'"><is><t xml:space="preserve">'+escape(value)+'</t></is></c>';}
 function build(rows,warnings=[],summary={}){
  if(!Array.isArray(rows)||!rows.length||rows.length>12000)throw Error('ไม่มีข้อมูลหรือข้อมูลมากเกินขอบเขต Export');
  const headers=['GID','Name','Date','Day','Shift','Working In','Working Out','Real In','Real Out','Diff HH:MM','Time Clock Data','OT1.5','OT2.0','OT3.0','Total OT','Meal','Stand by','Emergency','Total Allowance','Late min','XY','Leave Units','Leave Type','Remark','Department','Data Status','Leave Source','Leave Half'];
  let body='<row r="1" ht="30" customHeight="1">'+headers.map((h,i)=>textCell(col(i+1)+'1',h,1)).join('')+'</row>';
  const styles=[2,2,2,2,3,3,3,4,4,4,5,8,8,8,10,9,9,9,11,6,6,6,6,6,2,2,2,2];
  rows.forEach((r,index)=>{
   const number=index+2,day=['Su','Mo','Tu','We','Th','Fr','Sa'][new Date(r.work_date+'T12:00:00Z').getUTCDay()];
   const raw=(r.time_clock_data||[]).map(v=>{const local=new Date(Date.parse(v)+7*3600000).toISOString().slice(0,10);return(local===r.work_date?'':Number(local.slice(8))+'/'+Number(local.slice(5,7))+' ')+time(v);}).join(' ');
   const values=[r.gid,r.full_name,date(r.work_date),day,r.shift||'',time(r.working_in),time(r.working_out),time(r.real_in),time(r.real_out),duration(r.real_in,r.real_out),raw,r.ot15??'',r.ot20??'',r.ot30??'',r.total_ot??'',r.meal??'',r.stand_by??'',r.emergency??'',r.total_allowance??'',r.late_minutes===null?'':r.late_minutes,r.xy||'',r.leave_units===null?'':r.leave_units,r.leave_label||'',[r.remark||'',r.ot_refer?'OT Refer: '+r.ot_refer:'',r.allowance_refer?'Allowance Refer: '+r.allowance_refer:'',r.time_manual?'Manual กะ/เวลา: '+Object.keys(r.time_overrides||{}).join(', ')+' | เหตุผล: '+r.time_change_reason:''].filter(Boolean).join(' | '),r.section||'',r.data_status||'',r.leave_status||'',r.leave_half||''];
   body+='<row r="'+number+'" ht="24" customHeight="1">'+values.map((value,i)=>{const style=(i===4&&r.manual_shift)||(i===5&&r.manual_working_in)||(i===6&&r.manual_working_out)||(i===7&&r.manual_real_in)||(i===8&&r.manual_real_out)||(i===20&&r.manual_xy)||(i===23&&r.manual_remark)||(i===21&&r.manual_leave_units)||(i===22&&r.manual_leave_type)?7:styles[i];const address=col(i+1)+number;
    if(i===14||i===18){const range=(i===14?'L':'P')+number+':'+(i===14?'N':'R')+number;const formula='IF(COUNT('+range+')=0,&quot;&quot;,SUM('+range+'))';return '<c r="'+address+'" s="'+style+'"'+(value===''?' t="str"':'')+'><f>'+formula+'</f><v>'+value+'</v></c>';}
    if([11,12,13,15,16,17,19,21].includes(i)&&typeof value==='number'){if(!Number.isFinite(value)||value<0)throw Error('ค่าตัวเลขใน Export ไม่ถูกต้อง');return '<c r="'+address+'" s="'+style+'"><v>'+value+'</v></c>';}
    return textCell(address,value,style);}).join('')+'</row>';
  });
  const widths=[13,28,13,7,7,11,11,11,11,13,27,10,10,10,12,14,14,14,18,9,7,12,25,65,14,28,18,20];
  const worksheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>'+widths.map((w,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+w+'" customWidth="1"/>').join('')+'</cols><sheetData>'+body+'</sheetData><autoFilter ref="A1:AB'+(rows.length+1)+'"/></worksheet>';
  const fills=['003B49','DBEDF0','FFF2CC','DAEED8','D7EAF7','F4E7C7','F7C7AC'];
  const styleXML='<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font></fonts><fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'+fills.map(c=>'<fill><patternFill patternType="solid"><fgColor rgb="FF'+c+'"/><bgColor indexed="64"/></patternFill></fill>').join('')+'</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+fills.map((c,i)=>'<xf numFmtId="0" fontId="'+(i===0?1:0)+'" fillId="'+(i+2)+'" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>').join('')+[ [2,8],[4,8],[2,3],[4,3] ].map(([fmt,fill])=>'<xf numFmtId="'+fmt+'" fontId="0" fillId="'+fill+'" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>').join('')+'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  function extraSheet(table){return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="8" width="30" customWidth="1"/></cols><sheetData>'+table.map((vals,i)=>'<row r="'+(i+1)+'">'+vals.map((v,j)=>textCell(col(j+1)+(i+1),v,i===0?1:0)).join('')+'</row>').join('')+'</sheetData></worksheet>';}
  const warningXML=extraSheet([['GID','Date','Code','Message'],...warnings.map(w=>[w.gid||'',w.date||'',w.code,w.message])]);
  const summaryXML=extraSheet([['Item','Value'],...Object.entries(summary).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]),['Important','Export includes the full loaded month, independent of view filters. Legacy references are retained in Remark.']]);
  return zip([
   ['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
   ['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
   ['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attendance" sheetId="1" r:id="rId1"/><sheet name="Warnings" sheetId="2" r:id="rId3"/><sheet name="Summary" sheetId="3" r:id="rId4"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>'],
   ['xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>'],
   ['xl/styles.xml',styleXML],['xl/worksheets/sheet1.xml',worksheet],['xl/worksheets/sheet2.xml',warningXML],['xl/worksheets/sheet3.xml',summaryXML],
  ]);
 }
 window.AttendanceExcel={build};
})();

;
window.LOCAL_WORKER_URL=URL.createObjectURL(new Blob(["(() => {\n  // src/attendance-matcher.js\n  var HOUR = 36e5;\n  function localDate(time) {\n    return new Date(Date.parse(time) + 7 * HOUR).toISOString().slice(0, 10);\n  }\n  function midnight(date) {\n    return Date.parse(date + \"T00:00:00+07:00\");\n  }\n  function shiftTimes(date, shift) {\n    if (shift.is_work_day === 0) return { scheduledIn: null, scheduledOut: null };\n    const start = Date.parse(date + \"T\" + shift.start_time + \":00+07:00\");\n    const end = Date.parse(date + \"T\" + shift.end_time + \":00+07:00\") + shift.end_day_offset * 24 * HOUR;\n    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error(\"Invalid shift times\");\n    return { scheduledIn: new Date(start).toISOString(), scheduledOut: new Date(end).toISOString() };\n  }\n  function matchAttendance(plans, punches, existing, shifts, leaves = []) {\n    const oldMap = new Map(existing.map((row) => [row.gid + \"|\" + row.work_date, row]));\n    const shiftMap = new Map(shifts.map((row) => [row.id, row]));\n    const grouped = /* @__PURE__ */ new Map();\n    for (const punch of punches) {\n      if (!grouped.has(punch.gid)) grouped.set(punch.gid, []);\n      grouped.get(punch.gid).push({ ...punch, millis: Date.parse(punch.punched_at) });\n    }\n    for (const list of grouped.values()) list.sort((a, b) => a.millis - b.millis || a.id - b.id);\n    const warnings = [];\n    const warn = (row, code, message) => warnings.push({ gid: row.gid, date: row.work_date, code, message });\n    const leaveMap = /* @__PURE__ */ new Map();\n    for (const leave of leaves) {\n      const key = leave.gid + \"|\" + leave.leave_date;\n      if (!leaveMap.has(key)) leaveMap.set(key, []);\n      leaveMap.get(key).push(leave);\n    }\n    const results = plans.map((plan) => {\n      const old = oldMap.get(plan.gid + \"|\" + plan.work_date);\n      const shiftId = old?.manual_shift === 1 ? old.shift_id : plan.shift_id;\n      const shift = shiftMap.get(shiftId);\n      if (!shift) throw Error(\"Shift master missing\");\n      let times = shiftTimes(plan.work_date, shift);\n      if (old?.manual_shift === 1 && shift.is_work_day === 1) {\n        if (old.scheduled_in && old.scheduled_out) {\n          if (!Number.isFinite(Date.parse(old.scheduled_in)) || !Number.isFinite(Date.parse(old.scheduled_out)) || Date.parse(old.scheduled_out) <= Date.parse(old.scheduled_in)) throw Error(\"Invalid manual scheduled times\");\n          times = { scheduledIn: old.scheduled_in, scheduledOut: old.scheduled_out };\n        } else warn(plan, \"MANUAL_SHIFT_TIMES_MISSING\", \"Manual shift has missing scheduled times; matching uses shift master while preserving saved scheduled fields\");\n      }\n      const row = { ...plan, shift_id: shiftId, scheduled_in: times.scheduledIn, scheduled_out: times.scheduledOut, real_in: null, real_out: null, xy: null, remark: null, working: shift.is_work_day === 1, planned_leave: shift.is_leave_day === 1, old, inCandidate: null, outCandidate: null, leave_units: null, leave_half: null, leave_label: null };\n      row.fullScheduledIn = row.scheduled_in;\n      row.fullScheduledOut = row.scheduled_out;\n      const dayLeaves = leaveMap.get(row.gid + \"|\" + row.work_date) || [];\n      if (dayLeaves.length) {\n        row.leave_units = dayLeaves.reduce((n, l) => n + l.units, 0);\n        row.leave_label = [...new Set(dayLeaves.map((l) => l.leave_name || l.leave_type_code))].join(\" / \");\n        if (![0.5, 1].includes(row.leave_units)) throw Error(\"Leave total exceeds supported day units\");\n        if (row.leave_units === 1) row.leave_half = \"FULL_DAY\";\n        else if (!row.working) {\n          row.leave_half = \"UNRESOLVED\";\n          warn(row, row.planned_leave ? \"PLANNED_LEAVE_CONFLICT\" : \"LEAVE_ON_REST_DAY\", row.planned_leave ? \"\\u0E41\\u0E1C\\u0E19\\u0E40\\u0E1B\\u0E47\\u0E19\\u0E23\\u0E2B\\u0E31\\u0E2A\\u0E25\\u0E32\\u0E40\\u0E15\\u0E47\\u0E21\\u0E27\\u0E31\\u0E19\\u0E41\\u0E15\\u0E48 Workday \\u0E23\\u0E30\\u0E1A\\u0E38\\u0E04\\u0E23\\u0E36\\u0E48\\u0E07\\u0E27\\u0E31\\u0E19 \\u0E01\\u0E23\\u0E38\\u0E13\\u0E32\\u0E15\\u0E23\\u0E27\\u0E08\\u0E2A\\u0E2D\\u0E1A\" : \"\\u0E1E\\u0E1A\\u0E23\\u0E32\\u0E22\\u0E01\\u0E32\\u0E23\\u0E25\\u0E32\\u0E04\\u0E23\\u0E36\\u0E48\\u0E07\\u0E27\\u0E31\\u0E19\\u0E15\\u0E23\\u0E07\\u0E01\\u0E31\\u0E1A\\u0E27\\u0E31\\u0E19\\u0E2B\\u0E22\\u0E38\\u0E14 \\u0E01\\u0E23\\u0E38\\u0E13\\u0E32\\u0E15\\u0E23\\u0E27\\u0E08\\u0E2A\\u0E2D\\u0E1A\");\n        } else {\n          const start = Date.parse(row.scheduled_in), end = Date.parse(row.scheduled_out), list = grouped.get(row.gid) || [];\n          const nearStart = list.some((p) => p.millis >= start - HOUR && p.millis <= start + HOUR);\n          const nearEnd = list.some((p) => p.millis >= end - HOUR && p.millis <= end + HOUR);\n          const midpoint = new Date(start + (end - start) / 2).toISOString();\n          if (nearStart && !nearEnd) {\n            row.leave_half = \"SECOND_HALF\";\n            row.scheduled_out = midpoint;\n          } else if (nearEnd && !nearStart) {\n            row.leave_half = \"FIRST_HALF\";\n            row.scheduled_in = midpoint;\n          } else {\n            row.leave_half = \"UNRESOLVED\";\n            warn(row, \"HALF_LEAVE_UNRESOLVED\", nearStart && nearEnd ? \"\\u0E1E\\u0E1A Punch \\u0E43\\u0E01\\u0E25\\u0E49\\u0E17\\u0E31\\u0E49\\u0E07\\u0E40\\u0E27\\u0E25\\u0E32\\u0E40\\u0E23\\u0E34\\u0E48\\u0E21\\u0E41\\u0E25\\u0E30\\u0E40\\u0E25\\u0E34\\u0E01\\u0E01\\u0E30 \\u0E41\\u0E22\\u0E01\\u0E04\\u0E23\\u0E36\\u0E48\\u0E07\\u0E25\\u0E32\\u0E44\\u0E21\\u0E48\\u0E44\\u0E14\\u0E49\" : \"\\u0E44\\u0E21\\u0E48\\u0E21\\u0E35 Punch \\u0E43\\u0E01\\u0E25\\u0E49\\u0E40\\u0E27\\u0E25\\u0E32\\u0E40\\u0E23\\u0E34\\u0E48\\u0E21\\u0E2B\\u0E23\\u0E37\\u0E2D\\u0E40\\u0E25\\u0E34\\u0E01\\u0E01\\u0E30 \\u0E41\\u0E22\\u0E01\\u0E04\\u0E23\\u0E36\\u0E48\\u0E07\\u0E25\\u0E32\\u0E44\\u0E21\\u0E48\\u0E44\\u0E14\\u0E49\");\n          }\n        }\n      }\n      if (row.working && row.leave_half !== \"FULL_DAY\") {\n        const list = grouped.get(row.gid) || [], start = Date.parse(row.scheduled_in), end = Date.parse(row.scheduled_out);\n        row.inCandidate = list.find((p) => p.millis >= start - 2 * HOUR && p.millis <= start + 4 * HOUR) || null;\n        row.outCandidate = list.find((p) => p.millis >= end - HOUR && p.millis <= end + 6 * HOUR) || null;\n      }\n      return row;\n    });\n    const selections = /* @__PURE__ */ new Map();\n    for (const row of results) for (const side of [\"inCandidate\", \"outCandidate\"]) if (row[side]) {\n      const key = row.gid + \"|\" + row[side].punched_at;\n      if (!selections.has(key)) selections.set(key, []);\n      selections.get(key).push({ row, side });\n    }\n    for (const selected of selections.values()) if (selected.length > 1) for (const { row, side } of selected) {\n      row[side] = null;\n      row.ambiguous = true;\n      if (row.leave_units === 0.5) {\n        row.leave_half = \"UNRESOLVED\";\n        row.scheduled_in = row.fullScheduledIn;\n        row.scheduled_out = row.fullScheduledOut;\n        row.inCandidate = null;\n        row.outCandidate = null;\n        warn(row, \"HALF_LEAVE_PUNCH_CONFLICT\", \"Punch \\u0E2A\\u0E33\\u0E2B\\u0E23\\u0E31\\u0E1A\\u0E25\\u0E32\\u0E04\\u0E23\\u0E36\\u0E48\\u0E07\\u0E27\\u0E31\\u0E19\\u0E02\\u0E31\\u0E14\\u0E41\\u0E22\\u0E49\\u0E07\\u0E01\\u0E31\\u0E1A\\u0E2D\\u0E35\\u0E01\\u0E0A\\u0E48\\u0E2D\\u0E07\\u0E2B\\u0E23\\u0E37\\u0E2D\\u0E01\\u0E30 \\u0E15\\u0E49\\u0E2D\\u0E07\\u0E15\\u0E23\\u0E27\\u0E08\\u0E42\\u0E14\\u0E22 Admin\");\n      }\n      warn(row, \"AMBIGUOUS_PUNCH\", \"The same punch matches multiple fields or shifts; no automatic assignment was made\");\n    }\n    const assigned = /* @__PURE__ */ new Map();\n    for (const row of results) for (const side of [\"inCandidate\", \"outCandidate\"]) if (row[side]) assigned.set(row.gid + \"|\" + row[side].punched_at, row);\n    for (const row of results) {\n      const list = grouped.get(row.gid) || [];\n      if (row.leave_half === \"FULL_DAY\") {\n        row.xy = null;\n        const raw = list.filter((p) => localDate(p.punched_at) === row.work_date && !assigned.has(row.gid + \"|\" + p.punched_at));\n        if (raw.length) warn(row, \"FULL_LEAVE_PUNCH\", \"\\u0E25\\u0E32\\u0E40\\u0E15\\u0E47\\u0E21\\u0E27\\u0E31\\u0E19\\u0E41\\u0E15\\u0E48\\u0E1E\\u0E1A Punch \\u0E40\\u0E01\\u0E47\\u0E1A\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E14\\u0E34\\u0E1A\\u0E44\\u0E27\\u0E49 \\u0E44\\u0E21\\u0E48\\u0E21\\u0E35\\u0E01\\u0E32\\u0E23\\u0E40\\u0E15\\u0E34\\u0E21\\u0E40\\u0E27\\u0E25\\u0E32\\u0E2D\\u0E31\\u0E15\\u0E42\\u0E19\\u0E21\\u0E31\\u0E15\\u0E34\");\n      } else if (row.working) {\n        row.real_in = row.inCandidate?.punched_at || null;\n        row.real_out = row.outCandidate?.punched_at || null;\n        const rangeStart = midnight(row.work_date);\n        const rangeEnd = Math.max(rangeStart + 24 * HOUR, Date.parse(row.scheduled_out) + 6 * HOUR + 1);\n        const raw = list.filter((p) => p.millis >= rangeStart && p.millis < rangeEnd && (!assigned.has(row.gid + \"|\" + p.punched_at) || assigned.get(row.gid + \"|\" + p.punched_at) === row));\n        if (!row.real_in && !row.real_out) {\n          if (raw.length || row.ambiguous) warn(row, \"PUNCH_OUTSIDE_WINDOWS\", \"\\u0E21\\u0E35 Punch \\u0E41\\u0E15\\u0E48\\u0E44\\u0E21\\u0E48\\u0E15\\u0E23\\u0E07\\u0E0A\\u0E48\\u0E27\\u0E07\\u0E01\\u0E30 \\u0E2B\\u0E23\\u0E37\\u0E2D\\u0E21\\u0E35\\u0E01\\u0E32\\u0E23\\u0E08\\u0E31\\u0E1A\\u0E04\\u0E39\\u0E48\\u0E02\\u0E31\\u0E14\\u0E41\\u0E22\\u0E49\\u0E07\");\n          else {\n            row.xy = \"Y\";\n            warn(row, \"NO_PUNCH\", \"\\u0E27\\u0E31\\u0E19\\u0E17\\u0E33\\u0E07\\u0E32\\u0E19\\u0E44\\u0E21\\u0E48\\u0E21\\u0E35 Punch \\u0E43\\u0E19\\u0E0A\\u0E48\\u0E27\\u0E07\\u0E2D\\u0E49\\u0E32\\u0E07\\u0E2D\\u0E34\\u0E07\");\n          }\n        } else if (!row.real_in || !row.real_out) {\n          row.xy = \"X\";\n          warn(row, \"SINGLE_SIDE_PUNCH\", \"\\u0E1E\\u0E1A Punch \\u0E17\\u0E35\\u0E48\\u0E08\\u0E31\\u0E1A\\u0E04\\u0E39\\u0E48\\u0E44\\u0E14\\u0E49\\u0E40\\u0E1E\\u0E35\\u0E22\\u0E07\\u0E02\\u0E32\\u0E40\\u0E14\\u0E35\\u0E22\\u0E27 \\u0E2D\\u0E35\\u0E01\\u0E0A\\u0E48\\u0E2D\\u0E07\\u0E40\\u0E27\\u0E49\\u0E19\\u0E27\\u0E48\\u0E32\\u0E07 \\u0E41\\u0E25\\u0E30 XY = X\");\n        }\n      } else {\n        const raw = list.filter((p) => localDate(p.punched_at) === row.work_date && !assigned.has(row.gid + \"|\" + p.punched_at));\n        if (raw.length) warn(row, row.planned_leave ? \"PLANNED_LEAVE_PUNCH\" : \"REST_DAY_PUNCH\", \"\\u0E1E\\u0E1A\\u0E01\\u0E32\\u0E23\\u0E2A\\u0E41\\u0E01\\u0E19\\u0E43\\u0E19\\u0E27\\u0E31\\u0E19\\u0E2B\\u0E22\\u0E38\\u0E14 \\u0E44\\u0E21\\u0E48\\u0E21\\u0E35\\u0E01\\u0E32\\u0E23\\u0E08\\u0E31\\u0E1A\\u0E04\\u0E39\\u0E48 Real In / Real Out \\u0E2D\\u0E31\\u0E15\\u0E42\\u0E19\\u0E21\\u0E31\\u0E15\\u0E34\");\n      }\n      row.expected_in_for_late = row.working && row.leave_half !== \"FULL_DAY\" && row.leave_half !== \"UNRESOLVED\" ? row.scheduled_in : null;\n      if (row.leave_half === \"UNRESOLVED\" && row.old) row.xy = row.old.xy;\n      if (row.old) {\n        for (const [flag, field] of [[\"manual_real_in\", \"real_in\"], [\"manual_real_out\", \"real_out\"], [\"manual_remark\", \"remark\"], [\"manual_xy\", \"xy\"]]) if (row.old[flag] === 1) row[field] = row.old[field];\n        if (row.old.manual_shift === 1) {\n          row.shift_id = row.old.shift_id;\n          row.scheduled_in = row.old.scheduled_in;\n          row.scheduled_out = row.old.scheduled_out;\n        }\n      }\n    }\n    const keys = new Set(plans.map((row) => row.gid + \"|\" + row.work_date));\n    for (const old of existing) if (!keys.has(old.gid + \"|\" + old.work_date)) warn(old, \"ATTENDANCE_NOT_IN_PLAN\", \"Attendance \\u0E40\\u0E14\\u0E34\\u0E21\\u0E44\\u0E21\\u0E48\\u0E2D\\u0E22\\u0E39\\u0E48\\u0E43\\u0E19 Shift Plan \\u0E43\\u0E2B\\u0E21\\u0E48 \\u0E40\\u0E01\\u0E47\\u0E1A Record \\u0E41\\u0E25\\u0E30 Remark \\u0E44\\u0E27\\u0E49\\u0E42\\u0E14\\u0E22\\u0E44\\u0E21\\u0E48\\u0E25\\u0E1A\");\n    return { rows: results, warnings };\n  }\n\n  // src/department-codes.js\n  var departmentAliases = Object.freeze({\n    \"PSD/PID\": \"PSD_PID\",\n    \"PSY/GRS\": \"PSY_GRS\",\n    \"TRW/TRD\": \"TRW_TRD\"\n  });\n  var departmentLabels = Object.freeze({\n    PSD_PID: \"PSD/PID\",\n    PSY_GRS: \"PSY/GRS\",\n    TRW_TRD: \"TRW/TRD\"\n  });\n  function canonicalDepartment(code) {\n    return Object.hasOwn(departmentAliases, code) ? departmentAliases[code] : code;\n  }\n  var departmentBrowserJS = `\n  const departmentAliases = Object.freeze(${JSON.stringify(departmentAliases)});\n  const departmentLabels = Object.freeze(${JSON.stringify(departmentLabels)});\n  const canonicalDepartment = code => Object.prototype.hasOwnProperty.call(departmentAliases, code) ? departmentAliases[code] : code;\n  const displayDepartment = code => Object.prototype.hasOwnProperty.call(departmentLabels, code) ? departmentLabels[code] : code;\n`;\n\n  // src/local-core.js\n  var ImportError = class extends Error {\n  };\n  function validatePlan(data, scope = \"TEST\") {\n    if (!data || typeof data !== \"object\" || Array.isArray(data)) throw new ImportError(\"Invalid plan\");\n    const { year, month, employees, definitions } = data;\n    const sectionCode = canonicalDepartment(data.sectionCode);\n    if (typeof sectionCode !== \"string\" || !(scope === \"TEST\" ? /^TEST_[A-Z0-9_]{1,24}$/.test(sectionCode) : scope === \"REAL\" ? /^[A-Z][A-Z0-9_]{0,23}$/.test(sectionCode) && sectionCode !== \"TEST\" && sectionCode !== \"REAL\" && !sectionCode.startsWith(\"TEST_\") : sectionCode === scope)) throw new ImportError(\"Section is outside this account scope\", 403);\n    if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new ImportError(\"Invalid month or year\");\n    const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();\n    if (!Array.isArray(employees) || employees.length < 1 || employees.length > 100) throw new ImportError(\"Test import supports 1\\u2013100 employees per file\");\n    if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 32) throw new ImportError(\"Missing or invalid shift legend\");\n    const gids = /* @__PURE__ */ new Set();\n    const codes = /* @__PURE__ */ new Map();\n    for (const definition of definitions) {\n      if (!definition || typeof definition.code !== \"string\" || !/^[A-Z][A-Z0-9]{0,7}$/.test(definition.code)) throw new ImportError(\"Invalid shift legend code\");\n      if (codes.has(definition.code)) throw new ImportError(\"Duplicate shift legend code\");\n      for (const key of [\"start\", \"end\"]) if (typeof definition[key] !== \"string\" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(definition[key])) throw new ImportError(\"Invalid shift legend time\");\n      if (definition.start === definition.end && definition.start !== \"00:00\") throw new ImportError(\"Equal shift times supported only for00:00 leave/nonwork\");\n      definition.isWork = definition.start !== definition.end;\n      definition.isLeave = [\"AL\", \"SL\", \"RL\", \"CL\", \"ML\", \"PL\"].includes(definition.code) && !definition.isWork;\n      codes.set(definition.code, definition);\n    }\n    let working = 0;\n    let rest = 0;\n    for (const employee of employees) {\n      if (!employee || typeof employee.gid !== \"string\" || !(scope === \"TEST\" ? /^TESTEMP[0-9]{3}$/.test(employee.gid) : /^[A-Z0-9]{8}$/.test(employee.gid) || sectionCode === \"OHL\" && [\"Z00PRTR08\", \"Z00PRTR09\", \"Z00PRTR10\", \"Z00PRTR11\", \"Z00PRTR12\", \"Z00PRTR13\", \"Z00PRTR14\", \"Z00PRTR15\", \"Z00PRTR16\", \"Z00PRTRORLTK02\", \"Z00PRTRORLTK01\"].includes(employee.gid))) throw new ImportError(\"Invalid GID for this account scope\");\n      if (scope !== \"TEST\" && (typeof employee.name !== \"string\" || !employee.name.trim() || employee.name.length > 200)) throw new ImportError(\"Employee monthly name is required\");\n      if (gids.has(employee.gid)) throw new ImportError(\"Duplicate employee GID\");\n      gids.add(employee.gid);\n      if (!Array.isArray(employee.days) || employee.days.length !== dayCount) throw new ImportError(\"Each employee must have every calendar day, including blank rest days\");\n      for (const shift of employee.days) {\n        if (typeof shift !== \"string\" || shift !== shift.trim()) throw new ImportError(\"Invalid daily shift code\");\n        if (shift === \"\") rest++;\n        else {\n          if (!codes.has(shift)) throw new ImportError(\"Daily shift is not in the legend\");\n          if (codes.get(shift).isWork) working++;\n          else rest++;\n        }\n      }\n    }\n    return { sectionCode, year, month, employees, definitions, dayCount, working, rest, gids: [...gids] };\n  }\n  function preparePlans(inputs) {\n    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 12) throw Error(\"\\u0E40\\u0E25\\u0E37\\u0E2D\\u0E01 Shift Plan 1\\u201312 \\u0E44\\u0E1F\\u0E25\\u0E4C\");\n    const plans = [], shifts = [{ id: 1, code: \"\", start_time: \"00:00\", end_time: \"00:00\", end_day_offset: 0, is_work_day: 0, is_leave_day: 0 }], seen = /* @__PURE__ */ new Set(), keys = /* @__PURE__ */ new Set(), names = /* @__PURE__ */ new Map(), sections = /* @__PURE__ */ new Map();\n    let period;\n    for (const input of inputs) {\n      const v = validatePlan(structuredClone(input), \"REAL\");\n      const key = v.sectionCode + \"|\" + v.year + \"|\" + v.month;\n      if (seen.has(key)) throw Error(\"\\u0E40\\u0E25\\u0E37\\u0E2D\\u0E01\\u0E41\\u0E1C\\u0E19\\u0E40\\u0E15\\u0E47\\u0E21\\u0E40\\u0E14\\u0E37\\u0E2D\\u0E19\\u0E40\\u0E1E\\u0E35\\u0E22\\u0E07\\u0E44\\u0E1F\\u0E25\\u0E4C\\u0E40\\u0E14\\u0E35\\u0E22\\u0E27\\u0E15\\u0E48\\u0E2D\\u0E41\\u0E1C\\u0E19\\u0E01: \" + v.sectionCode);\n      seen.add(key);\n      const ym = v.year + \"-\" + String(v.month).padStart(2, \"0\");\n      if (period && period !== ym) throw Error(\"Shift Plan \\u0E17\\u0E38\\u0E01\\u0E44\\u0E1F\\u0E25\\u0E4C\\u0E15\\u0E49\\u0E2D\\u0E07\\u0E40\\u0E1B\\u0E47\\u0E19\\u0E40\\u0E14\\u0E37\\u0E2D\\u0E19\\u0E40\\u0E14\\u0E35\\u0E22\\u0E27\\u0E01\\u0E31\\u0E19\");\n      period = ym;\n      const section = sections.size + 1;\n      sections.set(section, v.sectionCode);\n      const map = /* @__PURE__ */ new Map([[\"\", 1]]);\n      for (const d of v.definitions) {\n        const id = shifts.length + 1;\n        shifts.push({ id, code: d.code, start_time: d.start, end_time: d.end, end_day_offset: d.isWork ? Number(d.end < d.start) : 0, is_work_day: Number(d.isWork), is_leave_day: Number(d.isLeave) });\n        map.set(d.code, id);\n      }\n      for (const e of v.employees) {\n        names.set(e.gid, e.name);\n        for (let day = 1; day <= v.dayCount; day++) {\n          const date = ym + \"-\" + String(day).padStart(2, \"0\"), k = e.gid + \"|\" + date;\n          if (keys.has(k)) throw Error(\"GID/date \\u0E0B\\u0E49\\u0E33\\u0E02\\u0E49\\u0E32\\u0E21\\u0E41\\u0E1C\\u0E19\\u0E01: \" + k);\n          keys.add(k);\n          plans.push({ gid: e.gid, work_date: date, section_id: section, shift_id: map.get(e.days[day - 1]), employee_name: e.name });\n        }\n      }\n    }\n    if (plans.length > 12e3) throw Error(\"\\u0E23\\u0E2D\\u0E07\\u0E23\\u0E31\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E40\\u0E01\\u0E34\\u0E19 12,000 \\u0E41\\u0E16\\u0E27 Attendance \\u0E15\\u0E48\\u0E2D\\u0E23\\u0E2D\\u0E1A\");\n    return { plans, shifts, period, sections: [...sections], gids: [...names.keys()] };\n  }\n  function calculate(input) {\n    const prepared = preparePlans(input.plans), { plans, shifts, period } = prepared, sections = new Map(prepared.sections), shiftMap = new Map(shifts.map((s) => [s.id, s]));\n    const allowed = new Set(prepared.gids), punchSeen = /* @__PURE__ */ new Set(), punches = [], warnings = [];\n    let duplicates = 0, otherPunches = 0, outsidePunches = 0;\n    const [year, month] = period.split(\"-\").map(Number), from = Date.parse(period + \"-01T00:00:00+07:00\") - 864e5, next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), to = Date.parse(next + \"T00:00:00+07:00\") + 864e5;\n    for (const p of input.punches || []) {\n      if (!Number.isFinite(Date.parse(p.time))) throw Error(\"Invalid punch time\");\n      if (!allowed.has(p.gid)) {\n        otherPunches++;\n        continue;\n      }\n      const t = Date.parse(p.time);\n      if (t < from || t >= to) {\n        outsidePunches++;\n        continue;\n      }\n      const k = JSON.stringify([p.gid, p.time, p.device]);\n      if (punchSeen.has(k)) {\n        duplicates++;\n        continue;\n      }\n      punchSeen.add(k);\n      punches.push({ id: punches.length + 1, gid: p.gid, punched_at: p.time });\n    }\n    if (punches.length > 2e5) throw Error(\"\\u0E23\\u0E2D\\u0E07\\u0E23\\u0E31\\u0E1A\\u0E44\\u0E21\\u0E48\\u0E40\\u0E01\\u0E34\\u0E19 200,000 Punch \\u0E15\\u0E48\\u0E2D\\u0E23\\u0E2D\\u0E1A\");\n    const leaveSeen = /* @__PURE__ */ new Map(), leaves = [];\n    let otherLeaves = 0, leaveDuplicates = 0;\n    for (const l of input.leaves || []) {\n      if (!allowed.has(l.gid) || !l.date.startsWith(period + \"-\")) {\n        otherLeaves++;\n        continue;\n      }\n      if (![0.5, 1].includes(l.units) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(l.date) || (/* @__PURE__ */ new Date(l.date + \"T12:00:00Z\")).toISOString().slice(0, 10) !== l.date || typeof l.type !== \"string\" || !l.type.trim()) throw Error(\"Invalid leave data\");\n      const k = JSON.stringify([l.gid, l.date, l.type]);\n      if (leaveSeen.has(k)) {\n        if (leaveSeen.get(k) !== l.units) throw Error(\"Leave \\u0E0B\\u0E49\\u0E33\\u0E41\\u0E15\\u0E48 Units \\u0E15\\u0E48\\u0E32\\u0E07\\u0E01\\u0E31\\u0E19: \" + l.gid + \" \" + l.date);\n        leaveDuplicates++;\n        continue;\n      }\n      leaveSeen.set(k, l.units);\n      leaves.push({ gid: l.gid, leave_date: l.date, leave_name: l.type, leave_type_code: l.type, units: l.units });\n    }\n    const result = matchAttendance(plans, punches, [], shifts, leaves);\n    const clockProvided = input.clockProvided === true, leaveProvided = input.leaveProvided === true;\n    warnings.push(...result.warnings.filter((w) => clockProvided || ![\"NO_PUNCH\", \"SINGLE_SIDE_PUNCH\", \"PUNCH_OUTSIDE_WINDOWS\"].includes(w.code)));\n    if (!clockProvided) warnings.unshift({ code: \"CLOCK_NOT_PROVIDED\", message: \"\\u0E44\\u0E21\\u0E48\\u0E44\\u0E14\\u0E49\\u0E40\\u0E25\\u0E37\\u0E2D\\u0E01 All Today: \\u0E2A\\u0E23\\u0E49\\u0E32\\u0E07\\u0E41\\u0E1C\\u0E19\\u0E25\\u0E48\\u0E27\\u0E07\\u0E2B\\u0E19\\u0E49\\u0E32 \\u0E44\\u0E21\\u0E48\\u0E2A\\u0E23\\u0E38\\u0E1B\\u0E02\\u0E32\\u0E14\\u0E07\\u0E32\\u0E19/X/Y\" });\n    if (!leaveProvided) warnings.unshift({ code: \"LEAVE_NOT_PROVIDED\", message: \"\\u0E44\\u0E21\\u0E48\\u0E44\\u0E14\\u0E49\\u0E40\\u0E25\\u0E37\\u0E2D\\u0E01 Leave Record: \\u0E22\\u0E31\\u0E07\\u0E44\\u0E21\\u0E48\\u0E44\\u0E14\\u0E49\\u0E15\\u0E23\\u0E27\\u0E08\\u0E02\\u0E49\\u0E2D\\u0E21\\u0E39\\u0E25\\u0E25\\u0E32 Workday\" });\n    if (clockProvided && punches.length === 0) warnings.unshift({ code: \"NO_RELEVANT_PUNCH\", message: \"\\u0E44\\u0E1F\\u0E25\\u0E4C All Today \\u0E44\\u0E21\\u0E48\\u0E21\\u0E35 Punch \\u0E02\\u0E2D\\u0E07\\u0E1E\\u0E19\\u0E31\\u0E01\\u0E07\\u0E32\\u0E19/\\u0E0A\\u0E48\\u0E27\\u0E07\\u0E27\\u0E31\\u0E19\\u0E17\\u0E35\\u0E48\\u0E43\\u0E19\\u0E41\\u0E1C\\u0E19 \\u0E15\\u0E23\\u0E27\\u0E08\\u0E02\\u0E2D\\u0E1A\\u0E40\\u0E02\\u0E15\\u0E44\\u0E1F\\u0E25\\u0E4C\\u0E01\\u0E48\\u0E2D\\u0E19\\u0E43\\u0E0A\\u0E49\\u0E1C\\u0E25 X\" });\n    const punchGroups = /* @__PURE__ */ new Map();\n    for (const p of punches) {\n      if (!punchGroups.has(p.gid)) punchGroups.set(p.gid, []);\n      punchGroups.get(p.gid).push(p);\n    }\n    for (const ps of punchGroups.values()) ps.sort((a, b) => Date.parse(a.punched_at) - Date.parse(b.punched_at));\n    const rows = result.rows.map((r) => {\n      if (!clockProvided) {\n        r.real_in = null;\n        r.real_out = null;\n        r.xy = null;\n      }\n      const start = Date.parse(r.work_date + \"T00:00:00+07:00\"), end = Math.max(start + 864e5, r.scheduled_out ? Date.parse(r.scheduled_out) + 6 * 36e5 + 1 : 0), raw = (punchGroups.get(r.gid) || []).filter((p) => Date.parse(p.punched_at) >= start && Date.parse(p.punched_at) < end).map((p) => p.punched_at);\n      if (clockProvided && r.working && r.leave_half !== \"FULL_DAY\" && r.scheduled_out && Date.parse(r.scheduled_out) >= Date.parse(next + \"T00:00:00+07:00\") && !(punchGroups.get(r.gid) || []).some((p) => Date.parse(p.punched_at) >= Date.parse(next + \"T00:00:00+07:00\"))) warnings.push({ gid: r.gid, date: r.work_date, code: \"NEXT_MONTH_PUNCH_NOT_FOUND\", message: \"\\u0E44\\u0E21\\u0E48\\u0E1E\\u0E1A Punch \\u0E27\\u0E31\\u0E19\\u0E41\\u0E23\\u0E01\\u0E40\\u0E14\\u0E37\\u0E2D\\u0E19\\u0E16\\u0E31\\u0E14\\u0E44\\u0E1B\\u0E2A\\u0E33\\u0E2B\\u0E23\\u0E31\\u0E1A\\u0E01\\u0E30\\u0E02\\u0E49\\u0E32\\u0E21\\u0E40\\u0E14\\u0E37\\u0E2D\\u0E19\" });\n      return { gid: r.gid, full_name: r.employee_name, section: sections.get(r.section_id), work_date: r.work_date, shift: shiftMap.get(r.shift_id).code, working_in: r.fullScheduledIn, working_out: r.fullScheduledOut, real_in: r.real_in, real_out: r.real_out, late_minutes: clockProvided && r.real_in && r.expected_in_for_late ? Math.max(0, Math.floor((Date.parse(r.real_in) - Date.parse(r.expected_in_for_late)) / 6e4)) : null, xy: r.xy, leave_units: r.leave_units, leave_label: r.leave_label, remark: r.remark, time_clock_data: raw, data_status: clockProvided ? \"MATCHED / CHECK WARNINGS\" : \"PLAN ONLY\", leave_status: leaveProvided ? \"PROVIDED\" : \"NOT PROVIDED\", leave_half: r.leave_half };\n    });\n    const summary = { period, sections: prepared.sections.map((x) => x[1]), employees: prepared.gids.length, records: rows.length, punches: punches.length, duplicates, otherPunches, outsidePunches, otherLeaves, leaveDuplicates, leaves: leaves.length, clockProvided, leaveProvided, warningCount: warnings.length, sourceFiles: input.sourceFiles || [], databaseSaved: false };\n    return { rows, warnings, summary, plans: input.plans };\n  }\n\n  // src/local-worker.js\n  self.onmessage = (e) => {\n    try {\n      self.postMessage({ ok: true, result: calculate(e.data) });\n    } catch (error) {\n      self.postMessage({ ok: false, error: error.message });\n    }\n  };\n})();\n"],{type:"text/javascript"}));
;
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 let otAllowanceOnly=false,approvalBusy=false,approvalReadBusy=false,approvalRun=0,approvalState=null,approvalDraft=null,loadedPeriod=null,loadingPeriod=null;
 let result=null,blob=null,worker=null,busy=false,page=0,reviewSection=null,editor=null,editorDirty=false,dbMode=false,dbSource=false,dbBusy=false;
 const db=()=>window.parent!==window?window.parent.AttendanceDB:null;
 const edits=new Map(),numeric=['ot15','ot20','ot30','meal','stand_by','emergency'],money=new Set(['meal','stand_by','emergency']);
 const key=r=>JSON.stringify([r.section,r.gid,r.work_date]);
 const status=t=>{$('status').textContent=t;};
 const formatMoney=v=>v==null?'':v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const units=v=>Math.round(v*100);
 function parseNumber(value,isMoney){const v=value.trim();if(!v)return null;if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(v))throw Error('ใช้ตัวเลขไม่ติดลบ ทศนิยมสูงสุด 2 ตำแหน่ง');const [a,b='']=v.replace(/,/g,'').split('.'),n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n>(isMoney?999999999:999999))throw Error(isMoney?'จำนวนเงินสูงสุด 9,999,999.99':'ชั่วโมงสูงสุด 9,999.99');return n/100;}
 function sum(row,fields){return fields.every(f=>row[f]==null)?null:fields.reduce((n,f)=>n+units(row[f]||0),0)/100;}

 const timeFields=['shift','working_in','working_out','real_in','real_out'];
 const copyOverrides=v=>Object.fromEntries(timeFields.filter(f=>Object.hasOwn(v||{},f)).map(f=>[f,v[f]]));
 const localInput=v=>v?new Date(Date.parse(v)+7*3600000).toISOString().slice(0,16):'';
 function inputTimestamp(v){if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))throw Error('วันที่และเวลาไม่ถูกต้อง');const t=v+':00+07:00';if(!Number.isFinite(Date.parse(t))||localInput(t)!==v)throw Error('วันที่และเวลาไม่ถูกต้อง');return t;}
 // Time-only editor: keep the attendance date as base, preserve explicit day offsets.
 function attendanceDayOffset(timestamp,workDate){if(!timestamp)return 0;return Math.round((Date.parse(localInput(timestamp).slice(0,10)+'T00:00:00Z')-Date.parse(workDate+'T00:00:00Z'))/86400000);}
 function timeOnlyTimestamp(value,workDate,offset){if(!value)return null;if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('กรอกเวลา HH:mm');const n=Number(offset);if(!Number.isInteger(n)||n< -1||n>3)throw Error('วันของเวลาอยู่นอกช่วงที่อนุญาต');const base=Date.parse(workDate+'T00:00:00Z');if(!Number.isFinite(base))throw Error('วันที่ Attendance ไม่ถูกต้อง');const day=new Date(base+n*86400000).toISOString().slice(0,10);return inputTimestamp(day+'T'+value);}
 function syncTimeDay(f){if(f!=='shift')$('edit-time-'+f+'-day').disabled=$('edit-time-'+f+'-mode').value!=='manual';}
 function sameOverrides(a,b){return timeFields.every(f=>Object.hasOwn(a,f)===Object.hasOwn(b,f)&&a[f]===b[f]);}
 function validateTimes(base,o,before={}){const v={...base,...o};const changed=f=>Object.hasOwn(before,f)!==Object.hasOwn(o,f)||before[f]!==o[f];const workingChanged=['shift','working_in','working_out'].some(changed),actualChanged=['real_in','real_out'].some(changed);
  for(const f of timeFields.slice(1)){if(Object.hasOwn(o,f)&&o[f]){const t=Date.parse(o[f]),start=Date.parse(base.work_date+'T00:00:00+07:00');if(!Number.isFinite(t)||t<start-86400000||t>start+3*86400000)throw Error('เวลาอยู่ได้ตั้งแต่วันก่อนหน้า ถึง 2 วันถัดจากวันที่ทำงาน');}}
  if(workingChanged){if(v.shift!=null&&!/^(?:[A-Z][A-Z0-9]{0,7})?$/.test(v.shift))throw Error('Shift ใช้รหัสตัวพิมพ์ใหญ่ไม่เกิน 8 ตัว');if(Boolean(v.working_in)!==Boolean(v.working_out))throw Error('Working In และ Out ต้องมีทั้งคู่ หรือเว้นว่างทั้งคู่');if(!v.shift&&(v.working_in||v.working_out))throw Error('วันหยุดต้องเว้น Working In/Out ว่าง');if(v.shift&&!v.working_in&&!['AL','SL','RL','CL','ML','PL'].includes(v.shift))throw Error('กะทำงานต้องมี Working In/Out');}
  for(const [a,b,check] of [['working_in','working_out',workingChanged],['real_in','real_out',actualChanged]])if(check&&v[a]&&v[b]&&(!Number.isFinite(Date.parse(v[a]))||!Number.isFinite(Date.parse(v[b]))||Date.parse(v[b])<=Date.parse(v[a])||Date.parse(v[b])-Date.parse(v[a])>36*3600000))throw Error('เวลา Out ต้องหลัง In และช่วงเวลาต้องไม่เกิน 36 ชั่วโมง');return v;
 }
 function applyTimes(r,e){if(!r.matching_base)r.matching_base=Object.fromEntries([...timeFields,'late_minutes','xy','remark','data_status','leave_units','leave_label','leave_half','leave_status'].map(f=>[f,r[f]]));const b=r.matching_base,o=copyOverrides(e.time_overrides);applyLeave(r,e,b);for(const f of timeFields){r[f]=Object.hasOwn(o,f)?o[f]:b[f];r['manual_'+f]=Object.hasOwn(o,f)?1:0;}
  r.time_overrides=o;r.time_change_reason=e.time_change_reason||'';r.time_manual=Object.keys(o).length>0;r.generated_xy=b.xy;r.late_minutes=b.late_minutes;r.generated_remark=b.remark;r.data_status=b.data_status;
  if(r.time_manual||r.leave_manual){const work=Boolean(r.working_in&&r.working_out),full=r.leave_half==='FULL_DAY',unresolved=r.leave_half==='UNRESOLVED';let expected=r.working_in;
   if(r.leave_half==='FIRST_HALF'&&work)expected=new Date((Date.parse(r.working_in)+Date.parse(r.working_out))/2).toISOString();
   r.late_minutes=work&&!full&&!unresolved&&r.real_in?Math.max(0,Math.floor((Date.parse(r.real_in)-Date.parse(expected))/60000)):null;
   if(full||!work)r.generated_xy='';else if(!unresolved)r.generated_xy=r.real_in&&r.real_out?'':r.real_in||r.real_out?'X':(r.time_clock_data||[]).length?'':'Y';
   r.data_status=[b.data_status,r.time_manual?'MANUAL TIME':'',r.leave_manual?'MANUAL LEAVE':''].filter(Boolean).join(' | ');
  }
 }
 const leaveFields=['leave_units','leave_type','leave_half'];
 const copyLeave=v=>Object.fromEntries(leaveFields.filter(f=>Object.hasOwn(v||{},f)).map(f=>[f,v[f]]));
 const sameLeave=(a,b)=>leaveFields.every(f=>Object.hasOwn(a,f)===Object.hasOwn(b,f)&&a[f]===b[f]);
 function applyLeave(r,e,b){const o=copyLeave(e.leave_overrides);r.leave_overrides=o;r.leave_manual=Object.keys(o).length>0;r.manual_leave_units=Object.hasOwn(o,'leave_units')?1:0;r.manual_leave_type=Object.hasOwn(o,'leave_type')?1:0;r.leave_units=r.manual_leave_units?o.leave_units:b.leave_units;r.leave_label=r.manual_leave_type?o.leave_type:b.leave_label;r.leave_half=Object.hasOwn(o,'leave_half')?o.leave_half:b.leave_half;r.leave_status=r.leave_manual?'MANUAL':b.leave_status;r.leave_change_reason=e.leave_change_reason||'';}
 function syncLeave(){for(const f of ['leave_units','leave_type'])$('edit-'+f+'-value').disabled=$('edit-'+f+'-mode').value!=='manual';$('edit-leave-half-value').disabled=$('edit-leave_units-mode').value!=='manual'||$('edit-leave_units-value').value!=='0.5';}
 const manualLeaveTypes=['TH_Annual Leave','TH_Casual leave','TH_Leave without Pay','TH_Military Service Leave','TH_Paternity / Parental Leave (Spousal-Support Leave)','TH_Religious Ceremony Leave','TH_Sick Leave','TH_Sterilisation Leave'];
 function initLeaveTypeOptions(current){const el=$('edit-leave_type-value');el.replaceChildren(new Option('— เว้นว่าง / ไม่มีประเภทลา —',''));for(const label of manualLeaveTypes)el.add(new Option(label,label));if(current&&!manualLeaveTypes.includes(current))el.add(new Option(current+' (ค่าปัจจุบันจากข้อมูลเดิม)',current));}
 function initLeaveEditor(r){initLeaveTypeOptions(r.leave_label);for(const [f,v] of [['leave_units',r.leave_units],['leave_type',r.leave_label]]){$('edit-'+f+'-mode').value='keep';$('edit-'+f+'-value').value=v??'';}$('edit-leave-half-value').value=r.leave_half||'UNRESOLVED';$('edit-leave-reason').value='';syncLeave();}
 for(const f of ['leave_units','leave_type']){for(const part of ['mode','value'])$('edit-'+f+'-'+part).addEventListener(part==='mode'?'change':'input',()=>{syncLeave();editorDirty=true;});}
 for(const id of ['edit-leave-half-value','edit-leave-reason'])$(id).addEventListener('input',()=>{editorDirty=true;});
 function readLeaveDraft(r,values){const before=copyLeave(values.leave_overrides),o={...before};for(const f of ['leave_units','leave_type']){const mode=$('edit-'+f+'-mode').value;if(mode==='keep')continue;if(mode==='auto'){delete o[f];if(f==='leave_units')delete o.leave_half;}else{const raw=$('edit-'+f+'-value').value;if(f==='leave_units'){o[f]=raw===''?null:Number(raw);if(o[f]!==null&&![0,0.5,1].includes(o[f]))throw Error('Leave ต้องเป็นว่าง 0 0.5 หรือ 1');o.leave_half=o[f]===1?'FULL_DAY':o[f]===0.5?$('edit-leave-half-value').value:null;}else{o[f]=raw.trim();if(o[f].length>200||/[\u0000-\u001F]/.test(o[f]))throw Error('Leave Type ไม่ถูกต้อง');}}}
  const changed=!sameLeave(before,o);if(changed){if(!dbSource||db()?.profile.role!=='DEPARTMENT_ADMIN')throw Error('แก้ Leave ได้เฉพาะบัญชีแผนกบน Database');const n=Object.hasOwn(o,'leave_units')?o.leave_units:r.matching_base.leave_units,type=Object.hasOwn(o,'leave_type')?o.leave_type:r.matching_base.leave_label,half=Object.hasOwn(o,'leave_half')?o.leave_half:r.matching_base.leave_half;if(n>0&&!String(type||'').trim())throw Error('กรุณาระบุ Leave Type เมื่อมีวันลา');if(n===0.5&&!['FIRST_HALF','SECOND_HALF','UNRESOLVED'].includes(half))throw Error('กรุณาระบุช่วงลาครึ่งวัน');const reason=$('edit-leave-reason').value.trim();if(reason.length<3||reason.length>1000||/[\u0000-\u001F]/.test(reason))throw Error('กรุณากรอกเหตุผลการแก้ Leave 3–1000 ตัวอักษร');values.leave_overrides=o;values.leave_change_reason=reason;}return changed;
 }
 function initTimeEditor(r){for(const f of timeFields){$('edit-time-'+f+'-mode').value='keep';$('edit-time-'+f+'-value').value=f==='shift'?r[f]||'':localInput(r[f]).slice(11,16);$('edit-time-'+f+'-value').disabled=true;if(f!=='shift'){const el=$('edit-time-'+f+'-day');for(const opt of [...el.options])if(opt.dataset.legacy)opt.remove();const day=attendanceDayOffset(r[f],r.work_date);if(![...el.options].some(o=>o.value===String(day))){const opt=new Option('วันเดิม ('+day+')',String(day));opt.dataset.legacy='1';el.add(opt);}el.value=String(day);syncTimeDay(f);}}$('edit-time-reason').value='';$('edit-time-original').textContent='Matching ต้นฉบับ: '+(r.matching_base.shift||'วันหยุด')+' | Working '+time(r.matching_base.working_in)+'–'+time(r.matching_base.working_out)+' | Actual '+time(r.matching_base.real_in)+'–'+time(r.matching_base.real_out);$('edit-time-current').textContent=r.time_manual?'Manual ปัจจุบัน: '+Object.keys(r.time_overrides).join(', ')+' | เหตุผลล่าสุด: '+r.time_change_reason:'ยังไม่มี Manual กะ/เวลา';}
 for(const f of timeFields){$('edit-time-'+f+'-mode').addEventListener('change',()=>{$('edit-time-'+f+'-value').disabled=$('edit-time-'+f+'-mode').value!=='manual';syncTimeDay(f);editorDirty=true;});$('edit-time-'+f+'-value').addEventListener('input',()=>{editorDirty=true;});}
 for(const f of timeFields.slice(1))$('edit-time-'+f+'-day').addEventListener('change',()=>{editorDirty=true;});
 $('edit-time-reason').addEventListener('input',()=>{editorDirty=true;});
 $('edit-time-reset').addEventListener('click',()=>{for(const f of timeFields){$('edit-time-'+f+'-mode').value='auto';$('edit-time-'+f+'-value').disabled=true;syncTimeDay(f);}editorDirty=true;$('edit-time-reason').focus();});
 function readTimeDraft(r,values){const before=copyOverrides(values.time_overrides),o={...before};for(const f of timeFields){const mode=$('edit-time-'+f+'-mode').value;if(mode==='auto')delete o[f];else if(mode==='manual'){const value=$('edit-time-'+f+'-value').value;o[f]=f==='shift'?value.trim().toUpperCase():timeOnlyTimestamp(value,r.work_date,$('edit-time-'+f+'-day').value);}}
  const changed=!sameOverrides(before,o);if(changed){if(!dbSource||db()?.profile.role!=='DEPARTMENT_ADMIN')throw Error('แก้กะ/เวลาได้เฉพาะบัญชีแผนกบน Database');const reason=$('edit-time-reason').value.trim();if(reason.length<3||reason.length>1000||/[\u0000-\u001F]/.test(reason))throw Error('กรุณากรอกเหตุผลการแก้กะ/เวลา 3–1000 ตัวอักษร');if(Object.keys(o).length)validateTimes({...r.matching_base,work_date:r.work_date},o,before);values.time_overrides=o;values.time_change_reason=reason;}return changed;
 }
 function apply(r){const e=edits.get(key(r))||{};applyTimes(r,e);for(const f of numeric)r[f]=e[f]??null;for(const f of ['ot_refer','allowance_refer'])r[f]=e[f]??'';r.total_ot=sum(r,['ot15','ot20','ot30']);r.total_allowance=sum(r,['meal','stand_by','emergency']);if(!Object.hasOwn(r,'generated_xy')){r.generated_xy=r.xy;r.generated_remark=r.remark;}r.manual_xy=Object.hasOwn(e,'xy')?1:0;r.xy=r.manual_xy?e.xy:r.generated_xy;r.manual_remark=Object.hasOwn(e,'remark')?1:0;r.remark=r.manual_remark?e.remark:r.generated_remark;}
 const time=v=>v?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v)):'';
 const date=v=>Number(v.slice(8))+'-'+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(v.slice(5,7))-1]+'-'+v.slice(2,4);
 function diff(a,b){if(!a||!b)return '';const n=Math.floor((Date.parse(b)-Date.parse(a))/60000);return n>=0?String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'):'';}
 function showView(view){if(view==='users'&&db()?.profile.role!=='SUPER_ADMIN')return;if(view==='central-ot'&&db()?.profile.role!=='SUPER_ADMIN')return;if(view==='history'&&db()?.profile.role!=='SUPER_ADMIN')return;if(view==='upload'&&dbMode&&db()?.profile.role!=='SUPER_ADMIN')return;for(const name of ['attendance','shift','upload','history','central-ot','users']){$('view-'+name).hidden=name!==view;$('nav-'+name).classList.toggle('active',name===view);}if(view==='history')loadHistory();if(view==='central-ot')window.CentralOT?.open();if(view==='users')window.UserManagement?.open();}
 for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>showView(button.dataset.view));
 function manualCount(){return result?result.rows.filter(r=>edits.has(key(r))).length:0;}
 function refreshManual(){refreshApprovalButton();refreshOTUpload();$('ot-allowance-filter').disabled=!result;$('ot-allowance-filter').setAttribute('aria-pressed',String(otAllowanceOnly));$('ot-allowance-filter').title=otAllowanceOnly?'กดเพื่อยกเลิกตัวกรอง OT&Allowance':'แสดงเฉพาะแถวที่มี OT หรือ Allowance มากกว่า 0';$('manual-status').textContent=manualCount()?'ค่าทดสอบใน RAM '+manualCount()+' แถว · Export Excel เพื่อเก็บงาน · ไม่บันทึก Database':'Central ไม่ต้องคีย์ OT/Allowance ตอนอัปโหลด — ช่องใหม่ว่าง';$('download').disabled=!result;$('save-database').disabled=!dbMode||dbBusy||!result||dbSource||db()?.profile.role!=='SUPER_ADMIN';if(dbMode)$('manual-status').textContent=dbSource?'ข้อมูลจาก Database · บันทึก Drawer แล้วคงอยู่ข้าม Login':'Preview ในเครื่อง · ยังไม่บันทึก Database';}
 function closeEditor(){if($('edit-dialog').open)$('edit-dialog').close();editor=null;editorDirty=false;}
 function stopReview(){reviewSection=dbSource&&db()?.profile.role==='DEPARTMENT_ADMIN'?db().sections[0]?.code||null:null;$('review-mode').checked=false;closeEditor();$('view-mode').textContent=dbMode?(db()?.profile.role||'Session หมดอายุ')+' · Read only':'Central · Read only';}
 function invalidate(){clearApproval();loadedPeriod=null;otAllowanceOnly=false;$('upload-preview').hidden=true;$('upload-preview-wrap').replaceChildren();dbSource=false;$('edit-save').textContent='บันทึกในเครื่อง — Test';$('drawer-disclaimer').textContent='Preview ในเครื่อง · ยังไม่บันทึก Database';result=null;blob=null;page=0;stopReview();$('download').disabled=true;$('preview').replaceChildren();$('warnings').replaceChildren();$('shift-head').replaceChildren();$('shift-rows').replaceChildren();$('summary').textContent='ยังไม่ได้ประมวลผล — ไปที่ Upload Data';$('period-display').value='';$('page-info').textContent='';$('prev-page').disabled=true;$('next-page').disabled=true;$('manual-status').textContent=edits.size?'เก็บค่าทดสอบ '+edits.size+' แถวใน RAM ใช้เฉพาะ Department/GID/Date เดิม':'Central ไม่ต้องคีย์ OT/Allowance ตอนอัปโหลด';for(const id of ['stat-records','stat-people','stat-x','stat-y','stat-leave'])$(id).textContent='0';}
 function fileList(input){return [...input.files].map(f=>f.name+' ('+Math.round(f.size/1024)+' KB)').join('\n')||'ไม่ได้เลือกไฟล์';}
 for(const id of ['plans','clock','leave'])$(id).addEventListener('change',()=>{if(editorDirty&&!confirm('ทิ้งค่าที่ยังไม่บันทึกในแถบแก้ไข แล้วเปลี่ยนไฟล์?')){$(id).value='';$(id+'-list').textContent='ไม่ได้เลือกไฟล์ — เลือกใหม่ภายหลัง';return;}invalidate();$(id+'-list').textContent=fileList($(id));});
 function attendanceFilename(summary){const sections=[...new Set((summary.sections||[]).map(s=>String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim()).filter(Boolean))];return 'Attendance_'+summary.period+'_'+(sections.join('_')||'All_Departments')+'.xlsx';}
 function download(){if(!result)return;result.summary.manualEditedRows=manualCount();result.summary.manualStore=dbSource?'SUPABASE':'RAM_ONLY_TEST_PREVIEW';result.summary.otUnit='DECIMAL_HOURS';result.summary.totalOTRule='SUM_OT15_OT20_OT30_HOURS';result.summary.allowanceUnit='MONEY_2_DECIMAL';blob=window.AttendanceExcel.build(result.rows,result.warnings,result.summary);const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=attendanceFilename(result.summary);a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status(dbSource?'ดาวน์โหลด Excel จากข้อมูล Database แล้ว':'ดาวน์โหลด Excel แล้ว — Preview ยังไม่บันทึก Database');}
 $('download').addEventListener('click',download);$('ot-allowance-filter').addEventListener('click',()=>{if(!result)return;otAllowanceOnly=!otAllowanceOnly;renderTable();});
 $('reset').addEventListener('click',()=>{if(busy||dbBusy)return;if((edits.size||editorDirty)&&!confirm('ล้างไฟล์และค่าทดสอบใน RAM ทั้งหมด? Export Excel เก็บงานก่อน'))return;edits.clear();for(const id of ['plans','clock','leave']){$(id).value='';$(id+'-list').textContent='ไม่ได้เลือกไฟล์';}invalidate();status('ล้างไฟล์แล้ว');});
 function td(tr,v,cls=''){const c=document.createElement('td');c.textContent=v??'';c.className=cls;c.title=String(v??'');tr.appendChild(c);return c;}
 function allowedSection(){return db()?.profile.role==='DEPARTMENT_ADMIN'?db().sections[0]?.code||'__NO_ACCESS__':$('section-filter').value;}
 function hasOTAllowance(r){apply(r);return numeric.some(f=>Number(r[f])>0);}
 function remarkText(r){return [r.remark||'',r.ot_refer?'OT Refer: '+r.ot_refer:'',r.allowance_refer?'Allowance Refer: '+r.allowance_refer:''].filter(Boolean).join(' | ');}
 function filtered(){if(!result)return[];const section=allowedSection(),gid=$('person-filter').value,month=$('db-period').value;return result.rows.filter(r=>(!section||r.section===section)&&(!gid||r.gid===gid)&&(!month||r.work_date.slice(0,7)===month)&&(!otAllowanceOnly||hasOTAllowance(r)));}
 function renderTable(){const rows=filtered(),max=0;page=0;const body=$('preview'),wrap=body.closest('.table-wrap'),scroll=wrap.scrollLeft;body.replaceChildren();
  for(const r of rows){apply(r);const tr=document.createElement('tr');tr.dataset.rowKey=key(r);td(tr,r.gid,'person sticky-gid');td(tr,r.full_name,'person sticky-name');td(tr,date(r.work_date),'person');td(tr,['Su','Mo','Tu','We','Th','Fr','Sa'][new Date(r.work_date+'T12:00:00Z').getUTCDay()],'person');for(const f of timeFields){const c=td(tr,f==='shift'?r[f]:time(r[f]),(f.startsWith('real_')?'actual':'work')+(f==='shift'?'':' time')+(r['manual_'+f]?' manual-time':''));if(r['manual_'+f]){c.title='Manual · '+r.time_change_reason+' · '+(f==='shift'?r[f]:localInput(r[f]));const tag=document.createElement('span');tag.className='manual-mark';tag.textContent='M';tag.setAttribute('aria-label','Manual');c.appendChild(tag);}}td(tr,diff(r.real_in,r.real_out),'actual time');
   const raw=td(tr,'','raw');for(const p of r.time_clock_data||[]){const local=new Date(Date.parse(p)+7*3600000).toISOString().slice(0,10),span=document.createElement('span');span.className='raw-item';span.textContent=(local===r.work_date?'':Number(local.slice(8))+'/'+Number(local.slice(5,7))+' ')+time(p);raw.appendChild(span);}
   for(const f of ['ot15','ot20','ot30','total_ot','meal','stand_by','emergency','total_allowance']){const cls=f.startsWith('ot')||f==='total_ot'?'ot':'allowance',c=td(tr,money.has(f)?(r[f]==null?'':new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(r[f])):f==='total_allowance'?formatMoney(r[f]):r[f],cls+(f.endsWith('refer')?' reference':'')+(f.startsWith('total')?' total':''));if(Object.hasOwn(edits.get(key(r))||{},f))c.classList.add('manual-time');}
   td(tr,r.late_minutes,'late-cell');const xy=td(tr,'','xy-cell'+(r.manual_xy?' manual-time':''));if(r.xy){const badge=document.createElement('span');badge.className='tag '+r.xy.toLowerCase();badge.textContent=r.xy;xy.appendChild(badge);}td(tr,r.leave_units,'leave');td(tr,r.leave_label,'leave leave-type-cell');td(tr,remarkText(r),'leave remark-cell'+(r.manual_remark?' manual-time':''));for(const v of [r.section,r.data_status,r.leave_status,r.leave_half])td(tr,v,'person upload-meta');
   const cell=td(tr,'','edit-cell'),button=document.createElement('button');button.type='button';button.className='row-edit';button.textContent='แก้ไข';button.disabled=!reviewSection||r.section!==reviewSection;button.title=button.disabled?'สำหรับขั้นตอน Department review — ยังไม่เปิด Login แผนกจริง':'เปิดตัวอย่างแถบแก้ไขด้านขวา';button.addEventListener('click',()=>openEditor(r));cell.appendChild(button);body.appendChild(tr);
  }
  if(!rows.length){const tr=document.createElement('tr'),c=td(tr,(otAllowanceOnly?'ไม่มีแถวที่มี OT หรือ Allowance มากกว่า 0 ตามตัวกรองนี้':dbMode?'ยังไม่มีข้อมูล — เลือกเดือนแล้วกด โหลดจาก Database':'ยังไม่มีข้อมูล — เลือกไฟล์ใน Upload Data แล้วประมวลผล'),'empty');c.colSpan=29;body.appendChild(tr);}
  wrap.scrollLeft=scroll;$('page-info').textContent=rows.length?'ทั้งหมด '+rows.length+' แถว':'';$('prev-page').disabled=page===0;$('next-page').disabled=page===max;for(const [id,val] of [['stat-records',rows.length],['stat-people',new Set(rows.map(r=>r.gid)).size],['stat-x',rows.filter(r=>r.xy==='X').length],['stat-y',rows.filter(r=>r.xy==='Y').length],['stat-leave',rows.filter(r=>r.leave_units!=null).length]])$(id).textContent=val;refreshManual();
 }
 function renderShift(){const head=$('shift-head'),body=$('shift-rows');head.replaceChildren();body.replaceChildren();if(!result)return;const plans=result.plans.filter(p=>!allowedSection()||p.sectionCode===allowedSection());const plan=plans[0];if(!plan)return;const days=new Date(Date.UTC(plan.year,plan.month,0)).getUTCDate(),tr=document.createElement('tr');td(tr,'Department / Employee','identity');for(let d=1;d<=days;d++)td(tr,d,'');head.appendChild(tr);
  for(const p of plans)for(const e of p.employees){const row=document.createElement('tr');td(row,p.sectionCode+' · '+e.name+' · '+e.gid,'identity');for(let d=0;d<days;d++){const c=td(row,'',new Date(Date.UTC(p.year,p.month-1,d+1)).getUTCDay()%6===0?'weekend':'');if(e.days[d]){const b=document.createElement('span');b.className='shift-badge '+e.days[d][0].toLowerCase();b.textContent=e.days[d];c.appendChild(b);}}body.appendChild(row);}
 }
 function populatePeople(){const selected=$('person-filter').value,people=new Map();for(const r of result?.rows||[])if(!allowedSection()||r.section===allowedSection())people.set(r.gid,r.full_name);$('person-filter').replaceChildren(new Option('All person',''));for(const [gid,name] of [...people].sort((a,b)=>a[1].localeCompare(b[1])))$('person-filter').appendChild(new Option(name+' / '+gid,gid));if(people.has(selected))$('person-filter').value=selected;}
 function search(){page=0;renderTable();renderShift();}
 $('person-filter').addEventListener('change',search);$('db-period').addEventListener('change',()=>{
   if(dbBusy||busy||approvalBusy||requestMailBusy||$('request-mail-dialog').open||otUploadBusy||$('ot-upload-dialog').open){$('db-period').value=loadingPeriod||loadedPeriod||result?.summary.period||currentMonth();return;}
   if(dbMode&&db()?.profile.role!=='MANAGER'){
    if((editorDirty||result&&!dbSource)&&!confirm(editorDirty?'ทิ้ง draft ที่ยังไม่บันทึกแล้วเปลี่ยนเดือน?':'เปลี่ยนเดือนจะล้าง Matching Preview ที่ยังไม่บันทึก ต้องการเปลี่ยนหรือไม่?')){$('db-period').value=loadedPeriod||result?.summary.period||currentMonth();return;}
    waitForDatabase();
   }else{clearApproval();if(dbMode)loadDatabase();else search();}
  });$('section-filter').addEventListener('change',()=>{clearApproval();stopReview();populatePeople();search();readApproval();});
 for(const [id,d] of [['prev-page',-1],['next-page',1]])$(id).addEventListener('click',()=>{page=Math.max(0,page+d);renderTable();});
 $('review-mode').addEventListener('change',()=>{if(dbMode){$('review-mode').checked=false;return;}const section=$('section-filter').value;if($('review-mode').checked&&(!result||!section)){$('review-mode').checked=false;$('manual-status').textContent='เลือก Department เดียวก่อนเปิดตัวอย่างแถบแก้ไขของแผนก';return;}reviewSection=$('review-mode').checked?section:null;$('view-mode').textContent=reviewSection?'Department drawer preview · '+section:'Central · Read only';closeEditor();renderTable();});
 function syncModes(){for(const f of ['remark','xy'])$('edit-'+f+'-value').disabled=$('edit-'+f+'-mode').value!=='manual';}
 for(const f of ['remark','xy'])$('edit-'+f+'-mode').addEventListener('change',()=>{syncModes();editorDirty=true;});
 function draftNumbers(){const draft={};let good=true;for(const f of numeric){const input=$('edit-'+f);try{draft[f]=parseNumber(input.value,money.has(f))??0;input.classList.remove('invalid');input.removeAttribute('aria-invalid');}catch(error){good=false;input.classList.add('invalid');input.setAttribute('aria-invalid','true');$('edit-message').textContent=error.message;}}
  $('edit-total-ot').value=good?sum(draft,['ot15','ot20','ot30'])??'':'';$('edit-total-allowance').value=good?formatMoney(sum(draft,['meal','stand_by','emergency'])):'';if(good)$('edit-message').textContent=dbSource?'กดบันทึกเข้า Database เพื่อยืนยันค่า':'ค่าจะเข้าตารางเมื่อกดบันทึกในเครื่อง — ยังไม่บันทึก Database';return good?draft:null;}
 for(const f of numeric)$('edit-'+f).addEventListener('input',()=>{editorDirty=true;draftNumbers();});for(const f of ['remark','xy'])$('edit-'+f+'-value').addEventListener('input',()=>{editorDirty=true;});
 function openEditor(r){if(dbMode&&(db()?.profile.role!=='DEPARTMENT_ADMIN'||!dbSource))return;if(!reviewSection||r.section!==reviewSection)return;editor=r;editorDirty=false;apply(r);initTimeEditor(r);initLeaveEditor(r);$('edit-subtitle').textContent=r.section+' · '+r.gid+' · '+r.full_name+' · '+date(r.work_date);$('edit-matching-info').textContent=(r.shift||'วันหยุด')+' · Working '+time(r.working_in)+'–'+time(r.working_out)+' · Real '+time(r.real_in)+'–'+time(r.real_out);for(const f of numeric)$('edit-'+f).value=money.has(f)?formatMoney(r[f]):r[f]??'';const legacy=[r.ot_refer?'OT Refer: '+r.ot_refer:'',r.allowance_refer?'Allowance Refer: '+r.allowance_refer:''].filter(Boolean).join(' | ');$('legacy-refer-info').hidden=!legacy;$('legacy-refer-info').textContent=legacy?'ข้อมูล Refer เดิมเก็บไว้และแสดงต่อท้าย Remark: '+legacy:'';for(const f of ['remark','xy']){$('edit-'+f+'-mode').value='keep';$('edit-'+f+'-value').value=r[f]||'';}syncModes();draftNumbers();$('edit-dialog').showModal();}
 function cancelEditor(){if(dbBusy)return;if(editorDirty&&!confirm('ทิ้งค่าที่ยังไม่บันทึกในแถบแก้ไข?'))return;closeEditor();}
 $('edit-cancel').addEventListener('click',cancelEditor);$('edit-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelEditor();});
 $('edit-form').addEventListener('submit',async e=>{e.preventDefault();if(dbBusy||approvalBusy||dbMode&&db()?.profile.role!=='DEPARTMENT_ADMIN')return;if(!editor||!reviewSection||editor.section!==reviewSection){$('edit-message').textContent='ตัวอย่างแผนกเปลี่ยนแล้ว กรุณาเปิดแถวใหม่';return;}const draft=draftNumbers();if(!draft)return;try{const k=key(editor),values={...edits.get(k)};for(const f of numeric){if(draft[f]==null)delete values[f];else values[f]=draft[f];}
   for(const f of ['remark','xy']){const mode=$('edit-'+f+'-mode').value;if(mode==='keep')continue;if(mode==='auto')delete values[f];else{const v=$('edit-'+f+'-value').value;if(f==='remark'&&(v.length>1000||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)))throw Error('Remark ไม่ถูกต้อง');if(f==='xy'&&!['','X','Y'].includes(v))throw Error('X/Y ไม่ถูกต้อง');values[f]=v;}}
   const timeChanged=readTimeDraft(editor,values),leaveChanged=readLeaveDraft(editor,values);if(dbSource){if(!db())throw Error('Session หมดอายุ');dbBusy=true;$('edit-save').disabled=true;$('edit-cancel').disabled=true;const payload={};for(const f of [...numeric,'ot_refer','allowance_refer'])payload[f]=values[f]??null;payload.manual_remark=Object.hasOwn(values,'remark')?values.remark:null;payload.manual_xy=Object.hasOwn(values,'xy')?values.xy:null;if(timeChanged){payload.time_overrides=values.time_overrides;payload.time_change_reason=values.time_change_reason;}if(leaveChanged){payload.leave_overrides=values.leave_overrides;payload.leave_change_reason=values.leave_change_reason;}await db().saveEdit(editor.db_id,payload);}
   if(Object.keys(values).length)edits.set(k,values);else edits.delete(k);apply(editor);blob=null;closeEditor();renderTable();if(dbSource)result.plans=plansFromAttendance(result.rows);renderShift();$('manual-status').textContent=dbSource?'บันทึกเข้า Database สำเร็จ':'บันทึกค่าทดสอบใน RAM แล้ว — กด Export Excel เก็บงาน ไม่ได้บันทึก Database';
  }catch(error){$('edit-message').textContent='บันทึกไม่สำเร็จ: '+error.message;}finally{dbBusy=false;$('edit-save').disabled=false;$('edit-cancel').disabled=false;if(dbSource)readApproval();}
 });
 function render(){const s=result.summary;$('summary').textContent=s.period+' | '+s.sections.join(', ');$('period-display').value=s.period;const select=$('section-filter');select.replaceChildren();for(const v of (dbMode?db().profile.role==='DEPARTMENT_ADMIN'?db().sections.map(x=>x.code):['',...db().sections.map(x=>x.code)]:['',...s.sections])){const o=document.createElement('option');o.value=v;o.textContent=db()?.sections.find(x=>x.code===v)?.name||v||'All Department';select.appendChild(o);}if(!dbMode){$('db-period').min=s.period;$('db-period').max=s.period;}$('db-period').value=s.period;populatePeople();page=0;renderTable();renderShift();const ws=$('warnings');ws.replaceChildren();for(const w of result.warnings.slice(0,100)){const li=document.createElement('li');li.textContent=[w.gid,w.date,w.code,w.message].filter(Boolean).join(' | ');ws.appendChild(li);}}
 async function compute(data){return new Promise((resolve,reject)=>{worker=new Worker(window.LOCAL_WORKER_URL||'/assets/local-worker.js',{type:'classic'});worker.onmessage=e=>{worker.terminate();worker=null;e.data.ok?resolve(e.data.result):reject(Error(e.data.error));};worker.onerror=()=>{worker.terminate();worker=null;reject(Error('Web Worker ทำงานไม่ได้ กรุณาใช้ Chrome/Edge รุ่นล่าสุด'));};worker.postMessage(data);});}
 $('process-form').addEventListener('submit',async e=>{e.preventDefault();if(busy||dbBusy||dbMode&&db()?.profile.role!=='SUPER_ADMIN')return;if(editorDirty&&!confirm('ทิ้งค่าที่ยังไม่บันทึกในแถบแก้ไข แล้วประมวลผลใหม่?'))return;invalidate();busy=true;for(const id of ['process','reset','plans','clock','leave'])$(id).disabled=true;
  try{
   const planFiles=[...$('plans').files],clockFiles=[...$('clock').files],leaveFiles=[...$('leave').files];if(!planFiles.length||planFiles.length>12||clockFiles.length>12||leaveFiles.length>12)throw Error('เลือก Shift Plan 1–12 ไฟล์ และ All Today/Leave อย่างละไม่เกิน 12 ไฟล์');
   const plans=[],seen=new Set(),legendIssues=[];let period=null;const gids=new Set();
   for(const f of planFiles){status('อ่าน Shift Plan: '+f.name);let p;try{p=await window.AttendanceXlsx.read(f,'REAL');}catch(error){throw Error(f.name+' — '+error.message);}const ym=p.year+'-'+String(p.month).padStart(2,'0');if(period&&period!==ym)throw Error('Shift Plan ต้องเป็นเดือนเดียวกัน');period=ym;if(seen.has(p.sectionCode))throw Error('แผนกซ้ำ: '+p.sectionCode);seen.add(p.sectionCode);if(!Number.isInteger(p.year)||p.year<2020||p.year>2100||!Number.isInteger(p.month)||p.month<1||p.month>12)throw Error('เดือนหรือปีใน Shift Plan ไม่ถูกต้อง');if(dbMode&&!db().sections.some(s=>s.code===p.sectionCode))throw Error('ไม่มีสิทธิ์นำเข้าแผนก '+p.sectionCode+' หรือแผนกไม่ได้เปิดใช้งาน');plans.push(p);for(const emp of p.employees)gids.add(emp.gid);for(const issue of p.legendErrors||[]){const oneLine=v=>String(v).replace(/[\r\n\t]+/g,' ');legendIssues.push('ไฟล์: '+oneLine(f.name)+' | แถว: '+issue.row+' | คอลัมน์: '+issue.column+' | เซลล์: '+issue.cell+' | รหัส: '+oneLine(issue.code));}}
   if(legendIssues.length){const error=new Error(legendIssues.join('\n'));error.shiftLegendDetails=true;throw error;}
   const punches=[],leaves=[],sourceFiles=[...planFiles.map(f=>({type:'SHIFT_PLAN',name:f.name,size:f.size}))];let unmatched=0,skippedOtherLeave=0;
   for(const f of clockFiles){status('อ่าน All Today: '+f.name);const r=await window.AttendanceClock.readAuto(f,{gids:[],keepAllGIDs:true,maxPunches:50000});punches.push(...r.punches);unmatched+=r.unmatched.length;sourceFiles.push({type:'ALL_TODAY',name:f.name,size:f.size,counts:r.sourceCounts});}
   for(const f of leaveFiles){status('อ่าน Leave: '+f.name);const r=await window.AttendanceLeave.read(f,{gids:[...gids]});leaves.push(...r.rows);skippedOtherLeave+=r.skippedOther;sourceFiles.push({type:'LEAVE',name:f.name,size:f.size,skippedOther:r.skippedOther});}
   status('Matching ใน Web Worker — ไม่เรียก Database');result=await compute({plans,punches,leaves,clockProvided:clockFiles.length>0,leaveProvided:leaveFiles.length>0,sourceFiles});
   if(unmatched)result.warnings.push({code:'MISSING_GID',message:'มี '+unmatched+' Punch ไม่มี GID ไม่จับคู่โดยเดาชื่อ'});result.summary.unmatchedGID=unmatched;result.summary.skippedOtherLeave=skippedOtherLeave;result.summary.warningCount=result.warnings.length;
   for(const r of result.rows)apply(r);render();download();renderUploadPreview();showView('upload');
  }catch(error){invalidate();status(error.shiftLegendDetails?error.message:'หยุดประมวลผล: '+error.message);}finally{busy=false;for(const id of ['process','reset','plans','clock','leave'])$(id).disabled=false;}
 });
 window.AttendanceManual={hasEdits:()=>editorDirty||dbBusy||busy||approvalBusy||(!dbSource&&edits.size>0)};
 window.addEventListener('beforeunload',e=>{if(editorDirty||dbBusy||busy||approvalBusy||(!dbSource&&edits.size)){e.preventDefault();e.returnValue='';}});

 function basePayload(row){const section=db().sections.find(s=>s.code===row.section);if(!section)throw Error('ไม่พบสิทธิ์แผนก '+row.section);return {section_id:section.id,gid:row.gid,full_name:row.full_name,work_date:row.work_date,day_label:['Su','Mo','Tu','We','Th','Fr','Sa'][new Date(row.work_date+'T12:00:00Z').getUTCDay()],shift:row.shift,working_in:row.working_in,working_out:row.working_out,real_in:row.real_in,real_out:row.real_out,diff_hhmm:diff(row.real_in,row.real_out),time_clock_data:JSON.stringify(row.time_clock_data||[]),late_min:row.late_minutes,auto_xy:row.generated_xy||null,leave_units:row.leave_units,leave_type:row.leave_label,auto_remark:row.generated_remark||null,data_status:row.data_status,leave_source:row.leave_status,leave_half:row.leave_half};}
 function timestamp(v,date){if(!v)return null;if(/^\d{2}:\d{2}$/.test(v))return date+'T'+v+':00+07:00';return v;}
 function fromDB(a){if(a.xy_mapping_version!==2)throw Error('ต้องรัน SQL v0.6.17 ก่อนโหลดข้อมูล เพื่อให้ X/Y ใช้ความหมายเดียวกัน');let raw=[];try{raw=JSON.parse(a.time_clock_data||'[]');}catch{raw=(a.time_clock_data||'').split(/\s+/).filter(v=>/^\d{2}:\d{2}$/.test(v)).map(v=>timestamp(v,a.work_date));}const section=db().sections.find(s=>s.id===a.section_id);if(!section)throw Error('ข้อมูลแผนกไม่ตรงกับสิทธิ์');const row={db_id:a.id,section:section.code,gid:a.gid,full_name:a.full_name,work_date:a.work_date,shift:a.shift,working_in:timestamp(a.working_in,a.work_date),working_out:timestamp(a.working_out,a.work_date),real_in:timestamp(a.real_in,a.work_date),real_out:timestamp(a.real_out,a.work_date),time_clock_data:Array.isArray(raw)?raw:[],late_minutes:a.late_min,xy:a.auto_xy||'',remark:a.auto_remark||'',leave_units:a.leave_units,leave_label:a.leave_type,leave_status:a.leave_source,leave_half:a.leave_half,data_status:a.data_status};const e=Array.isArray(a.attendance_edits)?a.attendance_edits[0]:a.attendance_edits;const v={};if(e){for(const f of numeric)if(e[f]!=null)v[f]=Number(e[f]);for(const f of ['ot_refer','allowance_refer'])if(e[f]!=null)v[f]=e[f];if(e.time_overrides&&Object.keys(e.time_overrides).length)v.time_overrides=copyOverrides(e.time_overrides);if(e.time_change_reason)v.time_change_reason=e.time_change_reason;if(e.leave_overrides&&Object.keys(e.leave_overrides).length)v.leave_overrides=copyLeave(e.leave_overrides);if(e.leave_change_reason)v.leave_change_reason=e.leave_change_reason;if(e.manual_remark!=null)v.remark=e.manual_remark;if(e.manual_xy!=null)v.xy=e.manual_xy;}if(Object.keys(v).length)edits.set(key(row),v);apply(row);return row;}
 function plansFromAttendance(rows){const groups=new Map();for(const r of rows){const [year,month,day]=r.work_date.split('-').map(Number),k=r.section+'/'+year+'/'+month;let p=groups.get(k);if(!p){p={sectionCode:r.section,year,month,employees:[],people:new Map()};groups.set(k,p);}let e=p.people.get(r.gid);if(!e){e={gid:r.gid,name:r.full_name,days:Array(new Date(Date.UTC(year,month,0)).getUTCDate()).fill('')};p.people.set(r.gid,e);p.employees.push(e);}e.days[day-1]=r.shift||'';}return [...groups.values()].map(({people,...p})=>p);}
 let historyGeneration=0;
 const historyLabels={manual_shift:'Shift — Manual',manual_working_in:'Working In — Manual',manual_working_out:'Working Out — Manual',manual_real_in:'Actual In — Manual',manual_real_out:'Actual Out — Manual',time_change_reason:'เหตุผลกะ/เวลา',shift:'Shift',working_in:'Working In',working_out:'Working Out',real_in:'Actual In',real_out:'Actual Out',auto_xy:'X/Y — Matching',manual_xy:'X/Y — Manual',auto_remark:'Remark — Matching',manual_remark:'Remark — Manual',ot15:'OT1.5',ot20:'OT2.0',ot30:'OT3.0',total_ot:'Total OT',ot_refer:'OT Refer',meal:'Meal',stand_by:'Stand by',emergency:'Emergency',total_allowance:'Total Allowance',allowance_refer:'Allowance Refer'};
 function historyValue(v,f,source,workDate){if(v&&typeof v==='object'&&['matching','manual'].includes(v.mode)){const value=v.value;return(v.mode==='matching'?'Matching — ':'Manual — ')+(value==null||value===''?'เว้นว่าง':f==='manual_shift'?value:localInput(timestamp(value,workDate)).replace('T',' '));}if(v==null)return source==='attendance_edits'&&['manual_xy','manual_remark'].includes(f)?'NULL — ใช้ค่า Matching':'NULL — ไม่มีค่า';if(v==='')return 'ว่าง — empty string';return typeof v==='object'?JSON.stringify(v):String(v);}
 async function loadHistory(){
  const bridge=db();if(!bridge||bridge.profile.role!=='SUPER_ADMIN')return;
  const run=++historyGeneration,body=$('history-rows');body.replaceChildren();$('history-status').textContent='กำลังโหลดประวัติ…';
  try{
   const rows=await bridge.loadHistory($('history-month').value);if(run!==historyGeneration||db()!==bridge)return;
   let approvals=0,requests=0,centralEvents=0;
   for(const h of rows){
    const tr=document.createElement('tr'),stamp=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'medium'}).format(new Date(h.changed_at));
    const role={SUPER_ADMIN:'Central Admin','Central Admin':'Central Admin',DEPARTMENT_ADMIN:'TA',TA:'TA',MANAGER:'Manager',Manager:'Manager'}[h.actor_role]||h.actor_role||'System';const actor=role+' : '+(h.actor_username||((h.actor_name||'ไม่ทราบผู้ทำรายการ')+' [ไม่มี Username]'));let values;
    if(h.event_type==='central'){centralEvents++;values=[stamp,actor,'All Department','-','-','-','-','-','-',h.action==='request_pm'?'Request PM OT&Allowance':'Export Payroll TXT'];tr.title='เตรียมไฟล์/Request · ไม่ยืนยันการดาวน์โหลดหรือส่งเมล';}else if(h.event_type==='approval'){
     approvals++;values=[stamp,actor,h.section_code,'-','-','-','-','-','-','Approve OT&Allowance'];
    }else if(h.event_type==='request'){requests++;values=[stamp,actor,h.section_code,'-','-','-','-','-','-','Request OT&Allowance'];tr.title='เตรียม Request · '+h.period+' · '+h.row_count+' รายการ · OT '+h.total_ot+' · Allowance '+h.total_allowance+' · ไม่ยืนยันการส่งเมล';
    }else values=[stamp,actor,h.section_code,h.gid+' / '+h.full_name,date(h.work_date),h.source_table==='attendance'?'Matching / Reimport':'Manual edit',historyLabels[h.field_name]||h.field_name,historyValue(h.old_value,h.field_name,h.source_table,h.work_date),historyValue(h.new_value,h.field_name,h.source_table,h.work_date),h.change_reason||''];
    for(const v of values)td(tr,v);body.appendChild(tr);
   }
   $('history-status').textContent=(rows.length?'ประวัติ '+rows.length+' รายการ · แก้ไข '+(rows.length-approvals-requests-centralEvents)+' · อนุมัติ '+approvals+' · Request '+requests+' · Central '+centralEvents+' · เวลา Asia/Bangkok':'ไม่มีประวัติในเดือนที่เลือก')+(rows.approvalWarning?' · '+rows.approvalWarning:'')+(rows.requestWarning?' · '+rows.requestWarning:'')+(rows.centralWarning?' · '+rows.centralWarning:'')+(rows.usernameWarning?' · '+rows.usernameWarning:'');
  }catch(e){if(run===historyGeneration&&db()===bridge)$('history-status').textContent='โหลดประวัติไม่สำเร็จ: '+e.message+' · ตรวจ SQL History 04 และสิทธิ์อ่าน';}
 }
 $('history-month').addEventListener('change',loadHistory);
 function renderUploadPreview(){if(!result)return;const table=$('preview').closest('table').cloneNode(true);table.removeAttribute('id');for(const node of table.querySelectorAll('[id]'))node.removeAttribute('id');for(const tr of table.rows)if(tr.lastElementChild?.classList.contains('edit-cell'))tr.lastElementChild.remove();const previewWidths=[85, 160, 78, 32, 44, 48, 48, 48, 48, 65, 156, 44, 44, 44, 58, 44, 44, 44, 80, 48, 35, 35, 130, 340, 70, 135, 80, 65];table.querySelector('colgroup').replaceChildren(...previewWidths.map(w=>{const c=document.createElement('col');c.style.width=w+'px';return c;}));table.style.width=table.style.minWidth=previewWidths.reduce((a,b)=>a+b,0)+'px';const body=table.tBodies[0];body.replaceChildren();const source=$('preview');const savedPerson=$('person-filter').value,savedSection=$('section-filter').value,savedOT=otAllowanceOnly;otAllowanceOnly=false;$('person-filter').value='';$('section-filter').value='';renderTable();for(const row of source.rows){const copy=row.cloneNode(true);if(copy.lastElementChild?.classList.contains('edit-cell'))copy.lastElementChild.remove();body.appendChild(copy);}$('person-filter').value=savedPerson;$('section-filter').value=savedSection;otAllowanceOnly=savedOT;renderTable();$('upload-preview-wrap').replaceChildren(table);$('upload-preview-status').textContent=result.summary.period+' · '+result.rows.length+' แถว · '+(dbSource?'ข้อมูลโหลดกลับจาก Database':'Preview ในเครื่อง — ยังไม่บันทึก Database');$('upload-preview').hidden=false;}

 function approvalContext(){const section=db()?.sections.find(s=>s.code===allowedSection());return section&&dbSource&&loadedPeriod===$('db-period').value?{section,period:loadedPeriod,bridge:db()}:null;}
 function refreshApprovalButton(){refreshOTUpload();refreshRequestMail();const c=approvalContext();$('approve-ot').disabled=!c||db()?.profile.role!=='MANAGER'||dbBusy||busy||approvalBusy||approvalReadBusy||editorDirty||!approvalState?.snapshot?.rows?.length;}
 function clearApproval(){approvalRun++;approvalReadBusy=false;approvalState=null;approvalDraft=null;if($('approval-dialog').open&&!approvalBusy)$('approval-dialog').close();$('approval-status').textContent='';refreshApprovalButton();}
 function approvalStamp(v){return v.approved_name?' · '+v.approved_name+' · '+new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'medium'}).format(new Date(v.approved_at))+' Bangkok':'';}
 async function readApproval(){const run=++approvalRun,c=approvalContext();approvalState=null;if(!c){$('approval-status').textContent='เลือกแผนกเดียวและโหลดเดือนก่อนตรวจสถานะอนุมัติ';refreshApprovalButton();return;}approvalReadBusy=true;refreshApprovalButton();$('approval-status').textContent='กำลังตรวจสถานะอนุมัติ…';try{const v=await c.bridge.getApproval(c.section.id,c.period);if(run!==approvalRun||db()!==c.bridge)return;approvalState=v;$('approval-status').textContent=c.section.name+' / '+c.period+' · '+v.status+approvalStamp(v)+' · สถานะ ณ เวลาตรวจล่าสุด';}catch(e){if(run===approvalRun)$('approval-status').textContent='ตรวจสถานะไม่ได้: '+e.message+' · ตรวจการติดตั้ง SQL 07';}finally{if(run===approvalRun){approvalReadBusy=false;refreshApprovalButton();}}}
 function setApprovalBusy(value){approvalBusy=value;for(const id of ['db-period','section-filter','load-database','approval-confirm','approval-cancel'])$(id).disabled=value||id==='section-filter'&&db()?.profile.role==='DEPARTMENT_ADMIN';refreshApprovalButton();}
 $('approve-ot').addEventListener('click',async()=>{if($('approve-ot').disabled)return;const c=approvalContext(),run=++approvalRun;if(!c)return;setApprovalBusy(true);try{const v=await c.bridge.getApproval(c.section.id,c.period);if(run!==approvalRun||db()!==c.bridge)throw Error('บริบทหรือ Session เปลี่ยน กรุณาโหลดใหม่');const rows=v.snapshot.rows;if(!rows.length)throw Error('ไม่มี OT หรือ Allowance มากกว่า 0 ในแผนก/เดือนนี้');approvalState=v;approvalDraft={...c,snapshot:v.snapshot};const total=fs=>rows.reduce((n,r)=>n+fs.reduce((k,f)=>k+units(Number(r[f])||0),0),0)/100;$('approval-context').textContent=c.section.name+' / '+c.period+' · '+rows.length+' รายการ จาก '+v.snapshot.source_count+' แถวทั้งเดือน · Total OT '+total(['ot15','ot20','ot30'])+' ชม. · Total Allowance '+formatMoney(total(['meal','stand_by','emergency']));$('approval-rows').replaceChildren();for(const r of rows){const tr=document.createElement('tr');for(const f of ['gid','name','date','ot15','ot20','ot30','total_ot','meal','stand_by','emergency','total_allowance','remark'])td(tr,r[f]);$('approval-rows').appendChild(tr);}$('approval-message').textContent=v.status==='Approved'?'ชุดข้อมูลนี้อนุมัติแล้ว การกดยืนยันซ้ำจะไม่สร้างรายการซ้ำ':'เมื่อข้อมูลเปลี่ยน ระบบจะปฏิเสธการอนุมัติและให้ตรวจใหม่';$('approval-dialog').showModal();}catch(e){$('approval-status').textContent=e.message;}finally{setApprovalBusy(false);}});
 function cancelApproval(){if(approvalBusy)return;approvalDraft=null;$('approval-dialog').close();}
 $('approval-cancel').addEventListener('click',cancelApproval);$('approval-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelApproval();});
 $('approval-confirm').addEventListener('click',async()=>{const draft=approvalDraft,c=approvalContext();if(approvalBusy||!draft||!c)return;if(db()!==draft.bridge||c.section.id!==draft.section.id||c.period!==draft.period||db()?.profile.role!=='MANAGER'){cancelApproval();return;}setApprovalBusy(true);try{const v=await draft.bridge.approve(draft.section.id,draft.period,draft.snapshot);$('approval-dialog').close();approvalDraft=null;$('approval-status').textContent=draft.section.name+' / '+draft.period+' · '+v.status+approvalStamp(v)+' · อีเมลยังต้องตั้งค่า backend';}catch(e){$('approval-message').textContent='อนุมัติไม่สำเร็จ: '+e.message;approvalDraft=null;$('approval-confirm').hidden=true;}finally{setApprovalBusy(false);if(!approvalDraft&&$('approval-dialog').open)$('approval-confirm').disabled=true;}});
 $('approval-dialog').addEventListener('close',()=>{$('approval-confirm').hidden=false;refreshApprovalButton();});

 async function loadDatabase(){if(!db()||dbBusy||busy||approvalBusy||requestMailBusy||$('request-mail-dialog').open)return;if(editorDirty&&!confirm('ทิ้ง draft ที่ยังไม่บันทึกแล้วโหลดใหม่?'))return;dbBusy=true;loadingPeriod=$('db-period').value;clearApproval();$('db-period').disabled=true;$('load-database').disabled=true;closeEditor();try{const records=await db().load(loadingPeriod);loadedPeriod=loadingPeriod;edits.clear();const rows=records.map(fromDB);result={rows,plans:plansFromAttendance(rows),warnings:[],summary:{period:loadingPeriod,sections:[...new Set(rows.map(r=>r.section))],employees:new Set(rows.map(r=>r.gid)).size,records:rows.length,punches:rows.reduce((n,r)=>n+r.time_clock_data.length,0),leaves:rows.filter(r=>r.leave_units!=null).length,warningCount:0,source:'SUPABASE'}};dbSource=true;if(db().profile.role!=='MANAGER')$('person-filter').value='';render();$('section-filter').value=db().profile.role==='DEPARTMENT_ADMIN'?db().sections[0]?.code||'':db().profile.role==='MANAGER'?db().sections[0]?.code||'':'';populatePeople();renderShift();$('shift-context').textContent='Read only · กะรายวันจาก Attendance ที่ Central บันทึก ไม่ใช่ไฟล์ Shift Plan ต้นฉบับ';reviewSection=db().profile.role==='DEPARTMENT_ADMIN'?db().sections[0]?.code||null:null;renderTable();$('view-mode').textContent=db().profile.role+' · Database';$('edit-save').textContent='บันทึกเข้า Database';$('drawer-disclaimer').textContent='ข้อมูล Database · บันทึก Manual กะ/เวลา, OT/Allowance, Remark และ X/Y · เวลาปิ๊บบัตรต้นฉบับไม่เปลี่ยน';renderUploadPreview();$('status').textContent='โหลดข้อมูลกลับจาก Database แล้ว '+rows.length+' แถว';$('db-message').textContent=rows.length?'':'ยังไม่มีข้อมูล — ให้ Central Admin นำเข้าผ่าน Upload Data';showView('attendance');}catch(error){$('db-message').textContent='โหลดไม่สำเร็จ: '+error.message;}finally{dbBusy=false;loadingPeriod=null;$('db-period').disabled=false;$('load-database').disabled=false;refreshManual();readApproval();}}
 $('load-database').addEventListener('click',loadDatabase);
 $('save-database').addEventListener('click',async()=>{
  if(!db()||dbBusy||busy||!result||dbSource)return;
  if(!confirm('บันทึกผล Matching '+[...new Set(result.rows.map(r=>r.section))].join(', ')+' / '+result.summary.period+' '+result.rows.length+' แถวเข้า Database? นำเข้าซ้ำจะอัปเดต Matching แต่ไม่ทับ Manual edits'))return;
  dbBusy=true;refreshManual();
  const uploadControls=['process','reset','plans','clock','leave'];
  for(const id of uploadControls)$(id).disabled=true;
  try{
   const payload=result.rows.map(basePayload);
   await db().importRows(payload);
   // Clear only the department-specific files after the server confirms success.
   // All Today stays selected in this same iframe for the next department.
   for(const id of ['plans','leave']){$(id).value='';$(id+'-list').textContent='ไม่ได้เลือกไฟล์';}
   edits.clear();invalidate();
   const message='Completed upload — บันทึก Matching สำเร็จ '+payload.length+' แถว';
   $('db-message').textContent=message;
   status(message+' · เลือก Shift Plan / Leave Record ของแผนกถัดไปได้เลย · เก็บ All Today ไว้แล้ว');
   showView('upload');
   alert('Completed upload');
  }catch(error){$('db-message').textContent='บันทึกไม่สำเร็จ: '+error.message;status('บันทึกไม่สำเร็จ: '+error.message);}
  finally{dbBusy=false;for(const id of uploadControls)$(id).disabled=false;refreshManual();}
 });
 // Request prepares an audited mailto link. It does not send mail or use worker queues.
 let requestMailBusy=false,requestMailDraft=null;
 function requestMailAllowed(){return dbMode&&dbSource&&db()?.profile.role==='DEPARTMENT_ADMIN'&&approvalContext()&&!dbBusy&&!busy&&!approvalBusy&&!approvalReadBusy&&!editorDirty&&!otUploadBusy&&!$('ot-upload-dialog').open;}
 function refreshRequestMail(){const b=$('request-ot');b.hidden=db()?.profile.role!=='DEPARTMENT_ADMIN';b.disabled=!requestMailAllowed()||requestMailBusy||$('request-mail-dialog').open||!approvalState?.snapshot?.rows?.length;}
 function requestAppLink(){const u=new URL(window.parent.location.href);if(!['https:','http:'].includes(u.protocol))throw Error('เปิดแอปผ่านเว็บก่อน Request');u.search='';u.hash='';return u.href;}
 function buildRequestMail(v,appLink){
  const [y,m]=v.period.split('-').map(Number),month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]+'-'+String(y).slice(-2);
  const dept=({'PSD_PID':'PSD/PID','PSY_GRS':'PSY/GRS','TRW_TRD':'TRW/TRD'})[v.section_code]||v.section_code;
  const subject='[Request Approval] '+dept+' OT&Allowance '+month;
  const amount=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const body=['Dear Section Manager,','','Please approve OT&Allowance '+month+' for '+dept+', as summarized below.','',
   'Total OT: '+amount(v.total_ot)+' hours','Total Allowance: '+amount(v.total_allowance),'',
   'Approve OT&Allowance',appLink,'',
   'Best regards,','Team Assistance'].join('\r\n');
  const href='mailto:?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);
  if(href.length>1800)throw Error('ลิงก์อีเมลยาวเกินไป กรุณาใช้ URL แอปที่สั้นลง');
  return {subject,body,href};
 }
 async function prepareRequestMail(){
  const d=requestMailDraft,c=approvalContext();if(!d||requestMailBusy||!c)return;
  if(db()!==d.context.bridge||c.section.id!==d.context.section.id||c.period!==d.context.period){$('request-mail-status').textContent='Session/แผนก/เดือนเปลี่ยน กรุณาปิดและโหลดใหม่';return;}
  requestMailBusy=true;$('request-mail-close').disabled=true;$('request-mail-retry').hidden=true;refreshApprovalButton();
  $('request-mail-status').textContent='กำลังเตรียม Request และบันทึก History…';
  try{
   if(!d.snapshot){const v=await c.bridge.getApproval(c.section.id,c.period);if(!v.snapshot?.rows?.length)throw Error('OT_MAILTO_INVALID: ไม่มี OT/Allowance มากกว่า 0');d.snapshot=v.snapshot;}
   const v=await c.bridge.prepareRequestMail(c.section.id,c.period,d.snapshot,d.id);
   const now=approvalContext();if(db()!==d.context.bridge||!now||now.section.id!==d.context.section.id||now.period!==d.context.period)throw Error('บริบทเปลี่ยน กรุณาปิดและตรวจ History');
   const mail=buildRequestMail(v,d.appLink);d.mail=mail;
   $('request-mail-subject').value=mail.subject;$('request-mail-body').value=mail.body;
   $('request-mail-open').href=mail.href;$('request-mail-open').hidden=false;$('request-mail-copy').disabled=false;
   $('request-mail-status').textContent='เตรียม Request และบันทึก History แล้ว · '+v.row_count+' รายการ · กดเปิดเมลด้านล่าง · ยังไม่ได้ส่งอีเมล';
  }catch(e){$('request-mail-status').textContent='เตรียม Request ไม่สำเร็จ: '+e.message;const known=/OT_MAILTO_(CHANGED|INVALID|FORBIDDEN)/.test(e.message);$('request-mail-retry').hidden=known;}
  finally{requestMailBusy=false;$('request-mail-close').disabled=false;refreshApprovalButton();}
 }
 $('request-ot').addEventListener('click',async()=>{
  if($('request-ot').disabled||!requestMailAllowed())return;const c=approvalContext();
  requestMailDraft={context:c,id:crypto.randomUUID(),snapshot:null,appLink:requestAppLink(),mail:null};
  $('request-mail-context').textContent=c.section.name+' / '+c.period+' · ทั้งแผนก/เดือน ไม่จำกัด Person';
  $('request-mail-subject').value='';$('request-mail-body').value='';$('request-mail-open').hidden=true;$('request-mail-open').removeAttribute('href');$('request-mail-copy').disabled=true;$('request-mail-retry').hidden=true;
  $('request-mail-dialog').showModal();await prepareRequestMail();
 });
 $('request-mail-retry').addEventListener('click',prepareRequestMail);
 $('request-mail-open').addEventListener('click',()=>{$('request-mail-status').textContent='เรียกโปรแกรมเมลเริ่มต้นแล้ว · ใส่ To / CC และแนบไฟล์ก่อนส่ง · หากไม่เปิด ให้ตั้ง Outlook เป็นโปรแกรมเมลเริ่มต้น หรือคัดลอกข้อความ';});
 $('request-mail-copy').addEventListener('click',async()=>{if(!requestMailDraft?.mail)return;try{const m=requestMailDraft.mail;await navigator.clipboard.writeText('Subject: '+m.subject+'\r\n\r\n'+m.body);$('request-mail-status').textContent='คัดลอกหัวข้อและข้อความแล้ว · วางใน Outlook ได้';}catch{$('request-mail-body').focus();$('request-mail-body').select();$('request-mail-status').textContent='กรุณาคัดลอกข้อความที่เลือกด้วย Ctrl+C';}});
 $('request-mail-close').addEventListener('click',()=>{if(!requestMailBusy)$('request-mail-dialog').close();});
 $('request-mail-dialog').addEventListener('cancel',e=>{if(requestMailBusy)e.preventDefault();});
 $('request-mail-dialog').addEventListener('close',()=>{requestMailDraft=null;refreshApprovalButton();});
 window.AttendanceRequestMailTest={build:buildRequestMail};

  // TA Excel import: independent of Person and OT-only filters.
 let otUploadDraft=null,otUploadBusy=false,otUploadUncertain=false;
 function otUploadAllowed(){return !requestMailBusy&&!$('request-mail-dialog').open&&dbMode&&dbSource&&db()?.profile.role==='DEPARTMENT_ADMIN'&&approvalContext()&&!dbBusy&&!busy&&!approvalBusy&&!editorDirty;}
 function refreshOTUpload(){const b=$('upload-ot');b.hidden=db()?.profile.role!=='DEPARTMENT_ADMIN';b.disabled=!otUploadAllowed()||otUploadBusy;}
 function otDate(value){
  const text=String(value).trim();let y,m,d,match;
  if(/^\d+(?:\.0+)?$/.test(text)){const serial=Number(text);if(serial<61||serial>2958465||!Number.isInteger(serial))throw Error('Excel Date ไม่ถูกต้อง');return new Date(Date.UTC(1899,11,30)+serial*86400000).toISOString().slice(0,10);}
  if((match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text))){[,y,m,d]=match;}
  else if((match=/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(text))){d=match[1];m=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase())+1;y=match[3].length===2?2000+Number(match[3]):Number(match[3]);}
  else if((match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))){[,d,m,y]=match;}
  else throw Error('Date ใช้วันที่ Excel, YYYY-MM-DD, D-Mmm-YY หรือ DD/MM/YYYY');
  y=Number(y);m=Number(m);d=Number(d);const date=new Date(Date.UTC(y,m-1,d));
  if(y<2020||y>2100||m<1||m>12||d<1||date.getUTCFullYear()!==y||date.getUTCMonth()+1!==m||date.getUTCDate()!==d)throw Error('วันที่ไม่มีจริง');
  return date.toISOString().slice(0,10);
 }
 const otName=s=>String(s||'').normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g,' ');
 async function otParse(file,section,period,rows){
  const {get,cells,date1904}=await window.AttendanceXlsx.readWorksheet(file,null,false);
  if(date1904)throw Error('ไม่รองรับ Excel date system 1904 กรุณาใช้ Template ที่ให้');
  const headers=['GID','Name','Date','OT1.5','OT2.0','OT3.0','Total OT','Meal','Stand by','Emergency','Total Allowance'];
  headers.forEach((h,i)=>{if(get(String.fromCharCode(65+i)+'1')!==h)throw Error('หัวคอลัมน์ไม่ตรง Template: '+h);});
  const hasRemark=get('L1')==='Remark';if(get('L1')&&!hasRemark)throw Error('หัวคอลัมน์ L ต้องเป็น Remark');
  const sheetRows=[...new Set([...cells.keys()].map(a=>Number(a.match(/\d+$/)[0])))].filter(n=>n>1).sort((a,b)=>a-b);
  const populated=sheetRows.filter(n=>['A','B','C','D','E','F','H','I','J','L'].some(c=>{const v=cells.get(c+n);return v&&(v.value!==''||v.formula);}));
  if(!populated.length||populated.length>3100)throw Error('ต้องมีข้อมูล 1–3,100 แถวต่อไฟล์');
  const map=new Map(rows.filter(r=>r.section===section.code&&r.work_date.slice(0,7)===period).map(r=>[r.gid.toUpperCase()+'|'+r.work_date,r]));
  const seen=new Set(),errors=[],preview=[],payload=[];
  for(const line of populated){try{
    const gid=get('A'+line).trim().toUpperCase(),name=get('B'+line),date=otDate(get('C'+line)),identity=gid+'|'+date;
    if(!gid||!name)throw Error('ต้องมี GID และ Name');
    if(date.slice(0,7)!==period)throw Error('วันที่ไม่ตรงเดือน '+period);
    if(seen.has(identity))throw Error('GID + Date ซ้ำในไฟล์');seen.add(identity);
    const row=map.get(identity);if(!row)throw Error('ไม่พบ GID/วันที่ใน Attendance ของ '+section.name);
    if(otName(name)!==otName(row.full_name))throw Error('Name ไม่ตรงกับ GID ใน Attendance กรุณาตรวจชื่อ');
    apply(row);const values={},expected={};
    for(const f of numeric)expected[f]=row[f]??null;
    for(const [column,f] of [['D','ot15'],['E','ot20'],['F','ot30'],['H','meal'],['I','stand_by'],['J','emergency']]){const value=get(column+line).trim();if(value!=='')values[f]=parseNumber(value,money.has(f));}
    const remark=hasRemark?get('L'+line).trim():'';const expectedRemark=row.remark||'';
    if(remark){if(remark.length>1000||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(remark))throw Error('Remark ไม่ถูกต้อง');values.remark=remark;}
    const finalRemark=remark?(expectedRemark.trim()?expectedRemark+', '+remark:remark):expectedRemark;
    if(remark&&finalRemark.length>1000)throw Error('Remark เดิมรวมข้อความใหม่เกิน 1,000 ตัวอักษร');
    const next={...expected,...values};const changed=numeric.some(f=>next[f]!==expected[f])||!!remark;
    preview.push({line,gid:row.gid,name:row.full_name,date,expected,next,values,finalRemark,changed,blank:!Object.keys(values).length});
    if(Object.keys(values).length){const item={id:row.db_id,gid:row.gid,date,values,expected};if(remark)item.expected_remark=expectedRemark;payload.push(item);}
   }catch(e){errors.push('แถว '+line+': '+e.message);}}
  return {errors,preview,payload};
 }
 window.AttendanceOTUploadTest={parse:otParse,date:otDate};
 function otRenderPreview(parsed){
  const body=$('ot-upload-rows');body.replaceChildren();
  const text=v=>v==null?'':String(v);
  // Preview shows supplied input only; omitted cells still preserve stored values.
  const inputTotal=(values,fields)=>fields.some(f=>Object.hasOwn(values,f))?text(sum(values,fields)):'';
  for(const r of parsed.preview){const tr=document.createElement('tr');for(const v of [r.line,r.gid,r.name,date(r.date),...numeric.map(f=>text(r.values[f])),inputTotal(r.values,numeric.slice(0,3)),inputTotal(r.values,numeric.slice(3)),text(r.values.remark)])td(tr,v);body.appendChild(tr);}
  const errors=$('ot-upload-errors');errors.replaceChildren();for(const error of parsed.errors){const li=document.createElement('li');li.textContent=error;errors.appendChild(li);}
  const count=parsed.preview.filter(r=>r.changed).length;
  $('ot-upload-message').textContent='อ่านได้ '+parsed.preview.length+' แถว · เปลี่ยนค่า '+count+' แถว · ผิดพลาด '+parsed.errors.length+' แถว'+(!count?' · ไม่มีข้อมูลใหม่ให้บันทึก':'');
  $('ot-upload-confirm').disabled=!!parsed.errors.length||!count;
 }
 function otSetBusy(value){otUploadBusy=value;for(const id of ['ot-upload-file','ot-upload-preview','ot-upload-confirm','ot-upload-cancel'])$(id).disabled=value;refreshOTUpload();}
 $('upload-ot').addEventListener('click',()=>{if(!otUploadAllowed())return;otUploadDraft=null;otUploadUncertain=false;$('ot-upload-file').value='';$('ot-upload-rows').replaceChildren();$('ot-upload-errors').replaceChildren();$('ot-upload-message').textContent='เลือก Excel แล้วกดตรวจสอบ Preview';$('ot-upload-confirm').textContent='ยืนยันบันทึกทั้งชุด';$('ot-upload-confirm').disabled=true;const c=approvalContext();$('ot-upload-context').textContent=c.section.name+' / '+c.period+' · นำเข้าตามไฟล์ ไม่จำกัด Person';$('ot-upload-dialog').showModal();});
 $('ot-upload-file').addEventListener('change',()=>{otUploadDraft=null;otUploadUncertain=false;$('ot-upload-confirm').disabled=true;$('ot-upload-rows').replaceChildren();$('ot-upload-errors').replaceChildren();});
 $('ot-upload-preview').addEventListener('click',async()=>{
  if(!otUploadAllowed()||otUploadBusy)return;const file=$('ot-upload-file').files[0],c=approvalContext();if(!file){$('ot-upload-message').textContent='กรุณาเลือกไฟล์ .xlsx';return;}
  otUploadDraft=null;otUploadUncertain=false;otSetBusy(true);$('ot-upload-message').textContent='กำลังอ่านและตรวจสอบ Excel…';
  try{const parsed=await otParse(file,c.section,c.period,result.rows);if(db()!==c.bridge||!otUploadAllowed())throw Error('Session/เดือน/สิทธิ์เปลี่ยน กรุณาโหลดใหม่');otUploadDraft={...parsed,context:c,filename:file.name,batch:crypto.randomUUID(),actor:c.bridge.profile.id};otRenderPreview(parsed);}
  catch(e){$('ot-upload-message').textContent='ตรวจสอบไม่สำเร็จ: '+e.message;}
  finally{otSetBusy(false);$('ot-upload-confirm').disabled=!otUploadDraft||!!otUploadDraft.errors.length||!otUploadDraft.preview.some(r=>r.changed);}
 });
 $('ot-upload-confirm').addEventListener('click',async()=>{
  const draft=otUploadDraft;if(!draft||otUploadBusy||draft.errors.length||!otUploadAllowed())return;
  const c=approvalContext();if(c.section.id!==draft.context.section.id||c.period!==draft.context.period||db()!==draft.context.bridge){$('ot-upload-message').textContent='Session/เดือน/แผนกเปลี่ยน กรุณาตรวจ Preview ใหม่';$('ot-upload-confirm').disabled=true;return;}
  otSetBusy(true);let saved=false;
  try{const response=await c.bridge.uploadOT(draft.batch,c.section.id,c.period,draft.filename,draft.payload);saved=true;otUploadUncertain=false;otUploadDraft=null;$('ot-upload-dialog').close();otUploadBusy=false;await loadDatabase();$('db-message').textContent='Upload OT&Allowance บันทึกสำเร็จ '+response.changed_rows+' แถว · Batch '+response.batch_id+' · ตรวจสถานะอนุมัติล่าสุด';}
  catch(e){otUploadUncertain=!/OT_UPLOAD_(CHANGED|INVALID|FORBIDDEN)/.test(e.message);$('ot-upload-message').textContent=otUploadUncertain?'ยังยืนยันผลไม่ได้ ให้โหลดตรวจข้อมูลก่อน หรือกดยืนยัน Batch เดิมอีกครั้ง ระบบป้องกันบันทึกซ้ำ · '+e.message:'ไม่บันทึกทั้งชุด: '+e.message+' · โหลดข้อมูลและตรวจ Preview ใหม่';$('ot-upload-confirm').textContent=otUploadUncertain?'ตรวจผล / ยืนยัน Batch เดิม':'ยืนยันบันทึกทั้งชุด';}
  finally{otSetBusy(false);$('ot-upload-confirm').disabled=saved||!otUploadUncertain;}
 });
 $('ot-upload-cancel').addEventListener('click',()=>{if(otUploadBusy)return;if(otUploadUncertain&&!confirm('ยังยืนยันผลไม่ได้ ต้องตรวจข้อมูลหลังปิด ห้ามอัปโหลดไฟล์ใหม่จนตรวจผลเดิม ต้องการปิด?'))return;$('ot-upload-dialog').close();});
 $('ot-upload-dialog').addEventListener('cancel',e=>{if(otUploadBusy||otUploadUncertain)e.preventDefault();});
 $('ot-upload-dialog').addEventListener('close',()=>{otUploadDraft=null;refreshOTUpload();});

 function waitForDatabase(){
  edits.clear();invalidate();populatePeople();$('person-filter').value='';
  $('summary').textContent='ยังไม่ได้โหลดข้อมูลจาก Database';
  $('db-message').textContent='เลือกเดือนแล้วกด โหลดจาก Database';
  renderTable();$('manual-status').textContent='ยังไม่ได้โหลดข้อมูล · กด โหลดจาก Database ก่อน';
 }
 function currentMonth(){const now=new Date();return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric'}).format(now)+'-'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',month:'2-digit'}).format(now);}
 $('db-period').value=currentMonth();$('central-month').value=currentMonth();$('history-month').value=currentMonth();
 if(db()){dbMode=true;const dept=db().profile.role==='DEPARTMENT_ADMIN',manager=db().profile.role==='MANAGER';$('db-panel').hidden=false;document.querySelector('#view-attendance .page-heading .subtle').textContent='โหลดข้อมูลรายเดือนตามสิทธิ์ · Manager อนุมัติ OT/Allowance รายแผนก';document.querySelector('.side-help').innerHTML='Excel-first · Supabase<br>ไฟล์ประมวลผลใน Browser';$('who').textContent=db().profile.display_name;$('role').textContent=db().profile.role;$('role').nextElementSibling.textContent=dept?'TA · แก้ไข / Upload OT&Allowance ตามสิทธิ์แผนก':manager?'Manager · ตรวจและอนุมัติ OT/Allowance ตามสิทธิ์แผนก':'Central Admin · นำเข้าทุกแผนกที่ Active · ทุกเดือน';document.querySelector('.version').textContent='v0.6.13 · Central OT&Allowance';document.querySelector('.review-banner').hidden=true;$('nav-upload').hidden=dept||manager;$('nav-shift').hidden=false;$('nav-history').hidden=dept||manager;$('nav-central-ot').hidden=dept||manager;$('admin-nav-group').hidden=dept||manager;$('department-field').hidden=dept;$('section-filter').disabled=dept;document.querySelector('#view-upload .notice').textContent='คำนวณไฟล์ใน Browser; กดบันทึกเพื่อส่งเฉพาะผล Matching เข้า Supabase · ไม่ทับ Manual edits';$('save-database').textContent='บันทึก Matching เข้า Database';const sections=$('section-filter');sections.replaceChildren();for(const code of (dept?db().sections.map(s=>s.code):['',...db().sections.map(s=>s.code)])){const o=new Option(db().sections.find(s=>s.code===code)?.name||code||'All Department',code);sections.appendChild(o);}sections.value=dept?db().sections[0]?.code||'':'';populatePeople();$('person-filter').value='';showView('attendance');if(manager)loadDatabase();else waitForDatabase();}

 setInterval(()=>{if(dbSource&&!requestMailBusy&&!$('request-mail-dialog').open&&!otUploadBusy&&!$('ot-upload-dialog').open&&!document.hidden&&!dbBusy&&!busy&&!approvalBusy&&!approvalReadBusy&&!editorDirty&&!$('approval-dialog').open)readApproval();},30000);
 renderTable();
})();
