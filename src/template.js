'use strict';

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function compileTemplate(template) {
  if (typeof template !== 'string' || template.trim() === '') {
    throw new TypeError('partition template must be a non-empty string');
  }
  const segments = template
    .split('/')
    .filter(Boolean)
    .map((raw) => {
      const named = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (named) return { kind: 'var', key: named[1], field: named[2] };
      const bare = raw.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (bare) return { kind: 'var', key: null, field: bare[1] };
      return { kind: 'literal', value: raw };
    });
  if (!segments.some((s) => s.kind === 'var')) {
    throw new TypeError('partition template must contain at least one {variable}');
  }
  return segments;
}

function matchPartitionDir(dirSegments, compiled) {
  if (dirSegments.length < compiled.length) return null;
  const tail = dirSegments.slice(dirSegments.length - compiled.length);
  const values = {};
  for (let i = 0; i < compiled.length; i += 1) {
    const spec = compiled[i];
    const segment = safeDecode(tail[i]);
    if (spec.kind === 'literal') {
      if (segment !== spec.value) return null;
      continue;
    }
    if (spec.key === null) {
      values[spec.field] = segment;
      continue;
    }
    const eq = segment.indexOf('=');
    if (eq <= 0 || segment.slice(0, eq) !== spec.key) return null;
    values[spec.field] = segment.slice(eq + 1);
  }
  return values;
}

function canonicalPartitionId(values, compiled) {
  const parts = [];
  for (const spec of compiled) {
    if (spec.kind !== 'var') continue;
    const key = spec.key === null ? spec.field : spec.key;
    parts.push(`${key}=${encodeURIComponent(values[spec.field])}`);
  }
  return parts.join('/');
}

module.exports = { safeDecode, compileTemplate, matchPartitionDir, canonicalPartitionId };
