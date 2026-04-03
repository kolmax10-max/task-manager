const { initDB } = require('../db');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL не задан. Укажите строку подключения Neon в файле .env в корне проекта\n' +
        'или в переменных окружения (скопируйте из Neon → Connection string, ветка production).'
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
