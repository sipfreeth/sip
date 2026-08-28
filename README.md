# QR Tracker — ระบบ redirect + log สำหรับแคมเปญโฆษณา

## สิ่งที่ระบบนี้ทำ
คนสแกน QR → เข้า `your-project.vercel.app/api/qr/creativeA` → ระบบบันทึกว่า
ใครสแกน creative ไหน เมื่อไหร่ → แล้ว redirect ไปหน้าโปรโมชั่นจริงทันที

## ขั้นตอนติดตั้ง (ทำครั้งเดียว)

### 1. สร้างฐานข้อมูลบน Supabase (ฟรี)
1. ไปที่ supabase.com → สมัคร/ล็อกอิน → New Project
2. เข้า SQL Editor แล้วรันคำสั่งนี้เพื่อสร้างตาราง:

```sql
create table scan_logs (
  id bigint generated always as identity primary key,
  creative_id text not null,
  screen_id text,
  scanned_at timestamptz not null
);
```

3. ไปที่ Project Settings > API เก็บค่า 2 อันนี้ไว้:
   - `Project URL` → ใช้เป็น `SUPABASE_URL`
   - `service_role` key (ไม่ใช่ anon key) → ใช้เป็น `SUPABASE_SERVICE_KEY`

### 2. แก้ปลายทางลิงก์ในโค้ด
เปิดไฟล์ `api/qr/[creative].js` แล้วแก้ URL ใน `DESTINATIONS` ให้เป็นหน้าโปรโมชั่นจริงของลูกค้า

### 3. อัปโค้ดขึ้น GitHub
```bash
cd qr-tracker
git init
git add .
git commit -m "init qr tracker"
git remote add origin <URL ของ repo ที่สร้างใน GitHub>
git push -u origin main
```
(สร้าง repo เปล่าใน GitHub ก่อนจากหน้า github.com/new)

### 4. Deploy บน Vercel
1. เข้า vercel.com → New Project → Continue with GitHub → เลือก repo `qr-tracker`
2. ก่อนกด Deploy ให้เปิดส่วน **Environment Variables** แล้วใส่:
   - `SUPABASE_URL` = ค่าที่เก็บไว้จากขั้นตอน 1
   - `SUPABASE_SERVICE_KEY` = ค่าที่เก็บไว้จากขั้นตอน 1
3. กด Deploy รอประมาณ 1 นาที

### 5. ทดสอบ
- เปิด `https://your-project.vercel.app/api/qr/creativeA` ในเบราว์เซอร์
- ควรเด้งไปหน้าโปรโมชั่นทันที
- กลับไปดูใน Supabase > Table Editor > scan_logs ควรมีแถวใหม่ขึ้นมา

### 6. สร้าง QR code จริง
เอา URL แต่ละ creative (เช่น `.../api/qr/creativeA?screen=LOBBY-A-01`) ไปสร้าง QR
ที่เว็บฟรีอย่าง qr-code-generator.com — พารามิเตอร์ `screen` ใส่หรือไม่ใส่ก็ได้
ถ้าอยากรู้ว่าสแกนมาจากจอไหน

## ระบบสมาชิก + สะสมแต้ม (ล็อกอินด้วย LINE)

### 1. สร้างตารางสมาชิกและแต้ม
เปิด `schema-members.sql` ในโปรเจกต์นี้ → คัดลอกทั้งหมด → รันใน Supabase SQL Editor

### 2. สร้าง LINE Login Channel
1. เข้า developers.line.biz → สมัคร/ล็อกอิน
2. สร้าง **Provider** ใหม่ (ถ้ายังไม่มี) → ตั้งชื่ออะไรก็ได้
3. ในนั้นกด **Create a new channel** → เลือก **LINE Login**
4. กรอกข้อมูลพื้นฐาน (ชื่อแอป, หมวดหมู่, คำอธิบาย) → สร้าง
5. เข้าไปในช่อง **Basic settings** จะเห็น **Channel ID** และ **Channel secret** → เก็บไว้
6. ไปที่แท็บ **LINE Login** ในช่องเดียวกัน → ใส่ **Callback URL** เป็น:
   ```
   https://your-project.vercel.app/api/auth/callback
   ```
   (เปลี่ยน `your-project` เป็นโดเมนจริงของคุณ)

### 3. ใส่ Environment Variables เพิ่มใน Vercel
นอกจาก `SUPABASE_URL` กับ `SUPABASE_SERVICE_KEY` เดิม ให้เพิ่มอีก 3 ตัว:
- `LINE_CHANNEL_ID` = Channel ID จากขั้นตอน 2
- `LINE_CHANNEL_SECRET` = Channel secret จากขั้นตอน 2
- `LINE_CALLBACK_URL` = URL เดียวกับที่ใส่ใน LINE Console ขั้นตอน 2.6

ใส่เสร็จแล้ว Redeploy

### 4. ทดสอบ
เปิดลิงก์ QR เดิม (เช่น `/api/qr/brandA-video`) → ควรเด้งไปหน้า LINE ให้กดยินยอมล็อกอิน →
กดยินยอม → ควรเด้งกลับไปหน้าโปรโมชั่นจริง

เช็คใน Supabase Table Editor:
- ตาราง **members** — ควรมีแถวใหม่ (หรือสมาชิกเดิมถ้าเคยสแกนมาก่อน)
- ตาราง **points_ledger** — ควรมีแถวบันทึกว่าได้แต้มกี่แต้มจาก creative ไหน

### ปรับแต่งได้
- จำนวนแต้มต่อการสแกน 1 ครั้ง แก้ที่ตัวแปร `POINTS_PER_SCAN` ในไฟล์ `api/auth/callback.js`
- อยากให้แต้มไม่เท่ากันในแต่ละ creative (เช่น สแกนจากจอ VIP ได้แต้มเยอะกว่า) แจ้งได้ ปรับโค้ดเพิ่มได้

## Admin Dashboard

### 1. ตั้งรหัสผ่านสำหรับเข้า Dashboard
เพิ่ม Environment Variable ใหม่ใน Vercel:
- `ADMIN_PASSWORD` = ตั้งรหัสผ่านอะไรก็ได้ (ยิ่งยากยิ่งดี เพราะหน้านี้เห็นข้อมูลสมาชิกทั้งหมด)

### 2. เข้าใช้งาน
เปิด:
```
https://your-project.vercel.app/api/admin/dashboard
```
เบราว์เซอร์จะเด้ง popup ให้กรอก username (ใส่อะไรก็ได้) และ password (ใส่ค่า `ADMIN_PASSWORD` ที่ตั้งไว้)

