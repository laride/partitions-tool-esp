#!/usr/bin/env bash
# Regenerate all golden fixtures under tests/fixtures by invoking the canonical
# ESP-IDF Python tooling. The idea is: whenever the upstream format or defaults
# change, re-run this script, re-run `pnpm test`, and fix any resulting diffs.
#
# Requirements:
#   - source <IDF_PATH>/export.sh beforehand (so python3 resolves to the IDF venv)
#   - IDF_PATH must point at a checked-out esp-idf tree
#
# Environment overrides:
#   IDF_PATH       Path to esp-idf (defaults to $IDF_PATH)
#   OUT            Output directory (defaults to tests/fixtures relative to the repo root)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
OUT="${OUT:-$repo_root/tests/fixtures}"

if [[ -z "${IDF_PATH:-}" ]]; then
  echo "error: IDF_PATH is not set. Please source <IDF_PATH>/export.sh first." >&2
  exit 1
fi

if [[ ! -d "$IDF_PATH" ]]; then
  echo "error: IDF_PATH '$IDF_PATH' does not exist" >&2
  exit 1
fi

GEN_ESP32PART="$IDF_PATH/components/partition_table/gen_esp32part.py"
FATFSGEN="$IDF_PATH/components/fatfs/fatfsgen.py"
SPIFFSGEN="$IDF_PATH/components/spiffs/spiffsgen.py"
NVS_GEN="$IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py"

for tool in "$GEN_ESP32PART" "$FATFSGEN" "$SPIFFSGEN" "$NVS_GEN"; do
  if [[ ! -f "$tool" ]]; then
    echo "error: missing tool $tool" >&2
    exit 1
  fi
done

mkdir -p "$OUT"

echo "[partition-table] singleapp"
python3 "$GEN_ESP32PART" --flash-size 4MB "$OUT/partitions_singleapp.csv" "$OUT/partitions_singleapp.bin"

echo "[partition-table] two_ota"
python3 "$GEN_ESP32PART" --flash-size 4MB "$OUT/partitions_two_ota.csv" "$OUT/partitions_two_ota.bin"

echo "[nvs] basic"
python3 "$NVS_GEN" generate "$OUT/nvs_basic.csv" "$OUT/nvs_basic.bin" 0x6000

echo "[nvs] multipage"
python3 "$NVS_GEN" generate "$OUT/nvs_multipage.csv" "$OUT/nvs_multipage.bin" 0x6000

echo "[spiffs] basic"
python3 "$SPIFFSGEN" 0x00010000 "$OUT/spiffs_src" "$OUT/spiffs_basic.bin" \
  --page-size 256 --obj-name-len 32 --meta-len 4 --use-magic --use-magic-len

echo "[fatfs] basic"
python3 "$FATFSGEN" "$OUT/fatfs_src" \
  --output_file "$OUT/fatfs_basic.img" \
  --partition_size 524288 --use_default_datetime

if [[ -d "$OUT/fatfs_nested" ]]; then
  echo "[fatfs] nested"
  python3 "$FATFSGEN" "$OUT/fatfs_nested" \
    --output_file "$OUT/fatfs_nested.img" \
    --partition_size 524288 --use_default_datetime
fi

echo "All fixtures regenerated into $OUT"
echo "Note: FatFS images embed a random BS_VolID (offset 39, 4 bytes LE)."
echo "      The test harness reads it from each golden image before comparing."
