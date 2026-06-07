# CHANGELOG - MIXDM

All notable changes to the MIXDM project will be documented in this file.

## [1.3.0] - 2026-05-31

### Added
- Added automatic yt-dlp stability tuning for long HLS/DASH downloads, including concurrent fragments, retry tuning, socket timeout, and a stable buffer size.
- Added smoother download speed reporting with EWMA smoothing so charts, HUD, cards, speed, and ETA are less jumpy while progress remains accurate.
- Added immediate visual feedback for Speed Limiter controls in Settings, including active states for speed modes and presets plus an unsaved-changes indicator.

### Changed
- Improved HTTP segmented downloader backpressure handling so network reads pause when disk writes need time to drain.
- Improved profile menu behavior so the profile panel opens reliably and can fall back to locally cached profile data when needed.
- Changed the built-in admin account to use a generated 16+ character password on each app start instead of the old public default password.
- Updated the app and MIXDM Connector version to `1.3.0`.

### Fixed
- Fixed Speed Limiter presets so `5 MB/s`, `25 MB/s`, `100 MB/s`, and `Full` sync correctly with the enable toggle and max speed field without secretly changing Speed Mode.
- Fixed Settings save/read security by requiring authentication for `/api/settings`.
- Fixed unsafe file operations by restricting open, show-in-folder, and delete actions to files inside the active downloads directory.
- Fixed profile update security so users can no longer change their own `subscription` plan through the profile endpoint.
- Fixed localhost startup testing path by verifying the app under the Electron runtime used by the native SQLite module.

## [1.2.0] - 2026-05-29

### Fixed (ระบบที่ได้รับการแก้ไขและปรับปรุง)
- อัปเดตและปรับปรุงส่วนขยาย (MIXDM Connector) และโปรแกรมหลักเป็นเวอร์ชัน `1.2.0`

## [1.1.5] - 2026-05-28

### Added (ระบบที่เพิ่มเข้ามาใหม่)
- **ระบบสลับธีมสีไดนามิก (Dynamic Theme Switcher System)**
  - เพิ่มหัวข้อการเลือกธีม **"shushutan theme"** ในหน้าต่างการตั้งค่าของโปรแกรม ช่วยให้ผู้ใช้งานสามารถสลับไปมาระหว่างธีมสีปกติ (Default Indigo Slate Theme) และธีมสีมาสคอตน้องกระรอกวิเศษ Shushutan (Shushutan Theme) ได้ทันทีโดยไม่ต้องรีสตาร์ตหน้าแอป
  - บันทึกการเลือกธีมสีลงไฟล์ตั้งค่า `settings.json` บนเซิร์ฟเวอร์ และทำการซิงโครไนซ์ไปยังส่วนขยายของเบราว์เซอร์ (Chrome Extension Popup & Injected floating widgets) โดยอัตโนมัติ เพื่อให้แสดงผลคุมโทนเดียวกันได้อย่างสมบูรณ์แบบ
- **ระบบตรวจสอบความปลอดภัยดาวน์โหลดขั้นสูง (Download Security Safeguard System)**
  - คัดกรองและตรวจสอบความปลอดภัยของไฟล์และโดเมนก่อนดาวน์โหลด เพื่อคัดแยกมัลแวร์สคริปต์หรือไฟล์อันตราย (.exe, .msi, .bat, .vbs, .js) ที่เกิดจากโฆษณาแฝงบนหน้าเว็บทั่วไป
  - ฝั่งแอปจะทำการแสดงหน้าจอป๊อปอัปแจ้งเตือนความปลอดภัย (Security Warning Modal) ตรงกลางจอเพื่อให้ผู้ใช้งานกดยืนยันการดาวน์โหลดต่อไปหรือยกเลิก
  - ฝั่งส่วนขยายเบราว์เซอร์จะสั่งการให้ดาวน์โหลดด้วยสถานะหยุดชั่วคราว (Paused) พร้อมติดป้ายคำเตือนอันตรายสีเหลืองทองที่ชื่อไฟล์ (`⚠️ ความปลอดภัย: ...`) เพื่อป้องกันการดาวน์โหลดและเรียกใช้งานสคริปต์ที่เป็นภัยโดยไม่รู้ตัว

### Fixed (ระบบที่ได้รับการแก้ไขและปรับปรุง)
- **อัปเดตและปรับปรุงส่วนขยาย (MIXDM Connector)**
  - อัปเดตเลขเวอร์ชันส่วนขยายเบราว์เซอร์เป็น `1.1.5`

## [1.1.4] - 2026-05-28

### Added (ระบบที่เพิ่มเข้ามาใหม่)
- **ระบบเลี่ยงชั้นป้องกันรูปภาพเบราว์เซอร์ (Right-Click Overlay Bypass for Extension)**
  - เพิ่มการตรวจจับพิกัดการคลิกขวาในส่วนขยายเบราว์เซอร์ และใช้ฟังก์ชันส่งพิกัดเมาส์ทะลุผ่าน Layer โปร่งใสของเว็บสไตล์ Pixiv เพื่อดึงลิงก์รูปภาพจริง (`i.pximg.net`) ด้านหลังส่งมาดาวน์โหลดได้อย่างถูกต้อง
  - แยกบริบทการทำงานให้แสดงผลเมนูคลิกขวาพิเศษ **"Download image as ... (Overlay Bypass)"** เฉพาะโดเมนเป้าหมายที่มีระบบป้องกันการเซฟรูปภาพครอบอยู่ (เช่น Pixiv, ArtStation, DeviantArt) ผ่านการทำงานของ `documentUrlPatterns` เพื่อไม่รบกวนเว็บปกติอื่น ๆ