### สิ่งที่เห็นในหน้านี้
- ยอดสแกนทั้งหมด / วันนี้
- จำนวนสมาชิกแยกตาม Tier
- ยอดสแกนแยกตาม Creative (ดูว่าตัวไหนปังสุด)
- ประวัติการแลกของรางวัล พร้อมปุ่ม **"ยืนยันใช้แล้ว"** กดเปลี่ยนสถานะจาก pending เป็น used ได้ในหน้าเดียว (แทนที่จะต้องเข้า Supabase มือ)

## อัปเกรด: แยก Tier Score กับ Point (ทำครั้งเดียว ถ้าเคยติดตั้งระบบแต้มเดิมไปแล้ว)

ระบบใหม่แยก 2 อย่างออกจากกันชัดเจน:
- **Tier Score** — ได้จาก engagement (1 ครั้ง = 1 คะแนน) ใช้ตัดสิน Tier เท่านั้น ไม่มีวันถูกใช้หมด
  Tier ของปีนี้ทั้งปีถูกล็อกจากยอด Tier Score ของปีที่แล้วทั้งปี (สมาชิกใหม่ปีนี้ใช้ยอดสะสมปัจจุบันไปพลางก่อน)
- **Point** — ได้จาก engagement เดียวกัน (1 ครั้ง = 5 แต้ม ปรับได้ที่ `REWARD_POINTS_PER_ENGAGEMENT` ในไฟล์ `api/auth/callback.js`)
  ใช้แลก Reward เท่านั้น หมดอายุทุกสิ้นปีถ้าไม่ใช้
- ทั้งสองอย่างได้จาก 1 Campaign (creative) แค่ครั้งเดียว ห้ามซ้ำ (กติกาเดิมที่มีอยู่แล้ว)

### วิธีอัปเกรด
1. รัน `migration-split-tier-and-points.sql` ใน Supabase SQL Editor
2. แทนที่ไฟล์ `lib/tiers.js`, `api/auth/callback.js`, `api/admin/dashboard.js` ด้วยเวอร์ชันใหม่
3. Redeploy

### ปรับ Tier ได้ที่ `lib/tiers.js`
```js
export const TIERS = [
  { name: 'Explorer', min: 0, color: '#9ca3af' },
  { name: 'Insider', min: 100, color: '#2a78d6' },
  { name: 'Ambassador', min: 200, color: '#d4a017' },
  { name: 'Legend', min: 400, color: '#8b5cf6' },
];
```

## Admin Panel รวม (Dashboard / Members / Rewards / Campaigns) + Login

ตั้งแต่เวอร์ชันนี้ Admin Panel รวมทุกฟังก์ชันไว้หน้าเดียว สลับด้วยแท็บเมนู และมีระบบ Login/Logout จริง
รองรับแอดมิน/เจ้าหน้าที่หลายคน (แยกบัญชีกัน) แทนที่ระบบรหัสผ่านเดียว (Basic Auth) แบบเดิม

### 1. รัน Migration สร้างตาราง admin_users
รัน `migration-admin-login.sql` ใน Supabase SQL Editor — **แก้รหัสผ่านใน SQL ก่อนรัน** อย่าใช้ค่าตัวอย่าง

### 2. เพิ่ม Environment Variable ใหม่ใน Vercel
- `ADMIN_SECRET` = ตั้งข้อความสุ่มยาวๆ อะไรก็ได้ (ใช้เซ็นรับรอง session ไม่ใช่รหัสผ่านที่ต้องจำ) เช่น `openssl rand -hex 32` หรือพิมพ์มั่วๆ ยาวๆ ก็ได้
- (ลบ `ADMIN_PASSWORD` เดิมทิ้งได้ ไม่ใช้แล้ว ระบบเปลี่ยนไปใช้ตาราง `admin_users` แทน)

### 3. เข้าใช้งาน
```
https://your-project.vercel.app/api/admin/login
```
ล็อกอินด้วย username/password ที่ตั้งไว้ตอนรัน SQL ในขั้นที่ 1

### หน้าเมนูที่มี
- **Dashboard** — สรุปยอดสแกน, รอยืนยัน Redemption พร้อมปุ่มกดยืนยัน
- **Members** — รายชื่อสมาชิกทั้งหมด กดฟิลเตอร์ดูตาม Tier ได้
- **Rewards** — เพิ่ม/แก้ชื่อและ Point ที่ต้องใช้/เปิดปิดของรางวัล ได้จากหน้าเว็บเลย (ไม่ต้องเข้า Supabase อีกแล้ว)
- **Campaigns** — เพิ่ม/แก้ URL ปลายทางของแต่ละ Campaign (creative) ได้จากหน้าเว็บเลย

### เพิ่มเจ้าหน้าที่คนใหม่
รัน SQL นี้ใน Supabase (เปลี่ยน username/รหัสผ่านตามจริง):
```sql
insert into admin_users (username, password_hash)
values ('ชื่อเจ้าหน้าที่', crypt('รหัสผ่านของเจ้าหน้าที่คนนี้', gen_salt('bf')));
```

## อัปเดตใหญ่: Role, CRUD เต็มรูปแบบ, ประวัติสมาชิก, Dashboard + กราฟ + Filter

### 1. รัน Migration
รัน `migration-roles-and-crud.sql` ใน Supabase SQL Editor — **แก้ `username = 'admin'` ในบรรทัด update ให้ตรงกับบัญชีของคุณก่อนรัน**

### 2. Role ที่มี
| Role | ทำได้ |
|---|---|
| **super_admin** | ทุกอย่าง รวมถึงจัดการบัญชีแอดมิน (แท็บ Admins) |
| **admin** | เหมือน super_admin ทุกอย่าง **ยกเว้น** จัดการบัญชีแอดมิน (สร้าง/แก้/ลบ/เปลี่ยน role คนอื่นไม่ได้) |
| **staff** | สร้าง Campaign/Reward ได้ เปิด-ปิดใช้งานได้ แต่แก้ไข/ลบไม่ได้ และแตะข้อมูลสมาชิกไม่ได้เลย |

เพิ่มเจ้าหน้าที่คนใหม่ได้จากแท็บ **Admins** ในหน้าเว็บเลย (super_admin เท่านั้นที่เห็นแท็บนี้) ไม่ต้องรัน SQL มือแล้ว

