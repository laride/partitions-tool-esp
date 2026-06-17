# partitions-tool-esp

[English](./README.md)

<div align="center">
  <a href ="https://www.npmjs.com/package/partitions-tool-esp" target="_blank">
    <img alt="NPM Version" src="https://img.shields.io/npm/v/partitions-tool-esp" />
  </a>
  <a href="https://github.com/laride/partitions-tool-esp" target="_blank">
    <img alt="GitHub Repo" src="https://img.shields.io/badge/github-repo-blue?logo=github" />
  </a>
</div>

生成与解析 ESP-IDF 分区表及其常用分区内容的纯 JavaScript / TypeScript 实现。

目前支持以下分区格式的生成与解析：

- Partition Table `partition_table`
- NVS `nvs`
  - 明文 NVS v1 / v2
  - multipage blob
- FAT `data.fat`
  - FAT12 / FAT16 / FAT32
  - SFN(8.3) 或 LFN
  - 磨损均衡
- SPIFFS `data.spiffs`

## 安装

```bash
pnpm add partitions-tool-esp # 或者使用你喜欢的包管理器
```

## 快速上手

> [!TIP]
>
> 当 NVS, SPIFFS, FATFS 的分区大小无法容纳提供的文件时，相关函数会抛出错误。

### Partition Table

分区表支持 CSV 格式文件与 `partitions.bin` 互相转换。

```ts
// PartitionTable is a class; import it from the subpath export.
import { PartitionTable } from 'partitions-tool-esp/partition-table';

const csv = `# Name, Type, SubType, Offset, Size, Flags
nvs,      data, nvs,     ,        0x6000,
phy_init, data, phy,     ,        0x1000,
factory,  app,  factory, ,        1M,
`;

const table = PartitionTable.fromCSV(csv, { flashSize: 4 * 1024 * 1024 });
const bin = table.toBinary(); // Uint8Array, 适合写入 partitions.bin

const roundtrip = PartitionTable.fromBinary(bin);
console.log(roundtrip.entries[0].name); // "nvs"
console.log(roundtrip.toCSV()); // 还原 CSV
```