### Fixed (ระบบที่ได้รับการแก้ไขและปรับปรุง)
- **ระบบดาวน์โหลดรูปภาพตรงจาก Pixiv/CDNs (Automatic Referer Injection)**
  - เพิ่มระบบตรวจจับโฮสต์เก็บรูปภาพปลายทางของ Pixiv, ArtStation, Weibo, DeviantArt บนฝั่งเซิร์ฟเวอร์หลังบ้าน (`downloader.js`) และทำการฉีดค่า `Referer` ที่ถูกต้องลงใน request ให้ทันทีโดยอัตโนมัติ แก้ปัญหาการดาวน์โหลดตรงไม่ผ่านเนื่องจากติดบล็อก HTTP 403 (Forbidden)
- **แก้ไขปัญหาวิเคราะห์ลิงก์ Bilibili Global (`bilibili.tv`)**
  - อัปเดตนิพจน์ปกติ (Regex Pattern) ในตัวดักจับลิงก์ของวิดีโอ เพื่อให้รองรับโดเมน `bilibili.tv` และรูปแบบการเปิดเล่นอื่น ๆ นอกเหนือจาก `.com/video/` ทำให้ส่งลิงก์จากหน้าเว็บเวอร์ชันต่างประเทศเข้าไปดาวน์โหลดผ่าน `yt-dlp` ได้แล้ว
- **ระบบทนทานต่อการล็อกไฟล์คุกกี้บน Windows (Cookie Lock Automatic Fallback)**
  - พัฒนาระบบสำรองกรณีไฟล์คุกกี้ของเบราว์เซอร์โดนล็อกโดยระบบปฏิบัติการ Windows (เนื่องจากเปิดเบราว์เซอร์ค้างไว้) หลังบ้านจะทำการสลับไปดาวน์โหลดแบบผู้ใช้ทั่วไป (Guest) โดยอัตโนมัติเพื่อให้งานดำเนินต่อได้ ไม่เด้งข้อผิดพลาดขัดขวางการทำงานทั้งหมด
  - เพิ่มการแจ้งเตือนรูปแบบคำแนะนำบนหน้าต่างแอปหลัก (Yellow Warning Badge & Toast Notification) เพื่อแนะนำให้ผู้ใช้งานปิดหน้าต่างเบราว์เซอร์ Chrome ชั่วคราวหากต้องการปลดล็อกไฟล์เพื่อดาวน์โหลดความละเอียดระดับพรีเมียม (1080p/FHD)
- **ปรับปรุงเวอร์ชัน Browser Extension**
  - อัปเดตเลขเวอร์ชันของ **MIXDM Connector** เป็น `1.1.4`

## [1.1.3] - 2026-05-28

### Added (ระบบที่เพิ่มเข้ามาใหม่)
- **ระบบแชร์ Cookies จากเบราว์เซอร์ให้ yt-dlp**
  - เพิ่มการรองรับและดึง Cookie จากเบราว์เซอร์โดยใช้ flag `--cookies-from-browser` ของ yt-dlp เพื่อให้ดาวน์โหลดวิดีโอจากเว็บจำกัดสิทธิ์หรือต้องล็อกอินได้ทันที (เช่น YouTube Premium, Facebook ส่วนตัว, Instagram Private ฯลฯ)
  - เพิ่มส่วนการตั้งค่าในหน้า Settings ของแอปเพื่อสลับเปิด/ปิดการแชร์คุกกี้ และระบุเบราว์เซอร์เป้าหมาย (Chrome, Edge, Firefox, Brave, Opera, Vivaldi) บันทึกลงไฟล์ตั้งค่า `settings.json`
  - เพิ่มฟังก์ชัน **"Retry with cookies"** บนการ์ดดาวน์โหลดที่มีข้อผิดพลาดจากปัญหาการตรวจสอบสิทธิ์หรืออายุ เพื่อให้เริ่มดาวน์โหลดใหม่ด้วยคุกกี้เบราว์เซอร์ได้ทันทีอย่างรวดเร็ว

### Fixed (ระบบที่ได้รับการแก้ไขและปรับปรุง)
- **ปรับปรุงเวอร์ชัน Browser Extension**
  - อัปเดตเลขเวอร์ชันของ **MIXDM Connector** เป็น `1.1.3`
- **ระบบบิวด์แพ็กเกจ (Packaging)**
  - เพิ่ม `settings.js` ลงในการกำหนดค่าไฟล์ของ `electron-builder` ป้องกันข้อผิดพลาดโมดูลขาดหายหลังการบิวด์และติดตั้ง

## [1.1.2] - 2026-05-28

