#!/usr/bin/env bash
# Сборка витрины, кабинета и юридических страниц в web/dist.
# Оформление и метки для поисковиков — из конфигурации (api/lib/site.js).
set -e
cd "$(dirname "$0")"

if [ -z "$API_URL" ] && [ -n "$API_HOST" ]; then
  API_URL="https://${API_HOST}.onrender.com"
  echo "API_URL собран из API_HOST: $API_URL"
fi
echo "API_URL=${API_URL:-НЕ ЗАДАН}"

API_URL="$API_URL" node ../api/scripts/build-web.js
