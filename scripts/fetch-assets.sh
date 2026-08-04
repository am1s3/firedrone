#!/usr/bin/env bash
# Тянет CC0-ассеты в билде. Если источник сдох — просто пропускаем,
# рантайм упадёт в процедурные fallback'и и не заметит.
set -u

mkdir -p public/sounds public/env

UA="Mozilla/5.0 (X11; Linux x86_64) FPV1UltraBuild/1.0"

grab() {
  # $1 = url, $2 = out
  curl -fsSL --retry 2 --max-time 90 -A "$UA" -o "$2" "$1" || { rm -f "$2"; return 1; }
  [ -s "$2" ] || { rm -f "$2"; return 1; }
  return 0
}

page_mp3() {
  # $1 = страница bigsoundbank, вытаскиваем первый mp3 из <audio>/download
  curl -fsSL --retry 2 --max-time 30 -A "$UA" "$1" \
    | grep -oE 'https?://[^"'"'"' >]+\.mp3' \
    | head -n 1 || true
}

# --- Мотор: реальный маленький квадрик, CC0 (BigSoundBank) ---
if [ ! -s public/sounds/motor.mp3 ]; then
  URL="$(page_mp3 https://bigsoundbank.com/drone-2-s3546.html)"
  if [ -n "$URL" ]; then
    grab "$URL" public/sounds/motor.mp3 && echo "[assets] motor.mp3 OK" || echo "[assets] motor.mp3 FAIL"
  else
    echo "[assets] motor.mp3 URL not found"
  fi
fi

# --- Взрыв: CC0 (BigSoundBank) ---
if [ ! -s public/sounds/explosion.mp3 ]; then
  URL="$(page_mp3 https://bigsoundbank.com/explosion-2-s1808.html)"
  if [ -n "$URL" ]; then
    grab "$URL" public/sounds/explosion.mp3 && echo "[assets] explosion.mp3 OK" || echo "[assets] explosion.mp3 FAIL"
  else
    echo "[assets] explosion.mp3 URL not found"
  fi
fi

# --- Ветер: CC0 (BigSoundBank), опционально ---
if [ ! -s public/sounds/wind.mp3 ]; then
  URL="$(page_mp3 https://bigsoundbank.com/wind-s3520.html)"
  if [ -n "$URL" ]; then
    grab "$URL" public/sounds/wind.mp3 && echo "[assets] wind.mp3 OK" || echo "[assets] wind.mp3 FAIL"
  else
    echo "[assets] wind.mp3 URL not found"
  fi
fi

# --- HDR-небо: CC0 (Poly Haven), 1k puresky ---
if [ ! -s public/env/sky_1k.hdr ]; then
  grab "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr" public/env/sky_1k.hdr \
    && echo "[assets] sky_1k.hdr OK" || echo "[assets] sky_1k.hdr FAIL"
fi

echo "[assets] done"
exit 0
