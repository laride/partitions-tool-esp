<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import * as NVS from 'partitions-tool-esp/nvs';

const { t } = useI18n();

type SubTab = 'generate' | 'parse';
const subTab = ref<SubTab>('generate');

type InputMode = 'csv' | 'object';
const mode = ref<InputMode>('csv');

const csvInput = ref(`key,type,encoding,value
storage,namespace,,
greeting,data,string,hello world
counter,data,u32,42
`);

const objectInput = ref(`{
  "storage": {
    "greeting": "hello world",
    "counter": 42
  }
}`);

const partitionSize = ref('0x6000');
const nvsVersion = ref<1 | 2>(2);
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const parsedPages = ref<
  Array<{
    index: number;
    entries: Array<{
      key: string;
      type: string;
      state: string;
      data: string;
    }>;
  }>
>([]);

function generateBinary() {
  error.value = '';
  generatedBin.value = null;
  try {
    const size = parseInt(partitionSize.value, 16) || 0x6000;
    let entries: NVS.NvsEntryDef[];
    if (mode.value === 'csv') {
      entries = NVS.parseCSV(csvInput.value);
    } else {
      const obj = JSON.parse(objectInput.value) as Record<string, Record<string, unknown>>;
      entries = NVS.fromObject(obj as Parameters<typeof NVS.fromObject>[0]);
    }
    generatedBin.value = NVS.generate(entries, { size, version: nvsVersion.value });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function downloadBin() {
  if (!generatedBin.value) return;
  download(generatedBin.value, 'nvs.bin');
}

function onUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedPages.value = [];

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bin = new Uint8Array(reader.result as ArrayBuffer);
      const dump = NVS.parse(bin);
      parsedPages.value = dump.pages
        .map((page, index) => ({
          index,
          entries: page.entries
            .filter((e) => e.state === 'Written')
            .map((e) => ({
              key: e.key,
              type: e.type !== undefined ? (NVS.ITEM_TYPE_NAME[e.type] ?? String(e.type)) : '?',
              state: e.state,
              data: formatData(e.data),
            })),
        }))
        .filter((p) => p.entries.length > 0);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function formatData(data: unknown): string {
  if (data instanceof Uint8Array) {
    if (data.byteLength <= 32) {
      return Array.from(data)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    }
    return `[${data.byteLength} bytes]`;
  }
  if (typeof data === 'bigint') return data.toString();
  if (typeof data === 'object' && data !== null) return JSON.stringify(data);
  return String(data ?? '');
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
</script>

<template>
  <section class="demo-section">
    <h2>{{ t('nvs.title') }}</h2>
    <p class="desc">{{ t('nvs.desc') }}</p>

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
        <div class="mode-switch">
          <label>{{ t('nvs.mode') }}:</label>
          <button :class="['btn small', { active: mode === 'csv' }]" @click="mode = 'csv'">
            {{ t('nvs.csvMode') }}
          </button>
          <button :class="['btn small', { active: mode === 'object' }]" @click="mode = 'object'">
            {{ t('nvs.objectMode') }}
          </button>
        </div>

        <textarea
          v-if="mode === 'csv'"
          v-model="csvInput"
          class="code-input"
          rows="8"
          spellcheck="false"
        />
        <textarea v-else v-model="objectInput" class="code-input" rows="8" spellcheck="false" />

        <div class="options-row">
          <label>
            {{ t('nvs.partitionSize') }}:
            <input v-model="partitionSize" class="input-small" />
          </label>
          <label>
            {{ t('nvs.version') }}:
            <select v-model="nvsVersion" class="input-small">
              <option :value="1">v1</option>
              <option :value="2">v2</option>
            </select>
          </label>
        </div>

        <div class="btn-row">
          <button class="btn primary" @click="generateBinary">
            {{ t('nvs.generateBin') }}
          </button>
          <button v-if="generatedBin" class="btn success" @click="downloadBin">
            {{ t('nvs.downloadBin') }}
            ({{ generatedBin.byteLength }} {{ t('common.bytes') }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('nvs.uploadBin') }}</h3>
        <label class="file-upload">
          <input type="file" accept=".bin" @change="onUpload" />
          <span class="btn outline">{{ t('nvs.uploadBin') }}</span>
        </label>
      </div>

      <div v-if="parsedPages.length" class="result-section">
        <div v-for="page in parsedPages" :key="page.index" class="page-block">
          <h3>{{ t('nvs.pageInfo', { index: page.index }) }}</h3>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{{ t('nvs.entryKey') }}</th>
                  <th>{{ t('nvs.entryType') }}</th>
                  <th>{{ t('nvs.entryState') }}</th>
                  <th>{{ t('nvs.entryData') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(entry, i) in page.entries" :key="i">
                  <td>
                    <code>{{ entry.key }}</code>
                  </td>
                  <td>{{ entry.type }}</td>
                  <td>
                    <span class="badge written">{{ entry.state }}</span>
                  </td>
                  <td>
                    <code>{{ entry.data }}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ t('common.error') }}: {{ error }}</div>
  </section>
</template>
