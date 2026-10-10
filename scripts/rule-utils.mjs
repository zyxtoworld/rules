import { isIP } from 'node:net';

const ALLOWED_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'PROCESS-NAME',
  'PROCESS-PATH',
]);

const RULE_ORDER = new Map([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'PROCESS-NAME',
  'PROCESS-PATH',
].map((type, index) => [type, index]));

function asUpperSet(values) {
  return values instanceof Set
    ? values
    : new Set((values || []).map(value => String(value).toUpperCase()));
}

function asSet(values) {
  return values instanceof Set ? values : new Set(values || []);
}

export function unquote(value) {
  let text = String(value ?? '').trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function parseRuleLineWithSets(rawLine, dropTypeSet, dropRuleSet) {
  let line = String(rawLine ?? '').replace(/^\uFEFF/, '').trim();
  if (!line || line.startsWith('#') || line === 'payload:') return [];
  line = line.replace(/^[-]\s+/, '').trim();
  // Remove YAML/inline comments before unquoting. Otherwise a line such as
  // `- '+.example.com' # note` keeps its trailing quote and is discarded.
  line = line.replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '').trim();
  line = unquote(line);
  if (!line || line === 'payload:') return [];

  // Accept hosts-file exports used by several ad-block lists.
  const hostsMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([A-Za-z0-9.-]+)(?:\s+#.*)?$/i);
  if (hostsMatch) return [`DOMAIN,${hostsMatch[1]}`];

  // v2fly/domain-list-community uses full:domain and optional @cn/@ads
  // annotations. Preserve the domain itself; category annotations are handled
  // by the destination provider and should not become part of the hostname.
  line = line.replace(/\s+@[A-Za-z0-9_-]+(?:\s+#.*)?$/, '').trim();
  if (dropRuleSet.has(line)) return [];
  if (line.startsWith('full:')) return [`DOMAIN,${line.slice('full:'.length).trim()}`];
  if (line.startsWith('include:') || line.startsWith('regexp:')) return [];

  if (line.startsWith('||')) {
    const match = line.match(/^\|\|([A-Za-z0-9.-]+)\^/);
    if (match) return [`DOMAIN-SUFFIX,${match[1]}`];
  }

  if (line.startsWith('+.')) {
    const suffix = line.slice(2);
    return suffix.includes('*') ? [] : [`DOMAIN-SUFFIX,${suffix}`];
  }
  if (line.startsWith('*.')) {
    const suffix = line.slice(2);
    return suffix.includes('*') ? [] : [`DOMAIN-SUFFIX,${suffix}`];
  }
  if (line.startsWith('.')) {
    const suffix = line.slice(1);
    return suffix.includes('*') ? [] : [`DOMAIN-SUFFIX,${suffix}`];
  }
  if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(line)) return [`DOMAIN,${line}`];

  const pieces = line.split(',').map(part => part.trim());
  const type = String(pieces[0] || '').toUpperCase();
  if (dropTypeSet.has(type)) return [];
  if (!ALLOWED_RULE_TYPES.has(type) || !pieces[1]) return [];
  // Source lists often append Surge routing policies, matching modes, or
  // no-resolve flags. Those belong to the source profile, not this provider.
  const value = pieces[1].replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '').trim();
  // Mihomo DOMAIN/DOMAIN-SUFFIX rules do not support wildcard hostnames.
  // Do not publish invalid entries into MRS; supported +./* suffix forms are
  // normalized above instead.
  if ((type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') && value.includes('*')) return [];
  return value ? [`${type},${value}`] : [];
}

export function parseRuleLine(rawLine, dropTypes = [], dropRules = []) {
  return parseRuleLineWithSets(rawLine, asUpperSet(dropTypes), asSet(dropRules));
}

export function parseSource(text, source) {
  const dropTypeSet = asUpperSet(source.dropTypes || []);
  const dropRuleSet = asSet(source.dropRules || []);
  if (source.kind === 'cidr-list') {
    const rules = [];
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const value = line.split(/\s+/, 1)[0];
      if (!value.includes('/')) continue;
      const [address, prefix] = value.split('/');
      const version = isIP(address);
      const prefixLength = Number(prefix);
      const maxPrefix = version === 6 ? 128 : 32;
      if (version === 0 || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) continue;
      const type = version === 6 ? 'IP-CIDR6' : 'IP-CIDR';
      rules.push(...parseRuleLineWithSets(`${type},${value}`, dropTypeSet, dropRuleSet));
    }
    return rules;
  }
  if (source.kind === 'singbox') {
    const typeMap = {
      domain: 'DOMAIN',
      domain_suffix: 'DOMAIN-SUFFIX',
      domain_keyword: 'DOMAIN-KEYWORD',
      ip_cidr: 'IP-CIDR',
      ip_cidr6: 'IP-CIDR6',
      process_name: 'PROCESS-NAME',
    };
    const rules = [];
    const document = JSON.parse(text);
    const entries = Array.isArray(document) ? document : document.rules || [document];
    for (const entry of entries) {
      for (const [key, values] of Object.entries(entry || {})) {
        const type = typeMap[key];
        if (!type || !Array.isArray(values)) continue;
        for (const value of values) rules.push(...parseRuleLineWithSets(`${type},${value}`, dropTypeSet, dropRuleSet));
      }
    }
    return rules;
  }
  const rules = [];
  for (const line of String(text).split(/\r?\n/)) {
    rules.push(...parseRuleLineWithSets(line, dropTypeSet, dropRuleSet));
  }
  return rules;
}

function domainParts(value) {
  return value.toLowerCase().split('.').filter(Boolean);
}

function isCoveredBySuffix(domain, suffixes, includeSelf = false) {
  const parts = domainParts(domain);
  const start = includeSelf ? 0 : 1;
  for (let index = start; index < parts.length - 1; index += 1) {
    if (suffixes.has(parts.slice(index).join('.'))) return true;
  }
  return false;
}

export function normalizeRule(rule) {
  const parts = String(rule || '').split(',');
  const type = String(parts.shift() || '').trim().toUpperCase();
  const value = String(parts.shift() || '').trim();
  if (!type || !value) return null;
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    parts.unshift(value.toLowerCase().replace(/^\.+/, '').replace(/\.$/, ''));
  } else if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    parts.unshift(value.toLowerCase());
  } else {
    parts.unshift(value);
  }
  return [type, ...parts.map(part => part.trim())].join(',');
}

