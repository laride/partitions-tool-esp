<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import * as NVS from 'partitions-tool-esp/nvs';
import WarningsPanel from './WarningsPanel.vue';
import { bytesToHex, downloadBinary, formatWarnings, hexToBytes } from '../utils/demo.js';

const { t } = useI18n();

type SubTab = 'generate' | 'parse';
type InputMode = 'csv' | 'object';

const subTab = ref<SubTab>('generate');
const mode = ref<InputMode>('csv');

const csvInput = ref(`key,type,encoding,value
storage,namespace,,
greeting,data,string,hello world
counter,data,u32,42
ratio,data,float,1.5
`);

const objectInput = ref(`{
  "storage": {
    "greeting": "hello world",
    "counter": 42,
    "blob": {
      "type": "binary",
      "value": "deadbeef",
      "encoding": "hex2bin"
    }
  },
  "settings": {
    "enabled": {
      "type": "u8",
      "value": 1
    }
  }
}`);

const partitionSize = ref('0x6000');
const nvsVersion = ref<1 | 2>(2);
const encryptOutput = ref(false);
const encryptionKeyHex = ref(bytesToHex(NVS.generateNvsKey()));
const decryptionKeyHex = ref('');
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const generatedKeyPartition = ref<Uint8Array | null>(null);
const warnings = ref<string[]>([]);
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

function currentEncryptionKey(): NVS.NvsEncryptionKey {
  const key = hexToBytes(encryptionKeyHex.value);
  if (key.length !== NVS.NVS_XTS_KEY_SIZE) {
    throw new Error(
      `NVS encryption key must be ${NVS.NVS_XTS_KEY_SIZE} bytes (${NVS.NVS_XTS_KEY_SIZE * 2} hex chars)`,
    );
  }
  return key as NVS.NvsEncryptionKey;
}

function parseDecryptionKey(): NVS.NvsEncryptionKey | undefined {
  if (!decryptionKeyHex.value.trim()) return undefined;
  const key = hexToBytes(decryptionKeyHex.value);
  if (key.length !== NVS.NVS_XTS_KEY_SIZE) {
    throw new Error(
      `NVS decryption key must be ${NVS.NVS_XTS_KEY_SIZE} bytes (${NVS.NVS_XTS_KEY_SIZE * 2} hex chars)`,
    );
  }
  return key as NVS.NvsEncryptionKey;
}

function regenerateKey() {
  encryptionKeyHex.value = bytesToHex(NVS.generateNvsKey());
}

function generateBinary() {
  error.value = '';
  generatedBin.value = null;
  generatedKeyPartition.value = null;
  warnings.value = [];
  try {
    const size = Number.parseInt(partitionSize.value, 16) || 0x6000;
    let entries: NVS.NvsEntryDef[];
    if (mode.value === 'csv') {
      entries = NVS.parseCSV(csvInput.value);
    } else {
      const obj = JSON.parse(objectInput.value) as Parameters<typeof NVS.fromObject>[0];
      entries = NVS.fromObject(obj);
    }
    const encryptionKey = encryptOutput.value ? currentEncryptionKey() : undefined;
    generatedBin.value = NVS.generate(entries, {
      size,
      version: nvsVersion.value,
      encryptionKey,
    });
    generatedKeyPartition.value = encryptionKey
      ? NVS.serializeNvsKeyPartition(encryptionKey)
      : null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedPages.value = [];
  warnings.value = [];

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bin = new Uint8Array(reader.result as ArrayBuffer);
      const dump = NVS.parse(bin, { decryptionKey: parseDecryptionKey() });
      warnings.value = formatWarnings(dump.warnings);
      parsedPages.value = dump.pages
        .map((page, index) => ({
          index,
          entries: page.entries
            .filter((entry) => entry.state === 'Written')
            .map((entry) => ({
              key: entry.key,
              type:
                entry.type !== undefined
                  ? (NVS.ITEM_TYPE_NAME[entry.type] ?? String(entry.type))
                  : '?',
              state: entry.state,
              data: formatData(entry.data),
            })),
        }))
        .filter((page) => page.entries.length > 0);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function formatData(data: unknown): string {
  if (data instanceof Uint8Array) {
    if (data.byteLength <= 32) return bytesToHex(data);
    return `[${data.byteLength} bytes]`;
  }
  if (typeof data === 'bigint') return data.toString();
  if (typeof data === 'object' && data !== null) return JSON.stringify(data);
  return String(data ?? '');
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
          rows="10"
          spellcheck="false"
        />
        <textarea v-else v-model="objectInput" class="code-input" rows="12" spellcheck="false" />

        <div class="options-grid">
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
          <label class="checkbox-label">
            <input type="checkbox" v-model="encryptOutput" />
            {{ t('nvs.encrypted') }}
          </label>
        </div>

        <div v-if="encryptOutput" class="options-stack">
          <label class="stacked-label">
            <span>{{ t('nvs.encryptionKey') }}</span>
            <textarea
              v-model="encryptionKeyHex"
              class="code-input compact"
              rows="3"
              spellcheck="false"
            />
          </label>
          <div class="btn-row">
            <button class="btn outline" @click="regenerateKey">{{ t('nvs.generateKey') }}</button>
            <button
              v-if="generatedKeyPartition"
              class="btn outline"
              @click="downloadBinary(generatedKeyPartition, 'nvs_keys.bin')"
            >
              {{ t('nvs.downloadKeyPartition') }}
            </button>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn primary" @click="generateBinary">
            {{ t('nvs.generateBin') }}
          </button>
          <button
            v-if="generatedBin"
            class="btn success"
            @click="downloadBinary(generatedBin, 'nvs.bin')"
          >
            {{ t('nvs.downloadBin') }}
            ({{ generatedBin.byteLength }} {{ t('common.bytes') }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('nvs.uploadBin') }}</h3>
        <label class="stacked-label">
          <span>{{ t('nvs.decryptionKey') }}</span>
          <textarea
            v-model="decryptionKeyHex"
            class="code-input compact"
            rows="3"
            spellcheck="false"
          />
        </label>
        <label class="file-upload" style="margin-top: 0.75rem">
          <input type="file" accept=".bin" @change="onUpload" />
          <span class="btn outline">{{ t('nvs.uploadBin') }}</span>
        </label>
      </div>

      <WarningsPanel :title="t('nvs.parsedWarnings')" :warnings="warnings" />

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
