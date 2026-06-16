<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import * as FatFS from 'partitions-tool-esp/fatfs';
import { fromFileList } from 'partitions-tool-esp/io/browser';
import type { VirtualDirectory } from 'partitions-tool-esp';

const { t } = useI18n();

type SubTab = 'generate' | 'parse';
const subTab = ref<SubTab>('generate');

const partitionSize = ref(512 * 1024);
const sectorSize = ref(4096);
const fatType = ref<0 | 12 | 16 | 32>(0);
const longFilenames = ref(true);
const wearLeveling = ref(false);
const wlMode = ref<'perf' | 'safe'>('perf');

const uploadedDir = ref<VirtualDirectory | null>(null);
const fileNames = ref<string[]>([]);
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const parsedFiles = ref<Array<{ path: string; size: number; content: Uint8Array }>>([]);

const sizeOptions = [
  { label: '128 KB', value: 128 * 1024 },
  { label: '256 KB', value: 256 * 1024 },
  { label: '512 KB', value: 512 * 1024 },
  { label: '1 MB', value: 1024 * 1024 },
  { label: '2 MB', value: 2 * 1024 * 1024 },
  { label: '4 MB', value: 4 * 1024 * 1024 },
];

const hasFiles = computed(() => uploadedDir.value !== null && fileNames.value.length > 0);

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  try {
    uploadedDir.value = await fromFileList(input.files);
    uploadedDir.value.name = '';
    fileNames.value = collectFileNames(uploadedDir.value);
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function collectFileNames(dir: VirtualDirectory, prefix = ''): string[] {
  const names: string[] = [];
  for (const child of dir.children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.kind === 'file') {
      names.push(path);
    } else {
      names.push(...collectFileNames(child, path));
    }
  }
  return names;
}

function generateImage() {
  if (!uploadedDir.value) return;
  error.value = '';
  generatedBin.value = null;
  try {
    const opts: Parameters<typeof FatFS.generate>[0] = {
      size: partitionSize.value,
      source: uploadedDir.value,
      sectorSize: wearLeveling.value ? FatFS.WL_SECTOR_SIZE : sectorSize.value,
      longFilenames: longFilenames.value,
    };
    if (fatType.value !== 0) {
      opts.explicitFatType = fatType.value;
    }
    if (wearLeveling.value) {
      opts.wearLeveling = { mode: wlMode.value };
    }
    generatedBin.value = FatFS.generate(opts);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function downloadImage() {
  if (!generatedBin.value) return;
  download(generatedBin.value, 'fatfs.img');
}

function onUploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedFiles.value = [];

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bin = new Uint8Array(reader.result as ArrayBuffer);
      const result = FatFS.parse(bin, {
        wearLeveling: wearLeveling.value ? wlMode.value : false,
      });
      parsedFiles.value = FatFS.flatten(result.root).map((f) => ({
        path: f.path,
        size: f.content.byteLength,
        content: f.content,
      }));
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function download(data: Uint8Array, filename: string) {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadParsedFile(file: { path: string; content: Uint8Array }) {
  download(file.content, toDownloadName(file.path));
}

function toDownloadName(path: string): string {
  return path.replace(/[\\/]/g, '__') || 'file.bin';
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
</script>

<template>
  <section class="demo-section">
    <h2>{{ t('fatfs.title') }}</h2>
    <p class="desc">{{ t('fatfs.desc') }}</p>

    <div class="sub-tabs">
      <button :class="['sub-tab', { active: subTab === 'generate' }]" @click="subTab = 'generate'">
        {{ t('common.generate') }}
      </button>
      <button :class="['sub-tab', { active: subTab === 'parse' }]" @click="subTab = 'parse'">
        {{ t('common.parse') }}
      </button>
    </div>

    <div v-if="subTab === 'generate'" class="tab-content">
      <div class="panel">
        <label class="file-upload">
          <input type="file" webkitdirectory multiple @change="onFilesSelected" />
          <span class="btn outline">{{ t('common.uploadDir') }}</span>
        </label>

        <div v-if="fileNames.length" class="file-list">
          <p>{{ t('common.files') }} ({{ fileNames.length }}):</p>
          <ul>
            <li v-for="name in fileNames.slice(0, 20)" :key="name">
              <code>{{ name }}</code>
            </li>
            <li v-if="fileNames.length > 20">... +{{ fileNames.length - 20 }}</li>
          </ul>
        </div>
        <p v-else class="muted">{{ t('common.noFiles') }}</p>

        <div class="options-grid">
          <label>
            {{ t('fatfs.partitionSize') }}:
            <select v-model="partitionSize" class="input-small">
              <option v-for="opt in sizeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label>
            {{ t('fatfs.sectorSize') }}:
            <select v-model="sectorSize" class="input-small" :disabled="wearLeveling">
              <option :value="512">512</option>
              <option :value="4096">4096</option>
            </select>
          </label>
          <label>
            {{ t('fatfs.fatType') }}:
            <select v-model="fatType" class="input-small">
              <option :value="0">{{ t('fatfs.fatTypeAuto') }}</option>
              <option :value="12">FAT12</option>
              <option :value="16">FAT16</option>
              <option :value="32">FAT32</option>
            </select>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="longFilenames" />
            {{ t('fatfs.longFilenames') }}
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="wearLeveling" />
            {{ t('fatfs.wearLeveling') }}
          </label>
          <label v-if="wearLeveling">
            {{ t('fatfs.wlMode') }}:
            <select v-model="wlMode" class="input-small">
              <option value="perf">perf</option>
              <option value="safe">safe</option>
            </select>
          </label>
        </div>

        <div class="btn-row">
          <button class="btn primary" :disabled="!hasFiles" @click="generateImage">
            {{ t('fatfs.generateImage') }}
          </button>
          <button v-if="generatedBin" class="btn success" @click="downloadImage">
            {{ t('fatfs.downloadImage') }}
            ({{ formatSize(generatedBin.byteLength) }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('fatfs.uploadImage') }}</h3>

        <div class="options-row" style="margin-bottom: 0.75rem">
          <label class="checkbox-label">
            <input type="checkbox" v-model="wearLeveling" />
            {{ t('fatfs.wearLeveling') }}
          </label>
          <label v-if="wearLeveling">
            {{ t('fatfs.wlMode') }}:
            <select v-model="wlMode" class="input-small">
              <option value="perf">perf</option>
              <option value="safe">safe</option>
            </select>
          </label>
        </div>

        <label class="file-upload">
          <input type="file" accept=".bin,.img" @change="onUploadImage" />
          <span class="btn outline">{{ t('fatfs.uploadImage') }}</span>
        </label>
      </div>

      <div v-if="parsedFiles.length" class="result-section">
        <h3>{{ t('fatfs.parsedFiles') }}</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>{{ t('fatfs.path') }}</th>
                <th>{{ t('fatfs.fileSize') }}</th>
                <th>{{ t('common.download') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(file, i) in parsedFiles" :key="i">
                <td>
                  <code>{{ file.path }}</code>
                </td>
                <td>{{ formatSize(file.size) }}</td>
                <td>
                  <button class="btn outline" @click="downloadParsedFile(file)">
                    {{ t('common.download') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ t('common.error') }}: {{ error }}</div>
  </section>
</template>
