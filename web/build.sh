#!/usr/bin/env bash
# Сборка витрины: подстановка адреса API вместо плейсхолдера.
set -e

if [ -z "$API_URL" ] && [ -n "$API_HOST" ]; then
  API_URL="https://${API_HOST}.onrender.com"
  echo "API_URL собран из API_HOST: $API_URL"
fi
echo "API_URL=${API_URL:-НЕ ЗАДАН}"

safe_replace() {
  local placeholder="$1" value="$2" file="$3"
  if [ -f "$file" ] && [ -n "$value" ]; then
    local escaped
    escaped=$(printf '%s\n' "$value" | sed 's/[&/\]/\\&/g')
    sed -i "s|${placeholder}|${escaped}|g" "$file"
    echo "  → $file"
  fi
}

cp index.template.html index.html
safe_replace "__API_URL__" "$API_URL" "index.html"
echo "Сборка завершена."
