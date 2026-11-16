'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PartitionRegistrar } = require('../src');

const TEMPLATE = 'dt={dt}/region={region}';

function makeRegistrar(extra = {}) {
  return new PartitionRegistrar({ template: TEMPLATE, schemaVersion: 3, ...extra });
}

test('完整分区：_SUCCESS 标记出现后登记，并解析分区值', () => {
  const registrar = makeRegistrar();
  const result = registrar.scan({
    keys: [
      'warehouse/events/dt=2026-11-15/region=cn/part-0000.parquet',
      'warehouse/events/dt=2026-11-15/region=cn/part-0001.parquet',
      'warehouse/events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
    now: 1000,
  });
  assert.equal(result.registered.length, 1);
  const record = result.registered[0];
  assert.deepEqual(record.values, { dt: '2026-11-15', region: 'cn' });
  assert.equal(record.version, 3);
  assert.deepEqual(record.files, ['part-0000.parquet', 'part-0001.parquet']);
  assert.equal(registrar.list().length, 1);
});

test('完整分区：manifest 文件集合齐全时登记，版本取自 manifest', () => {
  const registrar = makeRegistrar({ schemaVersion: null });
  const manifestKey = 'events/dt=2026-11-15/region=us/_manifest.json';
  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=us/a.parquet',
      'events/dt=2026-11-15/region=us/b.parquet',
    ],
    manifests: {
      [manifestKey]: JSON.stringify({ schemaVersion: 7, files: ['a.parquet', 'b.parquet'] }),
    },
  });
  assert.equal(result.registered.length, 1);
  assert.equal(result.registered[0].version, 7);
});

test('半成品：只有数据文件没有标记时不登记，标记补齐后再登记', () => {
  const registrar = makeRegistrar();
  const first = registrar.scan({
    keys: ['events/dt=2026-11-15/region=cn/part-0000.parquet'],
    now: 1000,
  });
  assert.equal(first.registered.length, 0);
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].reason, 'no-marker-no-manifest');
  assert.equal(registrar.list().length, 0);

  const second = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/part-0000.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
    now: 2000,
  });
  assert.equal(second.registered.length, 1);
  assert.equal(registrar.pendingList().length, 0);
});

test('部分提交：manifest 声明的文件未齐时保持待决', () => {
  const registrar = makeRegistrar();
  const manifestKey = 'events/dt=2026-11-15/region=cn/_manifest.json';
  const result = registrar.scan({
    keys: ['events/dt=2026-11-15/region=cn/a.parquet'],
    manifests: {
      [manifestKey]: { schemaVersion: 3, files: ['a.parquet', 'b.parquet'] },
    },
  });
  assert.equal(result.registered.length, 0);
  assert.equal(result.pending.length, 1);
  assert.match(result.pending[0].reason, /^missing-files:b\.parquet$/);
});

test('重复扫描：同一批完成事件重复到达是幂等的', () => {
  const registrar = makeRegistrar();
  const keys = [
    'events/dt=2026-11-15/region=cn/part-0000.parquet',
    'events/dt=2026-11-15/region=cn/_SUCCESS',
  ];
  const first = registrar.scan({ keys, now: 1000 });
  assert.equal(first.registered.length, 1);

  const second = registrar.scan({ keys, now: 2000 });
  assert.equal(second.registered.length, 0);
  assert.equal(second.alreadyRegistered.length, 1);
  assert.equal(registrar.list().length, 1);
  assert.equal(registrar.list()[0].registeredAt, 1000);
});

test('schema 冲突：manifest 版本与期望版本不一致时拒绝登记', () => {
  const registrar = makeRegistrar({ schemaVersion: 3 });
  const manifestKey = 'events/dt=2026-11-15/region=cn/_manifest.json';
  const result = registrar.scan({
    keys: ['events/dt=2026-11-15/region=cn/a.parquet'],
    manifests: { [manifestKey]: { schemaVersion: 4, files: ['a.parquet'] } },
  });
  assert.equal(result.registered.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    id: 'dt=2026-11-15/region=cn',
    expectedVersion: 3,
    actualVersion: 4,
  });
  assert.equal(registrar.list().length, 0);
});

test('schema 冲突：已登记分区出现不同版本时保留原登记并报告冲突', () => {
  const registrar = makeRegistrar({ schemaVersion: null });
  const keys = [
    'events/dt=2026-11-15/region=cn/a.parquet',
    'events/dt=2026-11-15/region=cn/_SUCCESS',
  ];
  const manifestKey = 'events/dt=2026-11-15/region=cn/_manifest.json';
  registrar.scan({
    keys,
    manifests: { [manifestKey]: { schemaVersion: 3, files: ['a.parquet'] } },
  });
  const result = registrar.scan({
    keys,
    manifests: { [manifestKey]: { schemaVersion: 9, files: ['a.parquet'] } },
  });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].registeredVersion, 3);
  assert.equal(result.conflicts[0].incomingVersion, 9);
  assert.equal(registrar.list()[0].version, 3);
});

