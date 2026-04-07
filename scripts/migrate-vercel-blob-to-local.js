/**
 * Одноразовая миграция вложений с URL Vercel Blob на локальные файлы.
 * 1) npm i @vercel/blob@2.3.3
 * 2) В .env: DATABASE_URL, BLOB_READ_WRITE_TOKEN (для приватных blob)
 * 3) node scripts/migrate-vercel-blob-to-local.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { Readable } = require('stream');
const fileStorage = require('../lib/file-storage');

let vercelGet;
try {
  vercelGet = require('@vercel/blob').get;
} catch {
  console.error('Установите: npm i @vercel/blob@2.3.3');
  process.exit(1);
}

function isVercelBlobUrl(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) && url.includes('blob.vercel-storage.com');
}

async function downloadVercelBlob(url) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Нужен BLOB_READ_WRITE_TOKEN для приватных blob');
  }
  const isPublic = url.includes('.public.blob.vercel-storage.com');
  if (isPublic) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const result = await vercelGet(url, {
    access: 'private',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error('vercel blob get failed');
  }
  const nodeStream = Readable.fromWeb(result.stream);
  const chunks = [];
  for await (const chunk of nodeStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL не задан');
    process.exit(1);
  }
  await fileStorage.ensureUploadDir();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const { rows } = await pool.query(
    `SELECT id, original_name, mimetype, url FROM attachments WHERE url LIKE 'https://%blob.vercel-storage.com%'`
  );
  console.log('Найдено записей для миграции:', rows.length);
  for (const row of rows) {
    try {
      const buffer = await downloadVercelBlob(row.url);
      const saved = await fileStorage.saveUploadedFile(row.original_name, buffer, row.mimetype);
      await pool.query(`UPDATE attachments SET url = $1, filename = $2, size = $3 WHERE id = $4`, [
        saved.url,
        saved.filename,
        saved.size,
        row.id
      ]);
      console.log('OK id', row.id, '->', saved.url);
    } catch (e) {
      console.error('FAIL id', row.id, row.url, e.message);
    }
  }
  await pool.end();
  console.log('Готово.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
