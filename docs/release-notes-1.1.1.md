## Prism LLearn 1.1.1 — fixes

### ภาษาไทย

รุ่นแก้บั๊ก — ข้อมูลการเรียนปลอดภัยขึ้น โหลดตัวแปลได้ชัวร์ขึ้น และเปิดคลิป YouTube ได้ต่อแม้ YouTube เปลี่ยนระบบ

- **ข้อมูลไม่หาย**: ถ้าไฟล์บันทึก (คำศัพท์ บัตรคำ บทเรียน) เสียเพราะดิสก์เต็มหรือไฟดับ แอปจะใช้สำเนาสำรองล่าสุด และเก็บไฟล์ที่เสียไว้เป็น state.broken.json — ไฟล์เสียจะไม่ไปทับสำเนาสำรองที่ดีอีกต่อไป (บทเรียนแต่ละบทก็เช่นกัน)
- **โหลดตัวแปล (2.5 GB)**: ถ้าเซิร์ฟเวอร์ตอบผิดพลาด จะไม่บันทึกหน้า error ปนลงในไฟล์โมเดลอีก (เดิมอาจได้ไฟล์เสียที่แปลไม่ได้ตลอดไป) · ตรวจว่าไฟล์ครบและถูกต้องก่อนใช้ · ตรวจที่ว่างในดิสก์ก่อนเริ่ม และบอกว่า "ที่ในดิสก์ไม่พอ" แทน "โหลดไม่สำเร็จ" · เน็ตหยุดนิ่งนานเกิน 1 นาที จะหยุดให้กด "โหลดต่อ" ได้
- **YouTube**: ถ้าเปิดคลิปไม่ได้เพราะ yt-dlp เก่า แอปจะอัปเดต yt-dlp ให้เอง (ฟรี) แล้วลองใหม่อัตโนมัติ · ในตัวติดตั้งใช้ yt-dlp รุ่นใหม่ 2026.11.23 · เน็ตค้างจะแจ้งภายใน ~20 วินาที แทนการรอไม่จบ
- ถ้าไฟล์ yt-dlp หายไป บอกชัดว่าให้ติดตั้งใหม่ / ซ่อมใน Prism Hub
- ดิสก์เต็มตอนบันทึก: เตือนครั้งเดียว ไม่เด้งซ้ำทุก 5 วินาที

**วิธีอัปเดต** — กด "อัปเดต" ในแอป (หน้า ⓘ) หรือใน Prism Hub · หรือโหลด `Prism-LLearn-1.1.1-Setup.exe` / `Prism-LLearn-1.1.1-Portable.zip`

---

### English

A bug-fix release — your learning data is safer, the translator download is more reliable, and YouTube keeps working when YouTube changes.

- **No lost data**: if the save file (words, cards, lessons) gets damaged by a full disk or a power cut, the app uses the last good backup and keeps the damaged file as state.broken.json — a damaged file never overwrites the good backup any more (same for each lesson).
- **Translator download (2.5 GB)**: a server error page is never written into the model file again (before, this could leave a broken model that never translated) · the file is checked (exact size, real model file) before it is used · free disk space is checked first and the message says "not enough disk space" instead of "download failed" · a download stalled for over a minute stops so you can press "Resume".
- **YouTube**: when a video can't be read because yt-dlp is out of date, the app updates yt-dlp itself (free) and tries again · the installer ships yt-dlp 2026.11.23 · a stalled connection now reports within ~20 s instead of waiting for ever.
- If the yt-dlp file is missing, the message says to reinstall / Repair in Prism Hub.
- Full disk while saving: one warning, not a new one every 5 seconds.

**How to update** — press "Update" in the app (ⓘ page) or in Prism Hub · or download `Prism-LLearn-1.1.1-Setup.exe` / `Prism-LLearn-1.1.1-Portable.zip`.
