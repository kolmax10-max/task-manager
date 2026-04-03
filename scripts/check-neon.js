require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { neon } = require('@neondatabase/serverless');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('postgresql://...')) {
    console.error(
      'DATABASE_URL не задан или это заглушка из .env.example.\n' +
        'Создайте файл task-manager/.env, скопируйте из .env.example и вставьте строку подключения из консоли Neon (Connection string).'
    );
    process.exit(1);
  }

  const sql = neon(url);
  const rows = await sql`SELECT current_database() AS database, current_setting('server_version') AS pg_version`;
  console.log('Подключение к Neon успешно.');
  console.log(' База:', rows[0].database);
  console.log(' PostgreSQL:', rows[0].pg_version);
}

main().catch((e) => {
  console.error('Ошибка подключения к Neon:', e.message);
  process.exit(1);
});
