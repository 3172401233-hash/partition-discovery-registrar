'use strict';

const { PartitionRegistrar, DEFAULTS } = require('./registrar');
const { compileTemplate, matchPartitionDir, canonicalPartitionId, safeDecode } = require('./template');

module.exports = {
  PartitionRegistrar,
  DEFAULTS,
  compileTemplate,
  matchPartitionDir,
  canonicalPartitionId,
  safeDecode,
};