### 3. สิ่งที่เพิ่มในแต่ละแท็บ
- **Dashboard** — กราฟแท่งเทียบยอดสแกนแต่ละ Campaign + filter ดูว่าใคร engage กับ Campaign ไหนบ้าง
- **Members** — คลิกชื่อสมาชิกเพื่อดูรายละเอียด: ประวัติ Engagement ทุกครั้ง (Campaign ไหน ได้ Tier Score/Point เท่าไหร่), ประวัติการแลก Reward ทั้งหมด, ฟอร์มปรับ Tier Score/Point ด้วยมือ (super_admin/admin เท่านั้น), ปุ่มลบสมาชิกแบบต้องติ๊กยืนยัน + popup ยืนยันอีกชั้น (2 ชั้นตามที่ขอ)
- **Rewards / Campaigns** — เพิ่ม/แก้/เปิดปิด/**ลบ** ได้ในหน้าเดียว (staff เห็นแค่เปิดปิด แก้ไข/ลบไม่ได้)

## อัปเดต: สถิติสแกนตามช่วงเวลา + จัดส่งของรางวัล + Address Book + ลิงก์ QR

### 1. รัน Migration
รัน `migration-shipping-and-addresses.sql` ใน Supabase SQL Editor

### 2. สิ่งที่เปลี่ยน/เพิ่ม
- **Dashboard** — ตารางเปรียบเทียบยอดสแกนแต่ละ Campaign แยก วันนี้ / สัปดาห์นี้ / เดือนนี้ / ทั้งหมด
- **แลกของรางวัล** — ลูกค้ากดแลก → กรอกชื่อ/เบอร์/ที่อยู่ → ยืนยัน → หักแต้มทันที ไม่มี "รอยืนยัน" อีกต่อไป (ระบบใหม่ทั้งหมด ไม่ใช่โชว์โค้ดหน้าร้านแบบเดิม)
  - ถ้าเคยแลกมาก่อน จะมี dropdown ให้เลือกที่อยู่เดิมได้เลย ไม่ต้องพิมพ์ใหม่
  - ทุกที่อยู่ที่ใช้ จะถูกเก็บสะสมไว้ในบัญชีสมาชิกอัตโนมัติ (ตาราง `member_addresses`)
- **สถานะจัดส่ง** — แยกจากสถานะ "ใช้แล้ว" เป็นคนละอย่าง มีปุ่ม toggle "จัดส่งแล้ว / ยังไม่จัดส่ง" ทั้งใน Dashboard และหน้ารายละเอียดสมาชิก
- **Campaigns tab** — แต่ละ Campaign มีลิงก์ QR เต็มพร้อมปุ่ม "ก็อปลิงก์" กดครั้งเดียวก็อปไปสร้าง QR ได้เลย ไม่ต้องพิมพ์เอง

### 3. ไฟล์ที่ต้องอัปเดต/เพิ่มบน GitHub
- ไฟล์ใหม่: `lib/memberToken.js`, `api/redeem/confirm.js`
- ไฟล์แก้: `api/auth/callback.js`, `api/admin/[page].js`, `api/admin/action.js`

## อัปเดต: เปรียบเทียบหลาย Campaign พร้อมกัน (Dashboard)

### สิ่งที่เพิ่ม
- **เลือกได้หลาย Campaign พร้อมกัน** ผ่าน checkbox (เดิมเลือกได้แค่ 1) เหมาะกับแบรนด์ที่มีหลายสาขา/สถานที่ อยากเทียบผลลัพธ์กัน
- **ตารางเปรียบเทียบ** — สแกนทั้งหมด, ยอดสูงสุดใน 1 วัน, วันที่ทำยอดสูงสุด ของแต่ละ Campaign ที่เลือก
- **กราฟแนวโน้มรายสัปดาห์** — เส้นกราฟย้อนหลัง 8 สัปดาห์ แยกสีตาม Campaign ที่เลือก เทียบกันในกราฟเดียว

### วิธีใช้
เข้า Dashboard → เลื่อนไปหัวข้อ "เลือก Campaign เพื่อเปรียบเทียบ" → ติ๊กเลือก Campaign ที่ต้องการ (กี่อันก็ได้) → กด "เปรียบเทียบ"

### ไฟล์ที่ต้องอัปเดต
`api/admin/[page].js` (แก้ทั้งฟังก์ชัน Dashboard tab)

## ฟีเจอร์ใหม่: Office Area (ให้ Office อัปโหลด Content)

### ภาพรวม
- แต่ละ Office มีบัญชีของตัวเอง ล็อกอินแล้วเห็น**แค่หน้าเดียว** (ไม่เห็นเมนู Dashboard/Members อื่นๆ)
- มี Content ได้ 3 Slot ต่อ 1 Office แต่ละ Slot อัปโหลด รูป/วิดีโอ ได้ (JPEG, PNG, MP4 ไม่เกิน 125MB) พร้อมตั้งชื่อไฟล์และวันเวลาที่ต้องการให้แสดง
- **Admin และ Staff** เข้าดู/แก้ไข Content ของ **Office ไหนก็ได้** ผ่านแท็บ **"Office Area"** ในหน้า Admin Panel เดิม (มี dropdown เลือก Office)
- ทุกครั้งที่แก้ไข ระบบบันทึกว่า **ใครแก้ไขล่าสุด** (ไม่ว่าจะเป็น Office เองหรือ Admin/Staff) และเวลาไหน

### ทำไมต้องอัปโหลดตรงไป Supabase Storage
ไฟล์ใหญ่ถึง 125MB **อัปโหลดผ่าน Vercel Serverless Function ตรงๆ ไม่ได้** (เกินขีดจำกัดขนาด request) ระบบนี้เลยให้เบราว์เซอร์อัปโหลดไฟล์ตรงไปที่ Supabase Storage เลย ผ่าน "Signed Upload URL" ที่ฝั่งเซิร์ฟเวอร์สร้างให้ชั่วคราว — Vercel แค่รับข้อมูล (ชื่อไฟล์, เวลาแสดง) เท่านั้น ไม่ต้องรับไฟล์จริง

### ขั้นตอนติดตั้ง

**1. สร้าง Storage Bucket ใน Supabase**
1. เข้า Supabase → เมนูซ้าย **Storage**
2. กด **New bucket**
3. ตั้งชื่อ **`office-content`** (สะกดตรงนี้สำคัญมาก ต้องตรงเป๊ะ)
4. **ปล่อย Public bucket ไว้ไม่ต้องติ๊ก (เป็น Private)** — เพราะเป็นข้อมูลเฉพาะพนักงาน ไม่ควรให้คนนอกเข้าถึงได้ ระบบจะสร้างลิงก์ชั่วคราว (signed URL อายุ 1 ชั่วโมง) ให้เฉพาะตอนคนที่ login แล้วเปิดดูหน้า Office Area เท่านั้น
5. (แนะนำ) ตั้ง **File size limit** เป็น 125MB ในตั้งค่า bucket เผื่อกันไฟล์ใหญ่เกินหลุดเข้ามา

**2. หา Anon/Public Key มาเพิ่ม Environment Variable**
1. ใน Supabase เข้า **Project Settings > API**
2. หาแถว **`anon` `public`** (คนละอันกับ service_role ที่ใช้อยู่แล้ว) ก็อปค่า
3. ไปที่ Vercel → Settings → Environment Variables → เพิ่ม:
   - `SUPABASE_ANON_KEY` = ค่าที่ก็อปมา

**3. รัน Migration**
รัน `migration-office-area.sql` ใน Supabase SQL Editor — **แก้ username/password ตัวอย่างในไฟล์ก่อนรัน**

**4. อัปโหลดไฟล์โค้ดขึ้น GitHub**
ไฟล์ใหม่ทั้งหมด:
- `lib/officeAuth.js`
- `lib/officeArea.js`
- `api/office/index.js`
- `api/office/action.js`

ไฟล์แก้:
- `api/admin/action.js` (เพิ่ม action จัดการ office)
- `api/admin/[page].js` (เพิ่มแท็บ Office Area)

**5. Redeploy แล้วทดสอบ**
- **ฝั่ง Office:** เข้า `https://your-project.vercel.app/api/office/action?action=login` ล็อกอินด้วย username/password ที่ตั้งไว้ตอนรัน SQL → ควรเห็นหน้า Office Area 3 Slot ให้อัปโหลด
- **ฝั่ง Admin/Staff:** เข้า Admin Panel ปกติ → กดแท็บ **Office Area** → เลือก Office จาก dropdown → เห็นและแก้ไขได้เหมือนกัน

### เพิ่ม Office สาขาใหม่
รัน SQL นี้ (เปลี่ยนชื่อสาขา/username/password ตามจริง):
```sql
insert into office_accounts (office_name, username, password_hash)
values ('ชื่อสาขาใหม่', 'ชื่อ username', crypt('รหัสผ่าน', gen_salt('bf')));
```

## อัปเดต: จัดการบัญชี Staff/Office + เปลี่ยนรหัสผ่านตัวเอง

### สิ่งที่เพิ่ม
- **Admin จัดการบัญชี Staff และ Office ได้แล้ว** (เดิมทำได้แค่ Super Admin) — สร้าง/รีเซ็ตรหัสผ่าน/ลบได้ แต่**แตะบัญชี Admin/Super Admin คนอื่นไม่ได้** และ**เปลี่ยน role ใครไม่ได้เลย** (สิทธิ์นี้ยังเป็นของ Super Admin คนเดียว)
- **จัดการบัญชี Office ได้ในหน้าเว็บ** — แท็บ Office Area มีฟอร์มเพิ่ม/แก้ชื่อ-รหัสผ่าน/ลบ Office ให้เลย ไม่ต้องรัน SQL มือแล้ว (Super Admin, Admin ทำได้)
- **แท็บ "My Account" ใหม่** — ทุกคนเปลี่ยนรหัสผ่านตัวเองได้ (ต้องใส่รหัสผ่านเดิมยืนยันก่อน) มีทั้งฝั่ง Admin Panel และฝั่ง Office (อยู่ล่างสุดของหน้า Office Area)

### สรุปสิทธิ์ล่าสุด
| Role | จัดการบัญชี Admin/Super Admin | จัดการบัญชี Staff | จัดการบัญชี Office | เปลี่ยน role ใคร |
|---|---|---|---|---|
| super_admin | ✅ | ✅ | ✅ | ✅ |
| admin | ❌ | ✅ | ✅ | ❌ |
| staff | ❌ | ❌ | ❌ | ❌ |

### ไฟล์ที่ต้องอัปเดตบน GitHub
`lib/adminAuth.js`, `api/admin/action.js`, `api/admin/[page].js`, `api/office/action.js`, `api/office/index.js`

ไม่ต้องรัน SQL เพิ่ม (ใช้ตารางเดิมที่มีอยู่แล้ว)

## อัปเดต: Tier Score ได้วันละครั้งต่อ Campaign (Point ยังคงครั้งแรกครั้งเดียวเหมือนเดิม)

### กติกาใหม่
- **Tier Score** — สแกน Campaign เดิมได้อีกทุกวัน (วันละ 1 ครั้งต่อ Campaign) ไม่ใช่ครั้งแรกครั้งเดียวตลอดไปแบบเดิม
- **Point (สำหรับแลก Reward)** — ยังคงได้แค่**ครั้งแรกครั้งเดียวตลอดไป**ต่อ Campaign เหมือนเดิม ไม่เปลี่ยน

ตัวอย่าง: สแกน Campaign A วันจันทร์ → ได้ทั้ง Tier Score และ Point (เพราะเป็นครั้งแรก) → สแกน Campaign A อีกวันอังคาร → ได้แค่ Tier Score เพิ่ม (Point ไม่ได้อีกแล้ว เพราะเคยได้ไปแล้ว)

### 1. รัน Migration
รัน `migration-daily-tier-score.sql` ใน Supabase SQL Editor

### 2. ไฟล์ที่ต้องอัปเดต
`api/auth/callback.js`

## ฟีเจอร์ใหม่: ระบบ Sponsor จองสล็อตโฆษณา

### ภาพรวม
- Sponsor สมัครสมาชิกเอง (บริษัท, เลขภาษี, ที่อยู่, ผู้ติดต่อ ฯลฯ) แก้ไข Profile ได้เอง
- มีคลัง Content สูงสุด 6 ไฟล์ต่อบัญชี ทุกไฟล์ต้องผ่านการอนุมัติจากทีมงานก่อน ถึงจะเอาไปเลือกใช้ตอนจองได้
- จองสล็อตแบบปฏิทิน (คล้ายจองตั๋วหนัง) — เลือก Office → เห็นตาราง 3 Slot × 8 สัปดาห์ล่วงหน้า → กด "จอง" ช่องที่ว่าง → เลือกไฟล์จากคลังที่อนุมัติแล้ว → ยืนยัน
- **จองล่วงหน้าเท่านั้น** ระบบเปิดให้จองตั้งแต่สัปดาห์หน้าเป็นต้นไป (สัปดาห์นี้จองไม่ได้ เพื่อให้ทีมงานมีเวลาตรวจสอบ)
- ราคาต่อสัปดาห์ตั้งแยกตามแต่ละ Office โดย Admin (แก้ได้ในแท็บ Office Area)
- **ยังไม่มีระบบชำระเงินออนไลน์** — จองแล้วสถานะเป็น "รอชำระเงิน" (unpaid) ทีมงานติดต่อรับเงินนอกระบบ แล้วกดยืนยันในแท็บ Sponsors → "ยืนยันรับเงิน" (โครงสร้างฐานข้อมูลมีช่อง `payment_method`, `payment_reference` เตรียมไว้ต่อยอดระบบชำระเงินจริงในอนาคตแล้ว)

### ขั้นตอนติดตั้ง

**1. สร้าง Storage Bucket ที่ 2**
เหมือนกับตอนตั้งค่า `office-content` — เข้า Supabase Storage → New bucket → ตั้งชื่อ **`sponsor-content`** → **ไม่ต้องติ๊ก Public** (private เหมือนกัน) → ตั้ง File size limit 125MB

**2. รัน Migration**
รัน `migration-sponsor-booking.sql` ใน Supabase SQL Editor

**3. ตั้งราคาต่อ Office**
เข้า Admin Panel → แท็บ Office Area → ในตาราง "จัดการบัญชี Office" กรอกช่อง "ราคา/สัปดาห์" ของแต่ละ Office แล้วกดบันทึก (ค่าเริ่มต้นคือ 0 ถ้ายังไม่ตั้ง Sponsor จะเห็นราคา 0 บาท)

**4. อัปโหลดไฟล์โค้ดขึ้น GitHub**
ไฟล์ใหม่:
- `lib/sponsorAuth.js`
- `lib/sponsorArea.js`
- `api/sponsor/index.js`
- `api/sponsor/action.js`

ไฟล์แก้:
- `lib/officeArea.js` (เพิ่ม price_per_week ใน query)
- `api/admin/action.js` (เพิ่ม action จัดการราคา/อนุมัติ content/ยืนยันรับเงิน)
- `api/admin/[page].js` (เพิ่มแท็บ Sponsors + ช่องราคาในฟอร์ม Office)

**5. Redeploy แล้วทดสอบ**
- **ฝั่ง Sponsor:** เข้า `https://your-project.vercel.app/api/sponsor/action?action=signup` สมัครสมาชิกทดสอบ → อัปโหลดไฟล์ในแท็บ Content Library
- **ฝั่ง Admin:** เข้าแท็บ **Sponsors** → เห็นไฟล์รอตรวจสอบ → กดอนุมัติ
- **กลับไปฝั่ง Sponsor:** แท็บ "จองสล็อต" → เลือก Office → ควรเห็นปุ่ม "จอง" ในตาราง (เพราะมีไฟล์อนุมัติแล้ว) → ลองจองดู
- **กลับไปฝั่ง Admin:** แท็บ Sponsors ควรเห็นรายการจองใหม่ สถานะ "รอชำระเงิน" → กด "ยืนยันรับเงิน" ทดสอบ

### ⚠️ ข้อจำกัดสำคัญ
ตอนนี้ระบบใช้ Vercel Serverless Functions ครบ **12 จาก 12** (โควต้าสูงสุดของ Hobby Plan) แล้ว หากต้องการเพิ่มฟีเจอร์ใหม่ที่ต้องสร้างไฟล์ route ใหม่ (ไม่ใช่แค่แก้ไฟล์เดิม) จะต้อง**อัปเกรดเป็น Vercel Pro** ก่อน

## อัปเดต: รวม Serverless Functions ประหยัดโควต้า (12 → 9)

### สิ่งที่เปลี่ยน
รวม 4 ไฟล์ที่ทำหน้าที่คล้ายกัน (แค่สร้างลิงก์ไป LINE Login ด้วยข้อมูลต่างกัน) เป็นไฟล์เดียว:
- `api/points.js` + `api/rewards.js` + `api/redeem/[rewardId].js` + `api/redeem/confirm.js` → รวมเป็น **`api/member-action.js`**

### ⚠️ ลิงก์เปลี่ยน — ต้องอัปเดตทุกที่ที่เคยส่งลิงก์เหล่านี้ให้ลูกค้า
| เดิม | ใหม่ |
|---|---|
| `/api/points` | `/api/member-action?do=points` |
| `/api/rewards` | `/api/member-action?do=rewards` |
| `/api/redeem/3` | `/api/member-action?do=redeem&reward=3` |

**`/api/qr/[creative]` ไม่เปลี่ยน** เพราะเป็น URL ที่ทำ QR code จริงไปแล้ว

### ขั้นตอนติดตั้ง
1. **ลบไฟล์เก่าออกจาก GitHub:** `api/points.js`, `api/rewards.js`, `api/redeem/[rewardId].js`, `api/redeem/confirm.js` (ลบทั้งโฟลเดอร์ `api/redeem` ได้เลยถ้าไม่มีไฟล์อื่นเหลือ)
2. **เพิ่มไฟล์ใหม่:** `api/member-action.js`
3. **แทนที่ไฟล์:** `api/auth/callback.js` (แก้ลิงก์ให้ชี้ไปที่ endpoint ใหม่)
4. Redeploy — เช็คว่า Function count ลดลงเหลือ 9 ใน Vercel Dashboard

### ผลลัพธ์
Function count: **12 → 9** เหลือที่ว่างสำหรับเพิ่มฟีเจอร์ใหม่ได้อีก 3 (หรือรวมเพิ่มได้อีกถ้าต้องการที่ว่างมากกว่านี้ — รวม GET/POST ของ admin, office, sponsor แต่ละคู่เข้าด้วยกันได้อีก 3)

## ฟีเจอร์ใหม่: รับ Log จำนวนรอบการเล่นเนื้อหาจริงจาก CMS

### ภาพรวม
Endpoint กลางให้ CMS ที่ควบคุมจอ (ยี่ห้อไหนก็ได้ที่รองรับ Webhook) ยิงข้อมูลเข้ามาทุกครั้งที่เล่นเนื้อหาจบ 1 รอบ แล้วแสดงสรุปในแท็บ Office Area (วันนี้/สัปดาห์นี้/เดือนนี้/ทั้งหมด แยกตาม Slot)

### 1. รัน Migration
รัน `migration-play-logs.sql` ใน Supabase SQL Editor

### 2. เพิ่ม Environment Variable ใหม่
- `PLAYBACK_WEBHOOK_SECRET` = ตั้งรหัสลับยาวๆ (ใช้ป้องกันไม่ให้คนนอกยิงข้อมูลปลอมเข้ามา)

### 3. ตั้งค่าใน CMS
เอา URL นี้ไปตั้งเป็น Webhook/Callback ปลายทางใน CMS (วิธีตั้งค่าแตกต่างกันไปแต่ละยี่ห้อ):
```
POST https://your-project.vercel.app/api/playback-log?key=ค่าที่ตั้งใน PLAYBACK_WEBHOOK_SECRET
Content-Type: application/json

{
  "office_id": 3,
  "screen_id": "LOBBY-01",
  "slot_number": 1,
  "content_label": "promo-video.mp4",
  "played_at": "2026-08-07T10:30:00Z"
}
```
ทุกฟิลด์ใน body เลือกใส่ได้ตามที่ CMS มีให้ ไม่จำเป็นต้องครบ — `office_id` คือ id ของ Office ในระบบเรา (ดูได้จากแท็บ Office Area)

### 4. ไฟล์ที่ต้องอัปโหลด/แก้บน GitHub
- ไฟล์ใหม่: `api/playback-log.js`
- ไฟล์แก้: `api/admin/[page].js` (เพิ่มส่วนแสดงสถิติในแท็บ Office Area)

### 5. ทดสอบ
ยิง request ทดสอบด้วยเครื่องมืออย่าง Postman หรือ `curl`:
```bash
curl -X POST "https://your-project.vercel.app/api/playback-log?key=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"office_id": 1, "slot_number": 1, "content_label": "test.mp4"}'
```
แล้วเข้าแท็บ Office Area ดูว่าตัวเลขขึ้นไหม

## อัปเดตใหญ่: 18 สล็อตต่อ Office + ระบบชำระเงิน (Omise + SlipOK)

### สิ่งที่เพิ่ม
- **จำนวนสล็อตปรับได้ต่อ Office** (ค่าเริ่มต้น 18) ตั้งได้ในแท็บ Office Area
- **แท็บ "สล็อตของฉัน" (Bookings)** ฝั่ง Sponsor — ดูรายการที่จองไว้ทั้งหมด เปลี่ยนไฟล์ที่แสดงได้ ยกเลิกได้ (ถ้ายังไม่จ่ายเงิน) และกดชำระเงินได้
- **ชำระด้วยบัตรเครดิต/เดบิต** ผ่าน Omise รองรับ 3D Secure อัตโนมัติ
- **ชำระด้วยการโอน/QR** — อัปโหลดสลิป ระบบส่งให้ SlipOK ตรวจสอบยอดเงินอัตโนมัติ ถ้าตรง = ยืนยันจ่ายทันที ถ้าไม่ตรง/ตรวจไม่ผ่าน = ค้างไว้ให้ทีมงานตรวจสอบมือ (เห็นลิงก์ดูสลิปในแท็บ Sponsors)
- **ไม่เพิ่ม Vercel Function เลย** — ยังคง 10/12 เหมือนเดิม (ใส่ logic เพิ่มในไฟล์ action.js ที่มีอยู่แล้ว)

### ขั้นตอนติดตั้ง

**1. รัน SQL**
รัน `migration-payments-and-slots.sql` ใน Supabase SQL Editor

**2. สร้าง Storage Bucket ที่ 3**
เข้า Supabase Storage → New bucket → ชื่อ **`payment-slips`** → **Private** (ไม่ติ๊ก Public)

**3. สมัคร Omise**
1. สมัครบัญชีที่ omise.co (หรือ opn.ooo ชื่อใหม่ของ Omise)
2. ไปที่ Dashboard > Keys เก็บค่า **Public Key** และ **Secret Key**
3. ตั้งค่า Webhook ใน Omise Dashboard ให้ยิงมาที่:
   ```
   https://your-project.vercel.app/api/sponsor/action?action=omise_webhook
   ```

**4. สมัคร SlipOK**
1. สมัครที่ slipok.com เพื่อขอ API Key และ Branch ID
2. (ต้องผูกบัญชีธนาคารที่จะรับเงินไว้กับ SlipOK ตามขั้นตอนที่เขากำหนด)

**5. เพิ่ม Environment Variables ใหม่ 5 ตัวใน Vercel**
- `OMISE_PUBLIC_KEY`
- `OMISE_SECRET_KEY`
- `SLIPOK_API_KEY`
- `SLIPOK_BRANCH_ID`
- `APP_BASE_URL` = `https://your-project.vercel.app` (ใช้สร้างลิงก์ return หลัง 3D Secure)

**6. อัปโหลดไฟล์โค้ดขึ้น GitHub**
ไฟล์ใหม่: `lib/payments.js`
ไฟล์แก้: `lib/sponsorArea.js`, `api/sponsor/index.js`, `api/sponsor/action.js`, `api/admin/action.js`, `api/admin/[page].js`

**7. Redeploy แล้วทดสอบ**
- ทดสอบบัตร Omise ด้วยเลขบัตรทดสอบของ Omise (มีในเอกสาร Omise sandbox mode ก่อนใช้จริง)
- ทดสอบโอนเงินจริงยอดน้อยๆ แล้วอัปโหลดสลิปดูว่า SlipOK ตรวจสอบผ่านไหม

### ⚠️ ข้อควรระวัง
- ควรทดสอบทั้งสองระบบชำระเงินด้วย **Omise Test Mode / โอนเงินยอดจริงน้อยๆ ก่อน** อย่าเพิ่งเปิดให้ลูกค้าใช้จริงจนกว่าจะทดสอบผ่านหมด
- `SLIPOK_BRANCH_ID` ต้องผูกกับบัญชีธนาคารที่ถูกต้องแล้วเท่านั้น ไม่งั้นจะตรวจสอบสลิปไม่ผ่านเลย

## อัปเดต: หน้าจองแบบใหม่ + จำกัดเวลาชำระเงิน 15 นาที + Super Admin แก้ Sponsor Account

### สิ่งที่เปลี่ยน
- **หน้าจองใหม่:** เลือก Office → เลือกสัปดาห์ (จาก 4 สัปดาห์ วิ่งไปเรื่อยๆ ทีละสัปดาห์) → ติ๊กเลือกได้หลาย Slot พร้อมกัน → ยืนยันทีเดียว จ่ายเงินรวมครั้งเดียว
- **จำกัดเวลาชำระเงิน 15 นาที** — จองแล้วมีนับถอยหลังในหน้าชำระเงิน ถ้าไม่จ่ายทันเวลา Slot จะกลับมาว่างให้คนอื่นจองได้อัตโนมัติ (เช็คตอนโหลดหน้าปฏิทิน ไม่ต้องมี background job แยก)
- **Super Admin แก้ไขข้อมูล Sponsor ได้ทั้งหมด** รวม username (อีเมล) และรีเซ็ตรหัสผ่าน — อยู่ในแท็บ Sponsors (Admin ธรรมดาไม่เห็นส่วนนี้)

### ขั้นตอนติดตั้ง

**1. รัน SQL**
รัน `migration-booking-expiry.sql` ใน Supabase SQL Editor

**2. อัปโหลดไฟล์โค้ดขึ้น GitHub**
ไฟล์แก้: `lib/adminAuth.js`, `lib/sponsorArea.js`, `api/sponsor/index.js`, `api/sponsor/action.js`, `api/admin/action.js`, `api/admin/[page].js`

**3. Redeploy แล้วทดสอบ**
- ลองจองหลาย Slot พร้อมกันในสัปดาห์เดียว เช็คว่ายอดรวมคำนวณถูกไหม
- ลองปล่อยรายการที่จองไว้ไม่จ่ายเงินเกิน 15 นาที แล้วกลับไปดูปฏิทิน ควรว่างกลับมาให้จองใหม่ได้
- ล็อกอินด้วยบัญชี Super Admin เข้าแท็บ Sponsors เช็คว่าเห็นฟอร์มแก้ไขบัญชี Sponsor ครบทุกช่อง

## ฟีเจอร์ใหม่: ลืมรหัสผ่าน (Sponsor + Office) ผ่านอีเมล

### ภาพรวม
ทั้ง Sponsor และ Office มีปุ่ม "ลืมรหัสผ่าน?" ที่หน้า Login กรอกอีเมล → ระบบส่งลิงก์รีเซ็ตไปทางอีเมล (ใช้ได้ 30 นาที ใช้ได้ครั้งเดียว) → คลิกลิงก์ตั้งรหัสผ่านใหม่ได้เลย

**ใช้ Resend สำหรับส่งอีเมล** (resend.com) — ถ้าอยากเปลี่ยนเป็นเจ้าอื่นทีหลังบอกได้ แก้แค่ไฟล์ `lib/email.js` ไฟล์เดียว

**ไม่เพิ่ม Vercel Function เลย** — ยังคง 10/12 เหมือนเดิม

### ขั้นตอนติดตั้ง

**1. รัน SQL**
รัน `migration-password-reset.sql` ใน Supabase SQL Editor (เพิ่มอีเมลให้ Office + ตารางกัน token ใช้ซ้ำ)

**2. สมัคร Resend**
1. สมัครที่ resend.com (มี Free tier ให้ใช้)
2. ไปที่ API Keys สร้างคีย์ใหม่ เก็บไว้
3. (แนะนำ) ผูกโดเมนของตัวเองใน Resend เพื่อส่งจากอีเมล `@โดเมนคุณ` — ถ้ายังไม่มีโดเมน ใช้ค่าเริ่มต้น `onboarding@resend.dev` ไปพลางก่อนได้ (จำกัดส่งได้เฉพาะอีเมลที่ยืนยันตัวตนไว้กับ Resend ในโหมดทดสอบ)

**3. เพิ่ม Environment Variables ใหม่**
- `RESEND_API_KEY` = คีย์จาก Resend
- `EMAIL_FROM` = อีเมลผู้ส่ง เช่น `noreply@yourdomain.com` (ถ้าไม่ใส่จะใช้ `onboarding@resend.dev` แทน)

**4. ตั้งอีเมลให้ Office ที่มีอยู่แล้ว**
เข้าแท็บ Office Area → กรอกช่อง "อีเมล" ของแต่ละ Office ที่ยังไม่มี (คอลัมน์ใหม่ในตาราง จะว่างเปล่าถ้าสร้าง Office ไว้ก่อนหน้านี้) แล้วกดบันทึก — ถ้าไม่มีอีเมล จะขอลิงก์รีเซ็ตไม่ได้

**5. อัปโหลดไฟล์โค้ดขึ้น GitHub**
ไฟล์ใหม่: `lib/email.js`, `lib/passwordReset.js`
ไฟล์แก้: `api/sponsor/action.js`, `api/office/action.js`, `api/admin/action.js`, `api/admin/[page].js`, `lib/officeArea.js`

**6. Redeploy แล้วทดสอบ**
ลองกด "ลืมรหัสผ่าน" ที่หน้า Login ทั้งฝั่ง Sponsor และ Office ด้วยอีเมลจริง เช็คว่าอีเมลมาไหม (เช็ค Spam ด้วยถ้ายังไม่ได้ผูกโดเมน)

## ฟีเจอร์ใหม่: Playlist Feed สำหรับ CMS (Pull) — Sponsor เปลี่ยนโฆษณาเอง ไม่ต้องผ่านแอดมิน

### ภาพรวม
Endpoint ให้ CMS ภายนอก (เช่น Novlink) **ดึง** รายการ Content ที่ต้องเล่นตอนนี้ของแต่ละ Office ไปเล่นเอง — รวมทั้ง Content ที่ Office จัดการเอง (3 slot) และ Content ของ Sponsor ที่จองสล็อตและจ่ายเงินแล้วในสัปดาห์ปัจจุบัน

**จุดสำคัญ:** Sponsor เข้าไปเปลี่ยนไฟล์ในสล็อตของตัวเองเมื่อไหร่ (ในคลัง Content ที่อนุมัติแล้ว) รอบถัดไปที่ CMS มาดึงข้อมูล (ปกติตั้งได้ทุก 5-15 นาที) จะได้ไฟล์ใหม่ไปเล่นทันที **ไม่ต้องมีแอดมินมาอัปโหลดซ้ำเลย**

### ขั้นตอนติดตั้ง

**1. เพิ่ม Environment Variable ใหม่**
- `PLAYLIST_FEED_SECRET` = ตั้งรหัสลับยาวๆ (ป้องกันคนนอกดึงข้อมูล/ลิงก์ไฟล์ไปได้)

**2. อัปโหลดไฟล์ใหม่ขึ้น GitHub**
- `api/playlist.js`

**3. Redeploy**
Function count จะขึ้นเป็น **11/12** (เหลือที่ว่างอีกแค่ 1 — ถ้าจะเพิ่มฟีเจอร์ใหม่ที่ต้องมี route เพิ่มอีก ต้องพิจารณารวมไฟล์เดิมเพิ่ม หรืออัปเกรด Vercel Pro)

**4. เอา URL นี้ไปตั้งค่าใน CMS** (แต่ละ Office ใช้ URL คนละอัน เปลี่ยนแค่ `office_id`):
```
https://your-project.vercel.app/api/playlist?office_id=1&key=ค่าที่ตั้งใน PLAYLIST_FEED_SECRET
```
วิธีตั้งค่าใน CMS ขึ้นกับยี่ห้อ — มองหาฟีเจอร์ชื่อประมาณ "Web Content", "URL Zone", "JSON Feed", "External Playlist"

**5. ทดสอบก่อนต่อ CMS จริง**
เปิด URL ด้านบนตรงๆ ในเบราว์เซอร์ หรือใช้ curl:
```bash
curl "https://your-project.vercel.app/api/playlist?office_id=1&key=YOUR_SECRET"
```
ควรได้ JSON กลับมาแบบนี้:
```json
{
  "office": "สำนักงานสาขา 1",
  "week_start": "2026-08-17",
  "generated_at": "2026-08-18T10:00:00.000Z",
  "items": [
    { "source": "office", "slot": 1, "file_name": "...", "file_type": "video", "video_url": "https://..." },
    { "source": "sponsor", "slot": 4, "sponsor": "บริษัท A", "file_name": "...", "file_type": "video", "video_url": "https://..." }
  ]
}
```

### หมายเหตุ
- ลิงก์ไฟล์ (`video_url`) มีอายุ 6 ชั่วโมง สร้างใหม่ทุกครั้งที่ CMS มาดึงข้อมูล ไม่ต้องกังวลเรื่องหมดอายุถ้า CMS ดึงเป็นระยะตามปกติ
- แสดงเฉพาะรายการที่ `payment_status = 'paid'` เท่านั้น รายการที่ยังไม่จ่ายเงินจะไม่ปรากฏใน feed
- ถ้า Quanstar ยืนยันว่า Novlink มี Webhook/Push API ด้วย สามารถทำเพิ่มได้ในอนาคต (อัปเดตทันทีแทนรอรอบ pull) แต่ต้องพิจารณาโควต้า Function ที่เหลืออยู่ (1 ที่)

## อัปเดต: ธีมแบรนด์ "Ink & Signal" — UI ดูน่าเชื่อถือขึ้นทั้งระบบ

### สิ่งที่เปลี่ยน
- สร้างไฟล์ธีมกลาง `public/theme.css` + `public/theme.js` เชื่อมเข้ากับ**ทุกหน้าในระบบ** (Admin, Sponsor, Office, หน้าลูกค้าที่มาจาก LINE) รวม 18 จุด
- **สีแบรนด์ใหม่:** Ink Navy (`#14161f`) เป็นสีหลัก + Signal Orange (`#ff5b2e`) เป็นสีเน้นสำหรับปุ่มและจุดสำคัญ — ให้ความรู้สึกเป็นองค์กรโฆษณา ไม่ใช่ SaaS ทั่วไป
- ปุ่มหลักทุกหน้า (Login, Signup, บันทึกข้อมูล) เปลี่ยนเป็นสีส้มแบรนด์อัตโนมัติ
- แท็บเมนูที่ active ใช้สีส้มขีดเส้นใต้ ให้เห็นชัดว่าอยู่หน้าไหน
- การ์ด/กล่องต่างๆ มีเงานุ่มขึ้น มุมโค้งมนขึ้นเล็กน้อย ดูมีมิติกว่าเดิม
- ตารางบนมือถือเลื่อนแนวนอนได้ลื่นขึ้น ไม่บีบจนอ่านไม่ออก
- เพิ่มฟังก์ชัน `showToast()` ให้เรียกใช้แจ้งผลสำเร็จ/ผิดพลาดแบบลอย (พร้อมใช้ แต่ยังไม่ได้เชื่อมทุกจุด — เพิ่มได้ทีหลังตามต้องการ)

### วิธีปรับสีแบรนด์ทีหลัง (ถ้าอยากเปลี่ยน)
แก้แค่ไฟล์เดียว `public/theme.css` ตรงส่วน `:root` บนสุด:
```css
:root {
  --brand-ink: #14161f;      /* สีหลัก (เข้ม) */
  --brand-primary: #ff5b2e;  /* สีเน้น/ปุ่ม */
}
```
เปลี่ยนค่าตรงนี้ มีผลกับทุกหน้าทันที ไม่ต้องไปแก้ทีละไฟล์

### ขั้นตอนติดตั้ง

**1. เพิ่มไฟล์ใหม่ 2 ไฟล์ขึ้น GitHub**
- `public/theme.css`
- `public/theme.js`

**2. แทนที่ไฟล์เดิม 8 ไฟล์** (แค่เพิ่ม 2 บรรทัดเชื่อมธีมในแต่ละหน้า ไม่กระทบ logic เดิม):
`api/admin/[page].js`, `api/admin/action.js`, `api/auth/callback.js`, `api/member-action.js`, `api/office/action.js`, `api/office/index.js`, `api/sponsor/action.js`, `api/sponsor/index.js`

**3. Redeploy** — ไม่ต้องรัน SQL เพิ่ม ไม่เพิ่ม Function count (ยังคง 11/12)

## อัปเดต: เลือกคอนเทนต์แยกต่อ Slot + Sponsor ดูจำนวนรอบเล่นจริง

### สิ่งที่เปลี่ยน
- **เลือกไฟล์แยกแต่ละ Slot ได้แล้ว** — จากเดิมที่ต้องใช้ไฟล์เดียวกับทุก Slot ที่จองพร้อมกัน ตอนนี้ติ๊กเลือก Slot ไหน จะมี dropdown เลือกไฟล์ของ Slot นั้นโผล่ขึ้นมาทันที เลือกไฟล์คนละอันได้อิสระ
- **Sponsor เห็นจำนวนรอบที่คอนเทนต์เล่นจริงบนจอ** — แท็บ "สล็อตของฉัน" มีคอลัมน์ใหม่ "เล่นแล้ว" ดึงข้อมูลจาก Playback Log ที่ CMS ส่งเข้ามา (เห็นเฉพาะรายการที่ชำระเงินแล้ว เพราะรายการที่ยังไม่จ่ายไม่ได้ถูกส่งไปเล่นจริง)

### หมายเหตุสำคัญ
ตัวเลข "เล่นแล้ว" จะมีข้อมูลก็ต่อเมื่อ**เชื่อมต่อ CMS เข้ากับ `/api/playback-log` เรียบร้อยแล้ว** (ตามที่ตั้งค่าไว้ก่อนหน้านี้) ถ้ายังไม่ได้เชื่อม CMS จริง คอลัมน์นี้จะโชว์ 0 รอบตลอด เพราะไม่มีข้อมูลส่งเข้ามา

### ไฟล์ที่ต้องอัปเดตบน GitHub
`lib/sponsorArea.js`, `api/sponsor/index.js`, `api/sponsor/action.js`

ไม่ต้องรัน SQL เพิ่ม (ใช้ตารางเดิมที่มีอยู่แล้วทั้งหมด)

## ดึงข้อมูลไปทำรายงาน
เข้า Supabase > SQL Editor แล้วรัน query ตามที่ต้องการ เช่น สรุปยอดสแกนรายวันแยกตาม creative:

```sql
select
  creative_id,
  date(scanned_at) as scan_date,
  count(*) as scans
from scan_logs
group by creative_id, scan_date
order by scan_date;
```

Export ผลลัพธ์เป็น CSV แล้วส่งมาให้ผมช่วยทำเป็นรายงานได้เลย
