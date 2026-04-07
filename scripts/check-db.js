require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('postgresql://...') || url.includes('USER:PASSWORD')) {
    console.error(
      'DATABASE_URL не задан или это заглушка из .env.example.\n' +
        'Создайте task-manager/.env с строкой подключения PostgreSQL.'
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query('SELECT current_database() AS database, version() AS pg_version');
    console.log('Подключение к PostgreSQL успешно.');
    console.log(' База:', rows[0].database);
    console.log(' Версия:', rows[0].pg_version.split('\n')[0]);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Ошибка подключения:', e.message);
  process.exit(1);
});
