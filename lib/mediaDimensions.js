// lib/mediaDimensions.js
//
// อ่านขนาด (Width x Height) จากไฟล์ภาพ/วิดีโอโดยตรงจาก Buffer — เขียนเองล้วนๆ ไม่พึ่ง npm package ภายนอก
// (กันปัญหา Deploy พังแบบที่เคยเจอกับ web-push ก่อนหน้านี้)
//
// รองรับ: JPEG, PNG (ภาพ) และ MP4 (วิดีโอ — อ่านจาก moov/trak/tkhd box)

// ---------- ภาพ: PNG ----------
function getPngDimensions(buf) {
  // PNG: 8-byte signature แล้วตามด้วย IHDR chunk ทันที — width ที่ byte 16-19, height ที่ 20-23 (big-endian)
  if (buf.length < 24) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ---------- ภาพ: JPEG ----------
function getJpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // ต้องขึ้นต้นด้วย SOI marker

  let offset = 2;
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF markers ที่มีข้อมูลขนาดภาพ (ข้าม SOF4/SOF8/SOF12 ที่ไม่ใช่ขนาดจริง)
    const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // marker ที่ไม่มี length ตามหลัง
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}

export function getImageDimensions(buf) {
  return getPngDimensions(buf) || getJpegDimensions(buf);
}

// ---------- วิดีโอ: MP4 (อ่านจาก moov > trak > tkhd) ----------
function findBox(buf, type, start, end) {
  let offset = start;
  while (offset < end - 8) {
    const size = buf.readUInt32BE(offset);
    const boxType = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8) break; // กันลูปไม่รู้จบถ้าเจอไฟล์ผิดปกติ
    if (boxType === type) {
      return { start: offset + 8, end: offset + size };
    }
    offset += size;
  }
  return null;
}

function readTkhdDimensions(buf, start, end) {
  const version = buf[start];
  // offset ก่อนถึง width/height ต่างกันตาม version (0 = ฟิลด์เวลาเป็น 32-bit / 1 = เป็น 64-bit)
  const widthOffset = start + (version === 1 ? 88 : 76);
  if (widthOffset + 8 > end) return null;
  // width/height เป็น 16.16 fixed-point — เอาแค่ 2 byte แรก (จำนวนเต็ม) พอ
  const width = buf.readUInt16BE(widthOffset);
  const height = buf.readUInt16BE(widthOffset + 4);
  if (width === 0 || height === 0) return null; // มักเป็น track เสียง ไม่ใช่ track ภาพ
  return { width, height };
}

export function getMp4Dimensions(buf) {
  try {
    const moov = findBox(buf, 'moov', 0, buf.length);
    if (!moov) return null;

    // มีได้หลาย trak (ภาพ/เสียง) — วนหาอันแรกที่มี width/height ไม่เป็น 0 (คือ track ภาพ)
    let offset = moov.start;
    while (offset < moov.end - 8) {
      const size = buf.readUInt32BE(offset);
      const boxType = buf.toString('ascii', offset + 4, offset + 8);
      if (size < 8) break;
      if (boxType === 'trak') {
        const tkhd = findBox(buf, 'tkhd', offset + 8, offset + size);
        if (tkhd) {
          const dims = readTkhdDimensions(buf, tkhd.start, tkhd.end);
          if (dims) return dims;
        }
      }
      offset += size;
    }
    return null;
  } catch {
    // ไฟล์ MP4 มีหลายรูปแบบย่อย (Fragmented, Variant Codec ฯลฯ) — ถ้า parse ไม่ได้ ให้คืน null
    // แทนที่จะโยน Error ทำให้ทั้งระบบพัง (ฝั่ง Caller จะตัดสินใจว่าจะปล่อยผ่านหรือปฏิเสธ)
    return null;
  }
}

// ---------- ตรวจสอบว่าตรงอัตราส่วน 16:9 หรือไม่ (มีระยะผ่อนปรนเล็กน้อย กันไฟล์จริงที่ปัดเศษพิกเซลนิดหน่อย) ----------
const TARGET_RATIO = 16 / 9;
const RATIO_TOLERANCE = 0.05; // ผ่อนปรน ±5%

export function isRatio16x9(width, height) {
  if (!width || !height) return true; // หาขนาดไม่ได้ ไม่ปฏิเสธ (กันบล็อกไฟล์ถูกต้องเพราะ Parser จำกัด)
  const ratio = width / height;
  return Math.abs(ratio - TARGET_RATIO) <= TARGET_RATIO * RATIO_TOLERANCE;
}
