<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import * as LittleFS from 'partitions-tool-esp/littlefs';
import { fromFileList } from 'partitions-tool-esp/io/browser';
import type { VirtualDirectory } from 'partitions-tool-esp';
import WarningsPanel from './WarningsPanel.vue';
import {
  collectFileNames,
  downloadBinary,
  formatBytes,
  formatWarnings,
  toDownloadName,
} from '../utils/demo.js';

const { t } = useI18n();

type SubTab = 'generate' | 'parse';
const subTab = ref<SubTab>('generate');

const imageSize = ref(0x10000);
const blockSize = ref(4096);
const readSize = ref(16);
const progSize = ref(16);
const nameMax = ref(255);
const inlineMax = ref(512);
const blockCycles = ref(512);

const uploadedDir = ref<VirtualDirectory | null>(null);
const fileNames = ref<string[]>([]);
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const parsedFiles = ref<Array<{ path: string; size: number; content: Uint8Array }>>([]);
const warnings = ref<string[]>([]);
const superblock = ref<LittleFS.LittleFSSuperblock | null>(null);

const hasFiles = computed(() => uploadedDir.value !== null && fileNames.value.length > 0);

const imageSizeOptions = [
  { label: '64 KB', value: 0x10000 },
  { label: '128 KB', value: 0x20000 },
  { label: '256 KB', value: 0x40000 },
  { label: '512 KB', value: 0x80000 },
  { label: '1 MB', value: 0x100000 },
];

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  try {
    uploadedDir.value = await fromFileList(input.files);
    fileNames.value = collectFileNames(uploadedDir.value);
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function generateImage() {
  if (!uploadedDir.value) return;
  error.value = '';
  generatedBin.value = null;
  warnings.value = [];
  try {
    generatedBin.value = LittleFS.generate({
      imageSize: imageSize.value,
      blockSize: blockSize.value,
      readSize: readSize.value,
      progSize: progSize.value,
      nameMax: nameMax.value,
      inlineMax: inlineMax.value,
      blockCycles: blockCycles.value,
      source: uploadedDir.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onUploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedFiles.value = [];
  warnings.value = [];
  superblock.value = null;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const image = new Uint8Array(reader.result as ArrayBuffer);
      const result = LittleFS.parse(image, {
        blockSize: blockSize.value,
        readSize: readSize.value,
        progSize: progSize.value,
      });
      warnings.value = formatWarnings(result.warnings);
      superblock.value = result.superblock;
      parsedFiles.value = result.files.map((file) => ({
        path: file.path,
        size: file.size,
        content: file.content,
      }));
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function downloadParsedFile(file: { path: string; content: Uint8Array }) {
  downloadBinary(file.content, toDownloadName(file.path));
}
</script>

<template>
  <section class="demo-section">
    <h2>{{ t('littlefs.title') }}</h2>
    <p class="desc">{{ t('littlefs.desc') }}</p>

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
            {{ t('littlefs.imageSize') }}:
            <select v-model="imageSize" class="input-small">
              <option v-for="opt in imageSizeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label>
            {{ t('littlefs.blockSize') }}:
            <input v-model.number="blockSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.readSize') }}:
            <input v-model.number="readSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.progSize') }}:
            <input v-model.number="progSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.nameMax') }}:
            <input v-model.number="nameMax" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.inlineMax') }}:
            <input v-model.number="inlineMax" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.blockCycles') }}:
            <input v-model.number="blockCycles" type="number" class="input-small" />
          </label>
        </div>

        <div class="btn-row">
          <button class="btn primary" :disabled="!hasFiles" @click="generateImage">
            {{ t('littlefs.generateImage') }}
          </button>
          <button
            v-if="generatedBin"
            class="btn success"
            @click="downloadBinary(generatedBin, 'littlefs.bin')"
          >
            {{ t('littlefs.downloadImage') }}
            ({{ formatBytes(generatedBin.byteLength) }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('littlefs.uploadImage') }}</h3>

        <div class="options-grid" style="margin-bottom: 0.75rem">
          <label>
            {{ t('littlefs.blockSize') }}:
            <input v-model.number="blockSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.readSize') }}:
            <input v-model.number="readSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('littlefs.progSize') }}:
            <input v-model.number="progSize" type="number" class="input-small" />
          </label>
        </div>

        <label class="file-upload">
          <input type="file" accept=".bin,.img" @change="onUploadImage" />
          <span class="btn outline">{{ t('littlefs.uploadImage') }}</span>
        </label>
      </div>

      <WarningsPanel :title="t('littlefs.parsedWarnings')" :warnings="warnings" />

      <div v-if="superblock" class="result-section">
        <h3>{{ t('littlefs.superblock') }}</h3>
        <div class="kv-grid">
          <div class="kv-item">
            <span class="kv-label">{{ t('littlefs.version') }}</span>
            <code>{{ superblock.version }}</code>
          </div>
          <div class="kv-item">
            <span class="kv-label">{{ t('littlefs.blockSize') }}</span>
            <code>{{ superblock.blockSize }}</code>
          </div>
          <div class="kv-item">
            <span class="kv-label">{{ t('littlefs.blockCount') }}</span>
            <code>{{ superblock.blockCount }}</code>
          </div>
          <div class="kv-item">
            <span class="kv-label">{{ t('littlefs.nameMax') }}</span>
            <code>{{ superblock.nameMax }}</code>
          </div>
        </div>
      </div>

      <div v-if="parsedFiles.length" class="result-section">
        <h3>{{ t('littlefs.parsedFiles') }}</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>{{ t('spiffs.path') }}</th>
                <th>{{ t('spiffs.fileSize') }}</th>
                <th>{{ t('common.download') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(file, i) in parsedFiles" :key="i">
                <td>
                  <code>{{ file.path }}</code>
                </td>
                <td>{{ formatBytes(file.size) }}</td>
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
