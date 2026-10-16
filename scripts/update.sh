#!/bin/sh
# Обновление бота до последней версии ветки. Не трогает .env (ключи и настройки) и data/ (виртуальный кошелёк, журнал).
set -e
BRANCH="claude/festive-fermat-jd4bcu"
URL="https://github.com/AXPEQ/Sniper2.0/archive/refs/heads/$BRANCH.zip"
TMP="$(mktemp -d)"
echo "⬇️  Скачиваю свежую версию…"
curl -fsSL "$URL" -o "$TMP/bot.zip"
unzip -q "$TMP/bot.zip" -d "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
cp -R "$SRC/." .
rm -rf "$TMP"
echo "📦 Ставлю зависимости…"
npm install --silent
echo "✅ Готово. Запуск: npm start"
