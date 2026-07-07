<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import * as SPIFFS from 'partitions-tool-esp/spiffs';
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
const pageSize = ref(256);
const blockSize = ref(4096);
const objNameLen = ref(32);
const metaLen = ref(4);
const useMagic = ref(true);
const useMagicLength = ref(true);

const uploadedDir = ref<VirtualDirectory | null>(null);
const fileNames = ref<string[]>([]);
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const warnings = ref<string[]>([]);
const parsedFiles = ref<Array<{ path: string; size: number; content: Uint8Array }>>([]);

const imageSizeOptions = [
  { label: '64 KB', value: 0x10000 },
  { label: '128 KB', value: 0x20000 },
  { label: '256 KB', value: 0x40000 },
  { label: '512 KB', value: 0x80000 },
  { label: '1 MB', value: 0x100000 },
];

const hasFiles = computed(() => uploadedDir.value !== null && fileNames.value.length > 0);

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
    generatedBin.value = SPIFFS.generate({
      imageSize: imageSize.value,
      pageSize: pageSize.value,
      blockSize: blockSize.value,
      objNameLen: objNameLen.value,
      metaLen: metaLen.value,
      useMagic: useMagic.value,
      useMagicLength: useMagicLength.value,
      source: uploadedDir.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function downloadImage() {
  if (!generatedBin.value) return;
  downloadBinary(generatedBin.value, 'spiffs.bin');
}

function onUploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedFiles.value = [];
  warnings.value = [];

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bin = new Uint8Array(reader.result as ArrayBuffer);
      const result = SPIFFS.parse(bin, {
        pageSize: pageSize.value,
        objNameLen: objNameLen.value,
        metaLen: metaLen.value,
      });
      warnings.value = formatWarnings(result.warnings);
      parsedFiles.value = result.files.map((f) => ({
        path: f.path,
        size: f.size,
        content: f.content,
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
    <h2>{{ t('spiffs.title') }}</h2>
    <p class="desc">{{ t('spiffs.desc') }}</p>

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
            {{ t('spiffs.imageSize') }}:
            <select v-model="imageSize" class="input-small">
              <option v-for="opt in imageSizeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label>
            {{ t('spiffs.pageSize') }}:
            <input v-model.number="pageSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('spiffs.blockSize') }}:
            <input v-model.number="blockSize" type="number" class="input-small" />
          </label>
          <label>
            {{ t('spiffs.objNameLen') }}:
            <input v-model.number="objNameLen" type="number" class="input-small" />
          </label>
          <label>
            {{ t('spiffs.metaLen') }}:
            <input v-model.number="metaLen" type="number" class="input-small" />
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="useMagic" />
            {{ t('spiffs.useMagic') }}
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="useMagicLength" />
            {{ t('spiffs.useMagicLength') }}
          </label>
        </div>

        <div class="btn-row">
          <button class="btn primary" :disabled="!hasFiles" @click="generateImage">
            {{ t('spiffs.generateImage') }}
          </button>
          <button v-if="generatedBin" class="btn success" @click="downloadImage">
            {{ t('spiffs.downloadImage') }}
            ({{ formatBytes(generatedBin.byteLength) }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('spiffs.uploadImage') }}</h3>
        <label class="file-upload">
          <input type="file" accept=".bin,.img" @change="onUploadImage" />
          <span class="btn outline">{{ t('spiffs.uploadImage') }}</span>
        </label>
      </div>

      <WarningsPanel :title="t('spiffs.parsedWarnings')" :warnings="warnings" />

      <div v-if="parsedFiles.length" class="result-section">
        <h3>{{ t('spiffs.parsedFiles') }}</h3>
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
