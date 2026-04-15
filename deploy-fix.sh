#!/bin/bash
set -e

echo "=== Поиск приложения ==="
APP_PATH=$(find /var/www /root /home -name "package.json" -path "*task*" 2>/dev/null | head -1 | xargs dirname)
if [ -z "$APP_PATH" ]; then
    APP_PATH="/var/www/task-manager"
fi
echo "Найдено: $APP_PATH"

cd "$APP_PATH"

echo "=== Обновление кода ==="
git pull origin master

echo "=== Проверка .env ==="
if ! grep -q "MAX_UPLOAD_MB=500" .env 2>/dev/null; then
    sed -i 's/MAX_UPLOAD_MB=.*/MAX_UPLOAD_MB=500/' .env 2>/dev/null || echo "MAX_UPLOAD_MB=500" >> .env
    echo "✓ MAX_UPLOAD_MB=500 установлено"
fi

echo "=== Настройка Nginx ==="
NGINX_CONF="/etc/nginx/sites-enabled/default"
if [ -f "$NGINX_CONF" ]; then
    # Увеличиваем лимит тела
    if ! grep -q "client_max_body_size 500m" "$NGINX_CONF"; then
        sed -i '/server {/a \    client_max_body_size 500m;' "$NGINX_CONF"
    fi
    
    # Увеличиваем таймауты
    if ! grep -q "proxy_read_timeout 600" /etc/nginx/nginx.conf; then
        sed -i '/http {/a \    proxy_connect_timeout 600s;\n    proxy_send_timeout 600s;\n    proxy_read_timeout 600s;' /etc/nginx/nginx.conf
    fi
    
    nginx -t && systemctl reload nginx
    echo "✓ Nginx настроен"
fi

echo "=== Перезапуск приложения ==="
if command -v pm2 &> /dev/null; then
    pm2 restart all --update-env
    pm2 save
    echo "✓ PM2 перезапущен"
elif systemctl list-units --type=service | grep -q "task-manager"; then
    systemctl restart task-manager
    echo "✓ Systemd сервис перезапущен"
else
    echo "! Не удалось автоматически перезапустить - сделай вручную"
fi

echo ""
echo "=== Готово! Попробуй загрузить файл снова. ==="
