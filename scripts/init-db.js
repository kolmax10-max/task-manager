const { initDB } = require('../db');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL не задан. Укажите строку подключения PostgreSQL в .env в корне проекта\n' +
        '(например postgres://user:pass@127.0.0.1:5432/dbname).'
    );
    process.exit(1);
  }

  await initDB();
  console.log('Готово: таблицы users / tasks / attachments созданы; при отсутствии учётки создан superuser.');
}

main().catch((e) => {
  console.error('Ошибка инициализации БД:', e.message);
  process.exit(1);
});