test('版本不可确定：无 manifest 版本且未配置默认版本时不登记', () => {
  const registrar = new PartitionRegistrar({ template: TEMPLATE });
  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/a.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
  });
  assert.equal(result.registered.length, 0);
  assert.equal(result.undetermined.length, 1);
});

test('未知额外目录：不匹配模板的路径进入 unknown，不参与登记', () => {
  const registrar = makeRegistrar();
  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/a.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
      'events/dt=2026-11-15/region=cn/tmp_staging/b.parquet',
      'other-table/junk.txt',
      'events/dt=2026-11-15/region=cn/nested=1/deep.parquet',
    ],
  });
  assert.equal(result.registered.length, 1);
  assert.deepEqual(result.unknown.sort(), [
    'events/dt=2026-11-15/region=cn/nested=1/deep.parquet',
    'events/dt=2026-11-15/region=cn/tmp_staging/b.parquet',
    'other-table/junk.txt',
  ]);
});

test('路径编码：百分号编码的分区值被解码，不同编码形式归并为同一分区', () => {
  const registrar = makeRegistrar();
  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=%E5%8C%97%E4%BA%AC/a.parquet',
      'events/dt=2026-11-15/region=北京/b.parquet',
      'events/dt=2026-11-15/region=%E5%8C%97%E4%BA%AC/_SUCCESS',
    ],
  });
  assert.equal(result.registered.length, 1);
  const record = result.registered[0];
  assert.equal(record.values.region, '北京');
  assert.deepEqual(record.files, ['a.parquet', 'b.parquet']);
  assert.equal(record.id, 'dt=2026-11-15/region=%E5%8C%97%E4%BA%AC');
});

test('迟到分区：早于水位线的分区仍登记但标记 late', () => {
  const registrar = makeRegistrar({ watermark: { field: 'dt', before: '2026-11-10' } });
  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-01/region=cn/a.parquet',
      'events/dt=2026-11-01/region=cn/_SUCCESS',
      'events/dt=2026-11-15/region=cn/b.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
  });
  assert.equal(result.registered.length, 2);
  const byDt = Object.fromEntries(registrar.list().map((r) => [r.values.dt, r]));
  assert.equal(byDt['2026-11-01'].late, true);
  assert.equal(byDt['2026-11-15'].late, false);
});

test('撤销：清理标记 _DELETE 撤销已登记分区', () => {
  const registrar = makeRegistrar();
  registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/a.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
  });
  assert.equal(registrar.list().length, 1);

  const result = registrar.scan({
    keys: ['events/dt=2026-11-15/region=cn/_DELETE'],
    now: 5000,
  });
  assert.equal(result.revoked.length, 1);
  assert.equal(result.revoked[0].id, 'dt=2026-11-15/region=cn');
  assert.equal(registrar.list().length, 0);
});

test('撤销：清理标记同时丢弃待决状态，未登记分区的标记被忽略', () => {
  const registrar = makeRegistrar();
  registrar.scan({ keys: ['events/dt=2026-11-15/region=cn/a.parquet'], now: 1000 });
  assert.equal(registrar.pendingList().length, 1);

  const result = registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/_DELETE',
      'events/dt=2026-11-16/region=cn/_DELETE',
    ],
    now: 2000,
  });
  assert.equal(result.revoked.length, 0);
  assert.equal(registrar.pendingList().length, 0);
});

test('过期清理：sweep 清除超过 TTL 的半成品待决记录', () => {
  const registrar = makeRegistrar({ pendingTtlMs: 60_000 });
  registrar.scan({ keys: ['events/dt=2026-11-15/region=cn/a.parquet'], now: 10_000 });
  registrar.scan({ keys: ['events/dt=2026-11-15/region=us/b.parquet'], now: 50_000 });

  const expired = registrar.sweep(80_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, 'dt=2026-11-15/region=cn');
  assert.deepEqual(
    registrar.pendingList().map((p) => p.id),
    ['dt=2026-11-15/region=us'],
  );
});

test('过期清理：sweep 不影响已登记分区', () => {
  const registrar = makeRegistrar({ pendingTtlMs: 1000 });
  registrar.scan({
    keys: [
      'events/dt=2026-11-15/region=cn/a.parquet',
      'events/dt=2026-11-15/region=cn/_SUCCESS',
    ],
    now: 0,
  });
  const expired = registrar.sweep(1_000_000);
  assert.equal(expired.length, 0);
  assert.equal(registrar.list().length, 1);
});
