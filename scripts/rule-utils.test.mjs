import assert from 'node:assert/strict';
import test from 'node:test';
import { minimizeRuleSet, parseRuleLine, parseSource } from './rule-utils.mjs';

test('parses supported list syntaxes and source filters', () => {
  assert.deepEqual(parseRuleLine('127.0.0.1 tracker.example'), ['DOMAIN,tracker.example']);
  assert.deepEqual(parseRuleLine('||Ads.Example^'), ['DOMAIN-SUFFIX,Ads.Example']);
  assert.deepEqual(parseRuleLine("- '+.Example.COM' # comment"), ['DOMAIN-SUFFIX,Example.COM']);
  assert.deepEqual(parseRuleLine('full:api.example.com @cn'), ['DOMAIN,api.example.com']);
  assert.deepEqual(parseRuleLine('DOMAIN-KEYWORD,tracking', ['DOMAIN-KEYWORD']), []);
  assert.deepEqual(parseRuleLine('DOMAIN,blocked.example', [], ['DOMAIN,blocked.example']), []);
  assert.deepEqual(parseRuleLine('include:other.list'), []);
});

test('parses sing-box rule objects', () => {
  const source = { kind: 'singbox' };
  const rules = parseSource(JSON.stringify({ rules: [{ domain: ['api.example.com'], domain_suffix: ['example.org'], ip_cidr: ['192.0.2.0/24'], process_name: ['demo'] }] }), source);
  assert.deepEqual(rules, [
    'DOMAIN,api.example.com',
    'DOMAIN-SUFFIX,example.org',
    'IP-CIDR,192.0.2.0/24',
    'PROCESS-NAME,demo',
  ]);
});

test('deduplicates every supported rule class and minimizes covered domains', () => {
  const result = minimizeRuleSet([
    'DOMAIN,Exact.Example.com',
    'DOMAIN,exact.example.com',
    'DOMAIN-SUFFIX,Example.com',
    'DOMAIN-SUFFIX,sub.example.com',
    'DOMAIN-KEYWORD,tracker',
    'DOMAIN-KEYWORD,tracker',
    'IP-CIDR,192.0.2.0/24',
    'IP-CIDR,192.0.2.0/24',
    'IP-CIDR6,2001:db8::/32',
    'IP-CIDR6,2001:db8::/32',
    'IP-ASN,20473',
    'IP-ASN,20473',
    'PROCESS-NAME,Demo',
    'PROCESS-NAME,Demo',
    'PROCESS-PATH,/opt/demo',
    'PROCESS-PATH,/opt/demo',
  ]);
  assert.equal(result.inputRules, 16);
  assert.equal(result.normalizedRules, 9);
  assert.equal(result.duplicateRules, 7);
  assert.equal(result.coveredRules, 1);
  assert.equal(result.rules.length, 8);
  assert.deepEqual(result.rules, [
    'DOMAIN,exact.example.com',
    'DOMAIN-SUFFIX,example.com',
    'DOMAIN-KEYWORD,tracker',
    'IP-CIDR,192.0.2.0/24',
    'IP-CIDR6,2001:db8::/32',
    'IP-ASN,20473',
    'PROCESS-NAME,Demo',
    'PROCESS-PATH,/opt/demo',
  ]);
});
