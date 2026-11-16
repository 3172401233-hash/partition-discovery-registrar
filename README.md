# partition-discovery-registrar

JavaScript 分区发现与目录登记库，处理 Hive 路径解析、部分提交、重复发现和 schema 绑定。

对象存储中目录出现不代表上传完成：扫描器看到路径就登记会把空分区和写了一半的半成品交给下游。本库只在**分区文件集合完整且 schema 版本可确定**时才把分区登记进目录。

## 用法

```js
const { PartitionRegistrar } = require('./src');

const registrar = new PartitionRegistrar({
  template: 'dt={dt}/region={region}', // 分区模板，匹配 key 末尾目录段
  schemaVersion: 3,                    // 期望的 schema 版本（可选）
  watermark: { field: 'dt', before: '2026-11-10' }, // 可选：迟到分区水位线
});

const result = registrar.scan({
  keys: [
    'events/dt=2026-11-15/region=cn/part-0000.parquet',
    'events/dt=2026-11-15/region=cn/_SUCCESS',
  ],
  manifests: {
    // key -> manifest 内容（JSON 字符串或对象）
    'events/dt=2026-11-16/region=us/_manifest.json':
      JSON.stringify({ schemaVersion: 3, files: ['a.parquet'] }),
  },
});
```

`scan` 返回 `{ registered, alreadyRegistered, pending, revoked, conflicts, undetermined, unknown }` 七个分组。

## 登记规则

- **路径解析**：模板按目录段匹配 key 末尾（前缀如表路径任意）。`dt={dt}` 要求 Hive 风格 `名=值` 段；`{dt}` 匹配裸值段。段值先做 `decodeURIComponent`，百分号编码与原始 UTF-8 形式归并为同一分区（规范 ID 为重新编码的形式）。
- **完整性判定**（满足其一才算完整）：
  - 分区目录下存在完成标记 `_SUCCESS`（可用 `markerFile` 改名的）；或
  - 存在 manifest（默认 `_manifest.json`），其内容为 `{ schemaVersion, files: [...] }`，且 `files` 列出的每个文件都已在本次扫描的 key 中出现。
- **版本可确定**：版本取 manifest 的 `schemaVersion`，否则取构造时的 `schemaVersion`。两者都没有时进入 `undetermined`，不登记。
- **schema 冲突**：确定的版本与期望 `schemaVersion` 不一致时进入 `conflicts`，不登记；已登记分区再次出现不同版本时保留原登记并报告冲突。
- **部分提交**：只有数据文件、无标记无 manifest（或 manifest 文件未齐）时进入 `pending`，不登记；后续扫描补齐标记/文件后正常登记。
- **重复扫描**：同一分区同一版本重复到达是幂等的，计入 `alreadyRegistered`，不覆盖首次登记时间。
- **迟到分区**：不设登记截止；配置 `watermark` 后早于水位线的分区照常登记，仅标记 `late: true`。
- **未知目录**：不匹配模板的 key（临时目录、嵌套目录、其他表路径）进入 `unknown`，绝不参与登记。

## 撤销规则

- **清理标记**：分区目录下出现 `_DELETE`（可用 `tombstoneFile` 改名）时，已登记分区立即撤销（计入 `revoked`），该分区的待决状态一并丢弃；对从未登记的分区，清理标记被忽略。
- **过期清理**：`sweep(now)` 清除首次出现时间超过 `pendingTtlMs`（默认 24 小时）的待决记录，返回被清除的条目。已登记分区不受 `sweep` 影响，只能由清理标记撤销。

## 测试

```sh
npm test   # 即 node --test
```
