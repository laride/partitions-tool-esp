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
  - 加密 NVS（AES-256-XTS）
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
> NVS、SPIFFS、FATFS、LittleFS 的 parser 还支持 best-effort 诊断：解析结果里会返回 `warnings`，也可以通过可选的 `onWarning` 回调即时接收告警。

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

const table = PartitionTable.fromCSV(csv);
const bin = table.toBinary(); // Uint8Array, 适合写入 partitions.bin

const roundtrip = PartitionTable.fromBinary(bin);
console.log(roundtrip.entries[0].name); // "nvs"
console.log(roundtrip.toCSV()); // 还原 CSV
```

Partition Table 兼容性说明：

- `toBinary()` 会在编码前先校验分区表。
- `flashSize` 是可选项。只有你希望显式检查分区表是否超出 flash 容量时，才需要传入。
- `fromCSV(csv, { primaryBootloaderOffset, recoveryBootloaderOffset, offsetPartTable })` 支持 ESP-IDF 的特殊行语义，例如 `bootloader,primary`、`bootloader,recovery`、`partition_table,primary`。
- `extraSubtypes` 允许注册额外的 subtype 名称，且会同时影响 CSV 解析、`find()`、binary round-trip 与 CSV 导出。外层 key 可以写分区类型名如 `data`，也可以写原始类型数字字符串如 `0x40`。
- ESP-IDF bootloader 的 C 校验器会拒绝存在重复 MD5 校验行的表，而本实现的 `fromBinary()` 会以 warnings 提示并继续解析（如果校验值匹配）。
- ESP-IDF bootloader 的 C 校验器会拒绝第一条 32 字节记录就是全 `0xFF` 结束标记的情形，而本实现的 `fromBinary()` 会以 warning 的形式返回空表结果。Python `gen_esp32part.py` 也 parser 会把它当作空表接受。
- `secure: 'v1' | 'v2' | 'none'` 会影响 app 分区校验。当 `secure: 'v1'` 时，因 ESP-IDF 的 secure boot v1 规则，app 分区大小必须按 `0x10000` 对齐。
- 因 ESP-IDF 的校验规则，`data,ota`（`otadata`）和 `data,coredump` 分区不能标记为 `readonly`。

实现参考：

- https://github.com/espressif/esp-idf/blob/fa8039b5cadb6e85dd830ff8c2c4bd73b6538aee/components/partition_table/gen_esp32part.py
- https://github.com/espressif/esp-idf/blob/fa8039b5cadb6e85dd830ff8c2c4bd73b6538aee/components/bootloader_support/src/flash_partitions.c
- https://github.com/espressif/esp-idf/blob/fa8039b5cadb6e85dd830ff8c2c4bd73b6538aee/components/bootloader_support/include/esp_flash_partitions.h

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
ratio,data,float,1.5
precise,data,double,3.141592653589793
`),
  { size: 0x6000 },
);

