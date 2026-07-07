<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { PartitionTable } from 'partitions-tool-esp/partition-table';
import WarningsPanel from './WarningsPanel.vue';
import { downloadBinary, formatHex } from '../utils/demo.js';

const { t } = useI18n();

type SubTab = 'generate' | 'parse';
const subTab = ref<SubTab>('generate');

const defaultCsv = `# Name,   Type, SubType, Offset,   Size, Flags
nvs,      data, nvs,     ,        0x6000,
phy_init, data, phy,     ,        0x1000,
factory,  app,  factory, ,        1M,
`;

const csvInput = ref(defaultCsv);
const flashSize = ref(4 * 1024 * 1024);
const error = ref('');
const generatedBin = ref<Uint8Array | null>(null);
const warnings = ref<string[]>([]);
const entries = ref<
  Array<{
    name: string;
    type: string | number;
    subtype: string | number;
    offset: number;
    size: number;
    encrypted: boolean;
    readonly: boolean;
  }>
>([]);
const parsedCsv = ref('');

function mapEntries(table: PartitionTable) {
  return table.entries.map((e) => ({
    name: e.name,
    type: e.type,
    subtype: e.subtype,
    offset: e.offset ?? 0,
    size: e.size,
    encrypted: e.encrypted ?? false,
    readonly: e.readonly ?? false,
  }));
}

function generateBinary() {
  error.value = '';
  generatedBin.value = null;
  entries.value = [];
  warnings.value = [];
  try {
    const table = PartitionTable.fromCSV(csvInput.value, { flashSize: flashSize.value });
    generatedBin.value = table.toBinary();
    entries.value = mapEntries(table);
    warnings.value = table.warnings.map((warning) => warning.message);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function downloadBin() {
  if (!generatedBin.value) return;
  downloadBinary(generatedBin.value, 'partitions.bin');
}

function onUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  parsedCsv.value = '';
  entries.value = [];
  warnings.value = [];

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bin = new Uint8Array(reader.result as ArrayBuffer);
      const table = PartitionTable.fromBinary(bin, { flashSize: flashSize.value });
      parsedCsv.value = table.toCSV();
      entries.value = mapEntries(table);
      warnings.value = table.warnings.map((warning) => warning.message);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${n / (1024 * 1024)}MB`;
  if (n >= 1024) return `${n / 1024}KB`;
  return `${n}B`;
}
</script>

<template>
  <section class="demo-section">
    <h2>{{ t('partitionTable.title') }}</h2>
    <p class="desc">{{ t('partitionTable.desc') }}</p>

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
        <h3>{{ t('partitionTable.csvInput') }}</h3>
        <textarea v-model="csvInput" class="code-input" rows="8" spellcheck="false" />
        <div class="options-row">
          <label>
            {{ t('partitionTable.flashSize') }}:
            <select v-model="flashSize" class="input-small">
              <option :value="2 * 1024 * 1024">2 MB</option>
              <option :value="4 * 1024 * 1024">4 MB</option>
              <option :value="8 * 1024 * 1024">8 MB</option>
              <option :value="16 * 1024 * 1024">16 MB</option>
            </select>
          </label>
        </div>
        <div class="btn-row">
          <button class="btn primary" @click="generateBinary">
            {{ t('partitionTable.generateBin') }}
          </button>
          <button v-if="generatedBin" class="btn success" @click="downloadBin">
            {{ t('partitionTable.downloadBin') }}
            ({{ generatedBin.byteLength }} {{ t('common.bytes') }})
          </button>
        </div>
      </div>
    </div>

    <div v-if="subTab === 'parse'" class="tab-content">
      <div class="panel">
        <h3>{{ t('partitionTable.uploadBin') }}</h3>
        <div class="options-row" style="margin-bottom: 0.75rem">
          <label>
            {{ t('partitionTable.flashSize') }}:
            <select v-model="flashSize" class="input-small">
              <option :value="2 * 1024 * 1024">2 MB</option>
              <option :value="4 * 1024 * 1024">4 MB</option>
              <option :value="8 * 1024 * 1024">8 MB</option>
              <option :value="16 * 1024 * 1024">16 MB</option>
            </select>
          </label>
        </div>
        <label class="file-upload">
          <input type="file" accept=".bin" @change="onUpload" />
          <span class="btn outline">{{ t('partitionTable.uploadBin') }}</span>
        </label>
        <div v-if="parsedCsv" class="output-block">
          <h4>{{ t('partitionTable.parsedCsv') }}</h4>
          <pre class="code-output">{{ parsedCsv }}</pre>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ t('common.error') }}: {{ error }}</div>
    <WarningsPanel :title="t('partitionTable.showWarnings')" :warnings="warnings" />

    <div v-if="entries.length" class="result-section">
      <h3>{{ t('partitionTable.entries') }}</h3>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>{{ t('common.name') }}</th>
              <th>{{ t('common.type') }}</th>
              <th>{{ t('partitionTable.subtype') }}</th>
              <th>{{ t('common.offset') }}</th>
              <th>{{ t('common.size') }}</th>
              <th>{{ t('partitionTable.flags') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, i) in entries" :key="i">
              <td>
                <code>{{ entry.name }}</code>
              </td>
              <td>{{ entry.type }}</td>
              <td>{{ entry.subtype }}</td>
              <td>
                <code>{{ formatHex(entry.offset) }}</code>
              </td>
              <td>
                <code>{{ formatHex(entry.size) }}</code> ({{ formatSize(entry.size) }})
              </td>
              <td>
                <span v-if="entry.encrypted" class="badge">{{
                  t('partitionTable.encrypted')
                }}</span>
                <span v-if="entry.readonly" class="badge">{{ t('partitionTable.readonly') }}</span>
                <span v-if="!entry.encrypted && !entry.readonly">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
