// Integration test for the three REST API endpoints. No server state needed.
import fetch from 'node-fetch';

const BASE = process.env.COGITO_URL || 'http://192.168.1.32:3000';

async function main() {
  console.log('=== API Endpoint Tests (' + BASE + ') ===\n');

  // 1. GET /api/models
  const modelsRes = await fetch(`${BASE}/api/models`);
  const modelsData = await modelsRes.json();
  if (!modelsRes.ok) throw new Error(`FAIL: /api/models status ${modelsRes.status}`);
  if (!Array.isArray(modelsData.models)) throw new Error('FAIL: /api/models should return { models: [...] }');
  console.log('  PASS: /api/models -> ' + modelsData.models.length + ' models');

  // 2. GET /api/rules
  const rulesRes = await fetch(`${BASE}/api/rules`);
  const rulesText = await rulesRes.text();
  if (!rulesRes.ok) throw new Error(`FAIL: /api/rules status ${rulesRes.status}`);
  if (!rulesRes.headers.get('content-type')?.includes('text/plain')) {
    throw new Error('FAIL: /api/rules should be text/plain, got ' + rulesRes.headers.get('content-type'));
  }
  if (!rulesText || !/\b(Cogito|vote|human)\b/i.test(rulesText)) {
    throw new Error('FAIL: /api/rules body should be non-empty rule text');
  }
  console.log('  PASS: /api/rules -> ' + rulesText.length + ' chars of rule text');

  // 3. GET /api/topics
  const topicsRes = await fetch(`${BASE}/api/topics`);
  const topicsData = await topicsRes.json();
  if (!topicsRes.ok) throw new Error(`FAIL: /api/topics status ${topicsRes.status}`);
  if (!Array.isArray(topicsData.topics) || topicsData.topics.length < 5) {
    throw new Error('FAIL: /api/topics should return { topics: [...] } with >= 5 entries');
  }
  console.log('  PASS: /api/topics -> ' + topicsData.topics.length + ' topics');

  console.log('\n=== ALL API TESTS PASSED ===');
  process.exit(0);
}

main().catch(err => {
  console.error('\n=== TEST FAILED ===', err.message);
  process.exit(1);
});
