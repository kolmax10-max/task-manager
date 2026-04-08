/**
 * Multer/busboy передаёт имя файла в multipart так, что UTF-8 байты часто
 * интерпретируются по одному как Latin-1 — в итоге «кракозябры» вместо кириллицы.
 * Если все «символы» укладываются в один байт (0–255), пробуем перекодировать.
 */
function normalizeUploadFilename(name) {
  if (name == null) return 'file';
  if (typeof name !== 'string') return 'file';
  const trimmed = name.trim();
  if (!trimmed) return 'file';

  const allSingleByte = [...trimmed].every((ch) => ch.codePointAt(0) <= 255);
  if (!allSingleByte) return trimmed;

  try {
    const fixed = Buffer.from(trimmed, 'latin1').toString('utf8');
    if (fixed.includes('\uFFFD')) return trimmed;
    return fixed;
  } catch {
    return trimmed;
  }
}

module.exports = { normalizeUploadFilename };
