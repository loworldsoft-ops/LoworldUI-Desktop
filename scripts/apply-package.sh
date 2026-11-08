#!/bin/sh
# 팩토리의 묶음을 이 데스크톱 셸(LoworldUI-Desktop)에 넣는다.
#   scripts/apply-package.sh <묶음 폴더>
# 묶음 폴더에는 www.zip과 app.native.json이 있다(scripts/package-native.mjs 또는 scripts/package-novel.mjs가 만든다).
set -eu

src="${1:?묶음 폴더를 준다. 예: scripts/apply-package.sh ../dist/package/novel-cheonma}"
root="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="$root/app"

[ -f "$src/www.zip" ] || { echo "www.zip이 없다: $src" >&2; exit 1; }
[ -f "$src/app.native.json" ] || { echo "app.native.json이 없다: $src" >&2; exit 1; }

rm -rf "$app_dir/www"
mkdir -p "$app_dir/www"
unzip -q "$src/www.zip" -d "$app_dir/www"
# 묶음의 파일에는 날짜가 없다(결정론적 zip). 빌드 도구가 바뀐 파일을 인식하도록 현재 시각을 찍는다.
find "$app_dir/www" -type f -exec touch {} +
cp "$src/app.native.json" "$app_dir/app.native.json"

if [ -f "$src/icon.png" ]; then
  cp "$src/icon.png" "$app_dir/icon.png"
fi

echo "넣었다(Desktop): $(grep -o '"appId": *"[^"]*"' "$app_dir/app.native.json")"
