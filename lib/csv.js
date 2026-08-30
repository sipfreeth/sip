// lib/csv.js
//
// แปลงข้อมูลเป็น CSV สำหรับ Export ดาวน์โหลด — ใส่ BOM นำหน้าให้ Excel เปิดภาษาไทยได้ถูกต้อง

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/"/g, '""');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str}"`;
  }
  return str;
}

// columns: [{ key: 'field_name', label: 'หัวคอลัมน์' }, ...]
export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvValue(typeof c.get === 'function' ? c.get(row) : row[c.key])).join(','));
  return '\uFEFF' + [header, ...lines].join('\n');
}

export function sendCsv(res, filename, csvContent) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csvContent);
}