// 2) 链式 Builder
const builderBin = NVS.generate(
  new NVS.NvsBuilder()
    .namespace('storage')
    .string('greeting', 'hello world')
    .u32('counter', 42)
    .float('ratio', 1.5)
    .double('precise', Math.PI)
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
      ratio: { type: 'float', value: 1.5 },
      precise: { type: 'double', value: Math.PI },
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

// --- 加密 NVS ---
// 生成随机加密密钥
const key = NVS.generateNvsKey();

// 生成加密的 NVS 分区
const encryptedBin = NVS.generate(
  NVS.parseCSV(`key,type,encoding,value
storage,namespace,,
secret,data,string,top-secret-value
`),
  { size: 0x6000, encryptionKey: key },
);

// 将密钥序列化为 NVS keys 分区格式（用于烧录）
const keysBin = NVS.serializeNvsKeyPartition(key);

// 解析加密分区（透明解密）
const decryptedDump = NVS.parse(encryptedBin, { decryptionKey: key });

// 对已有镜像单独加密/解密
const encrypted = NVS.encryptNvsPartition(csvBin, key);
const decrypted = NVS.decryptNvsPartition(encrypted, key);

// 从 HMAC 密钥派生（匹配 IDF 的 HMAC 密钥保护方案）
const hmacKey = new Uint8Array(32); // 你的 eFuse HMAC 密钥
const derivedKey = NVS.deriveNvsKeyFromHmac(hmacKey);
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
| `{ type: 'float'\|'double', value }`    | 显式 IEEE-754 浮点型                             |
| `{ type: 'string', value }`             | 显式字符串                                       |
| `{ type: 'binary', value, encoding? }`  | `encoding` 可为 `'raw' \| 'hex2bin' \| 'base64'` |

NVS 加密说明：

- 加密使用 **AES-256-XTS**（IEEE P1619），与 ESP-IDF 的 NVS 加密方案完全一致。仅条目数据（每页偏移 >= 64 处）被加密；页头和条目状态位图保持明文。
- NVS keys 分区格式为 4096 字节页：32 字节 `eky` + 32 字节 `tky` + 4 字节 CRC32 + 0xFF 填充。
- `deriveNvsKeyFromHmac()` 匹配 IDF 的 HMAC 密钥保护方案（`CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC`）。
- 加密 NVS 分区**不应**在分区表中标记 flash encryption 的 `encrypted` 标志；NVS 加密是独立于硬件 flash 加密的软件层 XTS 加密。

NVS 兼容性说明：

- CSV 输入额外接受 `float` / `double` encoding，以覆盖 NVS runtime 支持的数值类型。**此处与 IDF 实现存在差异**：IDF 的 Python `nvs_partition_tool` 实现暂不支持 `float` / `double` encoding。
- 整数 encoding 在写入前会做范围校验。超出目标类型位宽的值会抛出 `InputError`。
- 对于超过 JavaScript 安全整数范围的整数 encoding，请传入 `bigint` 或字符串字面量，例如 `'0xffffffffffffffff'`，不要使用 `number`。
- multipage blob 的静态生成始终写出 `chunkStart = 0`。这对 IDF 读取是有效的，但它不模拟 IDF runtime 在更新 blob 时使用 `0x00` / `0x80` 两个版本区间交替写入的行为。
- `NVS.parse()` 会尽最大可能解析分区内容，部分在 IDF C/C++ 实现中会报错的分区可以在本工具中解出（附带 warnings）。
- `NVS.generate(..., { size })` 默认使用 version 2（页头 `0xFE`，支持多页 blob）。新项目请始终使用 version 2。仅在必须生成旧版 V1 镜像时传入 `{ version: 1 }`。
- NVS Version 1 单页 `blob` 类型的 blob 上限为 1984 字节。**此处与 IDF 实现存在差异**：IDF C++ 实现中，NVS Version 1 单页写入上限为 4000 字节，但其配套的 `esp_idf_nvs_partition_gen` 设置有 1984 字节上限。
- 不支持 `esp_idf_nvs_partition_gen` 中的 `blob_fill(N;0xXX)`、`blob_sz_fill(N;0xXX)` CSV encoding。请自行构造带填充的 blob 字节（例如用 `NvsBuilder.binary()` 或 `{ type: 'binary', value: new Uint8Array(...) }`）。
- 不支持 `esp_idf_nvs_partition_gen` 的 WiFi 产线侧效应：写入 `sta.ssid` / `sta.pswd` 不会自动追加 `sta.apinfo`、`sta.pmk`、`sta.apsw`；写入 `ap.ssid` / `ap.passwd` / `ap.authmode` 也不会自动计算并写入 `ap.pmk_info`。若工作流需要这些 key，请显式添加。

NVS 工具的实现参考了 [ESP-IDF 的 NVS 实现](https://github.com/espressif/esp-idf/blob/fb14a3e7f45b93cc59e6efaf651013c560ef3549/components/nvs_flash/) （C/C++ 与 Python 实现）。

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
    console.warn(warning.message);
  },
});

console.log(parsed.files[0]?.path);
console.log(parsed.warnings);
```

`LittleFS.parse()` 遇到可能导致结果不一致的结构性损坏时仍会抛错。对于“可疑但可跳过”的情况，例如非法文件名字节或不支持的 file type，则会继续做 best-effort 解码，并把结构化 warning 收集到 `parsed.warnings`，同时在提供 `onWarning` 时即时回调。

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
- NVS：已支持加密（AES-256-XTS）。版本检测补丁尚未实现。

## 许可证

Apache-2.0