### Fixed (ระบบที่ได้รับการแก้ไขและปรับปรุง)
- **แก้ไขบั๊กดาวน์โหลดไฟล์ถูกปฏิเสธ (HTTP 403 Forbidden)**
  - เพิ่มการรองรับและส่งผ่าน custom `headers` โดยเฉพาะ `Referer` จาก Browser Extension ไปยังระบบดาวน์โหลดหลัก
  - แก้ไขปัญหาดาวน์โหลดรูปภาพจากบางเว็บไซต์ที่มีระบบป้องกัน Hotlinking ไม่สำเร็จ (เช่นรูปภาพจาก Pixiv ที่ใช้ชื่อรูปแบบ `*_p0.jpg` เป็นต้น) ให้สามารถดาวน์โหลดได้ตามปกติโดยระบบจะแนบ URL ของหน้าเว็บเป็น Referer ให้อัตโนมัติ

- **ปรับปรุงเวอร์ชัน Browser Extension**
  - ปรับเลขเวอร์ชันของ **MIXDM Connector** จาก `0.1.0` ➡️ `1.1.2` เพื่อให้ตรงกันและสอดคล้องกับเลขเวอร์ชันของโปรแกรมหลัก

---

## [1.1.1] - 2026-05-28

### Added (ระบบที่เพิ่มเข้ามาใหม่)
- **ระบบ System Tray (Background Mode)**
  - กดปิดหน้าต่างแอป (`X`) จะไม่ปิดโปรแกรม แต่จะซ่อนหน้าต่างและทำงานอยู่ใน System Tray (มุมขวาล่างของ Windows) เพื่อให้ดาวน์โหลดต่อได้ไม่สะดุด
  - แสดงลูกโป่งแจ้งเตือน (Balloon Notification) ในครั้งแรกเมื่อย่อแอปไปที่ Tray
  - เมนูคลิกขวาที่ไอคอน Tray เพื่อจัดการ:
    - **เปิด MIXDM:** นำหน้าต่างหลักขึ้นมาแสดงผลใหม่
    - **เปิดอัตโนมัติเมื่อเปิดคอม:** สลับการเปิดระบบ Auto-launch
    - **ออกจากโปรแกรม:** ดับเบิลเซิร์ฟเวอร์และปิดแอปอย่างสมบูรณ์แบบ
  - ดับเบิลคลิกที่ไอคอน Tray เพื่อสลับหน้าต่างกลับมาทำงานต่อได้ทันที
  - ดึงข้อมูลไอคอน Tray อัตโนมัติจากไฟล์ `favicon.ico` หรือ `icon.png` (หากไม่มีจะสร้าง Default Icon สีม่วง Indigo ให้เอง)

- **ระบบ Auto-Launch (เปิดโปรแกรมอัตโนมัติเมื่อเปิดคอม)**
  - ลงทะเบียนแอปเข้าสู่ระบบ Startup ของ Windows ผ่าน API โดยตรง
  - **Start Minimized:** เมื่อเปิดคอม แอปจะเปิดตัวอยู่เบื้องหลังใน Tray เงียบๆ ทันทีโดยไม่เปิดหน้าต่างหลักขึ้นมารบกวนผู้ใช้

- **ระบบ Focus Integration ร่วมกับ Browser Extension**
  - พัฒนา endpoint `/api/focus-window` บน Server หลัก
  - เมื่อผู้ใช้กดดาวน์โหลดไฟล์ผ่าน Browser Extension ตัวหน้าต่างโปรแกรม MIXDM จะเด้งโฟกัสขึ้นมาให้ทันที (Focus window pops up)
  - **ยกเลิกการเปิดแท็บใหม่บน Browser:** หน้าเว็บเบราว์เซอร์จะไม่แสดงผลแท็บหน้าต่าง localhost อีกต่อไป ทำให้การดาวน์โหลดผ่าน Extension มีความลื่นไหลและสะดวกสบายมากขึ้น

- **ระบบอัปเดตอัตโนมัติ (Auto-Update System)**
  - ตรวจสอบและดึงข้อมูลอัปเดตโดยตรงจาก GitHub Releases โดยผู้ใช้งานไม่ต้องติดตั้งใหม่เอง
  - ตรวจสอบเวอร์ชันใหม่หลังจากเปิดแอป 15 วินาที และทำซ้ำเบื้องหลังทุกๆ 6 ชั่วโมง
  - ดาวน์โหลดตัวอัปเดตเบื้องหลังเงียบๆ และแสดงแจ้งเตือนผ่าน Tray เมื่อกำลังดาวน์โหลด
  - แสดงกล่องข้อความถามยืนยันเมื่อดาวน์โหลดเสร็จสิ้น เพื่อเลือกว่าจะรีสตาร์ตเพื่อติดตั้งทันที หรือรอให้ติดตั้งโดยอัตโนมัติเมื่อปิดโปรแกรมครั้งถัดไป
  - เพิ่มตัวเลือก **"ตรวจสอบอัปเดต..."** ในเมนูคลิกขวาของไอคอน Tray เพื่อให้สามารถสั่งเช็คอัปเดตเองได้ตลอดเวลา