Partition Table 生成逻辑是参考 [`gen_esp32part.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/partition_table/gen_esp32part.py#) 实现的。

### NVS

NVS 分区支持三种等价的构造方式：

```ts
import { NVS } from 'partitions-tool-esp';

// 1) 使用 ESP-IDF `nvs_partition_gen.py` 工具风格的 CSV
const csvBin = NVS.generate(
  NVS.parseCSV(`key,type,encoding,value
storage,namespace,,
greeting,data,string,hello world
counter,data,u32,42
`),
  { size: 0x6000 },
);

// 2) 链式 Builder
const builderBin = NVS.generate(
  new NVS.NvsBuilder()
    .namespace('storage')
    .string('greeting', 'hello world')
    .u32('counter', 42)
    .binary('blob', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    .namespace('settings')
    .u8('flag', 1)
    .build(),
  { size: 0x6000 },
);

// 3) 结构化对象：namespace -> { key: value }
const objectBin = NVS.generate(
  NVS.fromObject({
    storage: {
      greeting: 'hello world',
      counter: 42, // 推断为 u32
      signed: -1, // 推断为 i32
      blob: new Uint8Array([0xde, 0xad]), // 推断为 binary
      flag: { type: 'u8', value: 1 }, // 显式指定宽度
      hex: { type: 'binary', value: 'deadbeef', encoding: 'hex2bin' },
    },
    settings: {
      bigCounter: 1n << 40n, // 推断为 u64
    },
  }),
  { size: 0x6000 },
);

// 反向解析
const dump = NVS.parse(builderBin);
for (const page of dump.pages) {
  for (const entry of page.entries) {
    if (entry.state === 'Written') console.log(entry);
  }
}
```

结构化对象模式下，未明确指定类型时，库会自动尝试推断数据类型。也可以手动指定。

| JS 类型                                 | NVS 编码                                         |
| --------------------------------------- | ------------------------------------------------ |
| `number`（非负整数）                    | `u32`                                            |
| `number`（负整数）                      | `i32`                                            |
| `bigint`（非负）                        | `u64`                                            |
| `bigint`（负）                          | `i64`                                            |
| `string`                                | `string`                                         |
| `Uint8Array`                            | `binary`（raw）                                  |
| `{ type: 'u8'\|'i8'\|...'i64', value }` | 显式整型                                         |
| `{ type: 'string', value }`             | 显式字符串                                       |
| `{ type: 'binary', value, encoding? }`  | `encoding` 可为 `'raw' \| 'hex2bin' \| 'base64'` |

NVS 工具是参考 [`nvs_partition_tool`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/nvs_flash/nvs_partition_tool/) 实现的。

### SPIFFS

```ts
import { SPIFFS, createDir, createFile } from 'partitions-tool-esp';

const image = SPIFFS.generate({
  imageSize: 0x10000,
  pageSize: 256,
  objNameLen: 32,
  metaLen: 4,
  useMagic: true,
  useMagicLength: true,
  source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello\n'))]),
});

const parsed = SPIFFS.parse(image, { pageSize: 256, objNameLen: 32, metaLen: 4 });
for (const f of parsed.files) {
  console.log(f.path, new TextDecoder().decode(f.content));
}
```

SPIFFS 功能是参考 [`spiffsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/spiffs/spiffsgen.py) 实现的。

### FatFS

支持 FAT12 / FAT16 / FAT32 的生成和解析，可选支持磨损均衡。

```ts
import { FatFS, createDir, createFile } from 'partitions-tool-esp';

const image = FatFS.generate({
  size: 512 * 1024,
  source: createDir('', [
    createFile('HELLO.TXT', new TextEncoder().encode('hello\n')),
    // 默认已启用 LFN 长文件名支持，因此可以直接使用
    createFile('Hello Long Name.txt', new TextEncoder().encode('long\n')),
    createDir('SUB', [createFile('INNER.TXT', new Uint8Array([1, 2, 3]))]),
  ]),
  // volumeUuid: 0x12345678, // 卷 UUID: 可选，不填写时会自动指定，填写可以得到确定性输出
  // explicitFatType: 32,    // FAT Typs: 默认由簇数自动选 12/16；传 32 强制 FAT32
  // longFilenames: false,   // 长文件名支持: 禁用 LFN 时仅支持 8.3 文件名
  // espIdfCompat: false,    // IDF 风格偏好: 默认 true
});

const parsed = FatFS.parse(image);
for (const { path, content } of FatFS.flatten(parsed.root)) {
  console.log(path, content.byteLength);
}
```

参数说明:

- `longFilenames` LFN 长文件名支持，默认启用。如禁用，仅支持 [8.3 文件名](https://zh.wikipedia.org/wiki/8.3%E6%96%87%E4%BB%B6%E5%90%8D)，并在遇到超长文件名时报错。
- `espIdfCompat` IDF 风格偏好，默认启用。IDF 内置的 [`fatfsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/fatfs/fatfsgen.py) 在生成 FAT 镜像时有一些偏好，包括 UTF-16 小写字节化、`-N` 短别名等。将 `espIdfCompat` 设为 `true` 可以获得与 IDF `fatfsgen.py` 相近的输出，而设为 `false` 可以得到 `fsck.fat` 偏好的输出。

如需与 `wear_levelling` 组件配合使用，即启用磨损均衡，可额外启用 `wearLeveling` 选项。此时生成的 FATFS 镜像会自动预留 1 个 dummy 扇区 + 2 个 state 扇区 + 1 个 config 扇区（safe 模式再多 2 个 dump 扇区），与 [`wl_fatfsgen.py`](https://github.com/espressif/esp-idf/blob/e2face00fa14ae36befbf8a8cc4fcff0117661bd/components/fatfs/wl_fatfsgen.py) 基本一致：

```ts
import { FatFS, createDir, createFile } from 'partitions-tool-esp';

const image = FatFS.generate({
  size: 1024 * 1024,
  sectorSize: FatFS.WL_SECTOR_SIZE, // WL 要求 4096
  source: createDir('', [createFile('HELLO.TXT', new TextEncoder().encode('hi\n'))]),
  wearLeveling: true, // 或 { mode: 'safe', deviceId: 0xdeadbeef }
});

// 解析时声明 wearLeveling: true，库会先剥掉 WL 元数据再 parse。
const parsed = FatFS.parse(image, { wearLeveling: true });

// 也可以手动拆包 / 包装：
const plain = FatFS.removeWearLeveling(image);
const wrapped = FatFS.wrapWearLeveling(plain, image.byteLength, { mode: 'perf' });
```

### LittleFS

```ts
import { LittleFS, createDir, createFile } from 'partitions-tool-esp';

const image = LittleFS.generate({
  imageSize: 0x10000,
  source: createDir('root', [createFile('hello.txt', new TextEncoder().encode('hello\n'))]),
});

const parsed = LittleFS.parse(image, {
  onWarning(warning) {
    console.warn(warning);
  },
});

console.log(parsed.files[0]?.path);
console.log(parsed.warnings);
```

`LittleFS.parse()` 遇到可能导致结果不一致的结构性损坏时仍会抛错。对于“可疑但可跳过”的情况，例如非法文件名字节或不支持的 file type，则会继续做 best-effort 解码，并把 warning 收集到 `parsed.warnings`，同时在提供 `onWarning` 时即时回调。

### IO 辅助小工具

本项目提供了一些 Node.js / 浏览器 I/O 辅助工具。

```ts
// Node.js
import { readDir, writeDir } from 'partitions-tool-esp/io/node';
const tree = await readDir('./assets');
await writeDir(tree, './out');

// Browser
import { fromFileList, fromDirectoryHandle } from 'partitions-tool-esp/io/browser';
const dir1 = await fromFileList(inputElement.files!);
const dir2 = await fromDirectoryHandle(await showDirectoryPicker());
```

## 包导出

| 入口                                  | 用途                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `partitions-tool-esp`                 | 聚合出口，等价于 `import * as PartitionTable from '.../partition-table'` 等 |
| `partitions-tool-esp/partition-table` | 仅分区表                                                                    |
| `partitions-tool-esp/nvs`             | 仅 NVS                                                                      |
| `partitions-tool-esp/spiffs`          | 仅 SPIFFS                                                                   |
| `partitions-tool-esp/fatfs`           | 仅 FatFS                                                                    |
| `partitions-tool-esp/littlefs`        | 仅 LittleFS                                                                 |
| `partitions-tool-esp/io/node`         | Node.js 文件系统桥接                                                        |
| `partitions-tool-esp/io/browser`      | 浏览器 FileList / File System Access API 桥接                               |

## 开发

```bash
pnpm install
pnpm prepare # 初始化 husky pre-commit 钩子
pnpm format
pnpm lint
pnpm typecheck
pnpm test # 运行测试，含与 ESP-IDF 内置脚本字节比对的测试
pnpm build
```

### 重新生成 Fixture

`tests/fixtures/` 中的比对文件来自官方 ESP-IDF Python 工具。当上游格式发生变化或需要新 case 时：

```bash
# 启用 ESP-IDF 环境
source $IDF_PATH/export.sh

# 运行脚本（此时应当有 IDF_PATH 环境变量）
pnpm fixtures
# 或
IDF_PATH=/path/to/esp-idf OUT=tests/fixtures bash scripts/build-fixtures.sh
```

`scripts/build-fixtures.sh` 会调用：

- `components/partition_table/gen_esp32part.py`
- `components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py`
- `components/spiffs/spiffsgen.py`
- `components/fatfs/fatfsgen.py`

并把结果写回 `tests/fixtures/`。

> FatFS 镜像里的 `BS_VolID`（偏移 39 处 4 字节）是 `fatfsgen.py` 随机生成的；测试用例会先从测试样例中读出该值再作为 `volumeUuid` 传入 `FatFS.generate`，从而做到字节级一致。

## 当前限制与路线图

- FatFS：支持 FAT12 / FAT16 / FAT32、长文件名（LFN）、wear leveling（`perf` / `safe`）。
  ESP-IDF 本身只为 WL 支持 4096B 扇区（sector_size 512 的 WL 路径是 Python 侧特例），本库同样要求 `sectorSize === 4096`。
- NVS：尚未实现加密 (`encrypted_partition`) 与版本检测补丁。

## 许可证

Apache-2.0
