#!/usr/bin/env bash
# Restore public/assets from the downloaded part tarballs.
# Heavy art (meshes/textures/hdri/audio) is intentionally NOT in git.
#
#   bash scripts/restore-assets.sh [/path/to/folder/with/tarballs]
#   (defaults to ~/Downloads, then /mnt/c/Users/$USER/Downloads)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARTS="${1:-}"
if [ -z "$PARTS" ]; then
  for c in "$HOME/Downloads" "/mnt/c/Users/$USER/Downloads" "/mnt/c/Users/sadeg/Downloads"; do
    [ -d "$c" ] && PARTS="$c" && break
  done
fi
[ -d "${PARTS:-}" ] || { echo "Pass the folder holding the *.tar.gz parts." >&2; exit 1; }
A="$REPO/public/assets"; mkdir -p "$A/meshes" "$REPO/public"
x(){ local f; f="$(ls $PARTS/$1 2>/dev/null | head -1)"
     if [ -n "${f:-}" ]; then echo "  + $(basename "$f")"; tar -xzf "$f" --skip-old-files -C "$2"
     else echo "  ! missing: $1"; fi; }
x '*01a*wasteland*.tar.gz'   "$A/meshes"
x '*01b*hatch*.tar.gz'       "$A/meshes"
x '*01c*desert*.tar.gz'      "$A/meshes"
x '*01d*characters*.tar.gz'  "$A/meshes"
x '*02*meshes*misc*.tar.gz'  "$A/meshes"
x '*05*audio*.tar.gz'        "$A"
x '*06a1*textures*.tar.gz'   "$A"
x '*06a2*textures*.tar.gz'   "$A"
x '*06b*hdri*.tar.gz'        "$A"
x '*06c*public*misc*.tar.gz' "$REPO/public"
for f in $PARTS/*04*amara*.tar.gz; do [ -e "$f" ] && { echo "  + $(basename "$f")"; tar -xzf "$f" --skip-old-files -C "$A/meshes"; }; done
if ls $PARTS/*03*polyhaven*.tar.gz >/dev/null 2>&1; then
  mkdir -p "$A/meshes/polyhaven"
  for f in $PARTS/*03*polyhaven*.tar.gz; do echo "  + $(basename "$f")"; tar -xzf "$f" --skip-old-files -C "$A/meshes/polyhaven"; done
fi
# The code loads PBR packs from /assets/textures/<material>/ — normalize if they
# landed one level up.
mkdir -p "$A/textures"
for m in asphalt carbon carpaint concrete dirt gravel metal paint plastic rock rust sand scrap_panel; do
  [ -d "$A/$m" ] && mv "$A/$m" "$A/textures/$m"
done
echo "Done: $(du -sh "$A" | cut -f1) in public/assets"
