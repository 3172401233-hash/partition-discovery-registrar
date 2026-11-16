'use strict';

const { compileTemplate, matchPartitionDir, canonicalPartitionId } = require('./template');

const DEFAULTS = {
  markerFile: '_SUCCESS',
  manifestFile: '_manifest.json',
  tombstoneFile: '_DELETE',
  pendingTtlMs: 24 * 60 * 60 * 1000,
};

class PartitionRegistrar {
  constructor(options = {}) {
    if (!options.template) throw new TypeError('options.template is required');
    this.compiled = compileTemplate(options.template);
    this.schemaVersion = options.schemaVersion ?? null;
    this.markerFile = options.markerFile ?? DEFAULTS.markerFile;
    this.manifestFile = options.manifestFile ?? DEFAULTS.manifestFile;
    this.tombstoneFile = options.tombstoneFile ?? DEFAULTS.tombstoneFile;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULTS.pendingTtlMs;
    this.watermark = options.watermark ?? null;
    this._registered = new Map();
    this._pending = new Map();
  }

  scan(input = {}) {
    const now = input.now ?? Date.now();
    const manifests = input.manifests ?? {};
    const allKeys = new Set(input.keys ?? []);
    for (const key of Object.keys(manifests)) allKeys.add(key);

    const result = {
      registered: [],
      alreadyRegistered: [],
      pending: [],
      revoked: [],
      conflicts: [],
      undetermined: [],
      unknown: [],
    };

    const groups = new Map();
    for (const rawKey of allKeys) {
      if (typeof rawKey !== 'string' || rawKey === '' || rawKey.endsWith('/')) continue;
      const segments = rawKey.split('/');
      const fileName = segments[segments.length - 1];
      const dirSegments = segments.slice(0, -1);
      const values = matchPartitionDir(dirSegments, this.compiled);
      if (!values) {
        result.unknown.push(rawKey);
        continue;
      }
      const id = canonicalPartitionId(values, this.compiled);
      let group = groups.get(id);
      if (!group) {
        group = { id, values, files: new Set(), marker: false, tombstone: false, manifestKey: null };
        groups.set(id, group);
      }
      if (fileName === this.markerFile) group.marker = true;
      else if (fileName === this.tombstoneFile) group.tombstone = true;
      else if (fileName === this.manifestFile) group.manifestKey = rawKey;
      else group.files.add(fileName);
    }

    for (const group of groups.values()) {
      if (group.tombstone) {
        this._pending.delete(group.id);
        if (this._registered.delete(group.id)) result.revoked.push(this._record(group, null, now));
        continue;
      }

      const completeness = this._assessCompleteness(group, manifests);
      if (!completeness.complete) {
        const entry = this._pending.get(group.id) ?? { firstSeen: now };
        entry.lastSeen = now;
        entry.values = group.values;
        entry.reason = completeness.reason;
        this._pending.set(group.id, entry);
        result.pending.push({ id: group.id, values: group.values, reason: completeness.reason });
        continue;
      }

      const version = completeness.version ?? this.schemaVersion;
      if (version == null) {
        result.undetermined.push({ id: group.id, values: group.values });
        continue;
      }

      const existing = this._registered.get(group.id);
      if (existing) {
        if (existing.version === version) {
          result.alreadyRegistered.push(existing);
        } else {
          result.conflicts.push({ id: group.id, registeredVersion: existing.version, incomingVersion: version });
        }
        continue;
      }

      if (this.schemaVersion != null && version !== this.schemaVersion) {
        result.conflicts.push({ id: group.id, expectedVersion: this.schemaVersion, actualVersion: version });
        continue;
      }

      const record = this._record(group, version, now);
      this._registered.set(group.id, record);
      this._pending.delete(group.id);
      result.registered.push(record);
    }

    return result;
  }

  sweep(now = Date.now()) {
    const expired = [];
    for (const [id, entry] of this._pending) {
      if (now - entry.firstSeen >= this.pendingTtlMs) {
        this._pending.delete(id);
        expired.push({ id, values: entry.values, firstSeen: entry.firstSeen, reason: entry.reason });
      }
    }
    return expired;
  }

  get(id) {
    return this._registered.get(id) ?? null;
  }

  isRegistered(id) {
    return this._registered.has(id);
  }

  list() {
    return [...this._registered.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  pendingList() {
    return [...this._pending.entries()].map(([id, entry]) => ({ id, ...entry }));
  }

  _assessCompleteness(group, manifests) {
    if (group.manifestKey) {
      const raw = manifests[group.manifestKey];
      if (raw == null) return { complete: false, reason: 'manifest-content-unavailable' };
      let manifest;
      try {
        manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return { complete: false, reason: 'manifest-unparseable' };
      }
      if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
        return { complete: false, reason: 'manifest-invalid' };
      }
      const missing = manifest.files.filter((f) => !group.files.has(f));
      if (missing.length > 0) return { complete: false, reason: `missing-files:${missing.join(',')}` };
      return { complete: true, version: manifest.schemaVersion ?? null };
    }
    if (group.marker) return { complete: true, version: null };
    return { complete: false, reason: 'no-marker-no-manifest' };
  }

  _record(group, version, now) {
    const record = {
      id: group.id,
      values: { ...group.values },
      version,
      files: [...group.files].sort(),
      registeredAt: now,
      late: false,
    };
    if (this.watermark && this.watermark.field in record.values) {
      record.late = record.values[this.watermark.field] < this.watermark.before;
    }
    return record;
  }
}

module.exports = { PartitionRegistrar, DEFAULTS };