export function minimizeRuleSet(input) {
  const normalized = input.map(normalizeRule).filter(Boolean);
  const unique = [...new Set(normalized)];
  const suffixes = new Set(unique
    .filter(rule => rule.startsWith('DOMAIN-SUFFIX,'))
    .map(rule => rule.slice('DOMAIN-SUFFIX,'.length).toLowerCase()));
  const result = [];
  for (const rule of unique) {
    const [type, value] = rule.split(',', 2);
    if ((type === 'DOMAIN-SUFFIX' && isCoveredBySuffix(value, suffixes)) || (type === 'DOMAIN' && isCoveredBySuffix(value, suffixes, true))) {
      if (type === 'DOMAIN-SUFFIX' || suffixes.has(value.toLowerCase())) continue;
    }
    result.push(rule);
  }
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  result.sort((left, right) => {
    const leftType = left.split(',', 1)[0];
    const rightType = right.split(',', 1)[0];
    return (RULE_ORDER.get(leftType) ?? 99) - (RULE_ORDER.get(rightType) ?? 99) || compareText(left, right);
  });
  return {
    rules: result,
    inputRules: input.length,
    normalizedRules: unique.length,
    duplicateRules: normalized.length - unique.length,
    coveredRules: unique.length - result.length,
  };
}

export function minimizeRules(input) {
  return minimizeRuleSet(input).rules;
}

export function splitRules(rules) {
  const output = { domain: [], ipcidr: [], classical: [] };
  for (const rule of rules) {
    const type = rule.split(',', 1)[0];
    if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
      output.domain.push(rule);
    } else if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
      output.ipcidr.push(rule);
    } else {
      output.classical.push(rule);
    }
  }
  return output;
}
