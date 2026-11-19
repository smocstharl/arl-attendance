# ARL Time Attendance and OT Allowance

ระบบบันทึกเวลาการทำงาน และ OT/Allowance สำหรับ ARL

## โครงสร้าง
- `supabase/migrations/` ไฟล์ SQL ตามลำดับ (schema, RLS, grants, patch)
- `tests/` กรณีทดสอบ
- `docs/` คู่มือการตั้งค่า

## ข้อควรระวัง
- repo นี้เป็น **Private** ห้าม commit service_role key, รหัสผ่าน หรือ `.env`
- ข้อมูลพนักงานจริงห้ามอยู่ใน repo
- ข้อมูลทดสอบต้องแยกจาก production
