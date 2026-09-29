const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.match(fs.readFileSync('LICENSE.txt', 'utf8'), /LicenseRef-WSSAWER-Noncommercial-1\.0/);
assert.equal(require('../package.json').license, 'SEE LICENSE IN LICENSE.txt');
console.log('LICENSE_TEST_OK');
