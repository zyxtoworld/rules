import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceManifestPath = join(repoRoot, 'sources.json');
const outputManifestPath = join(repoRoot, 'rules', 'manifest.json');
const outputRoot = join(repoRoot, 'rules', 'mihomo');
const userAgent = 'zyxtoworld-rules-builder/2.0';
const retryCount = 3;
// Keep this layout synchronized with convert.js ruleProviderParts.
// A stable provider layout prevents scheduled upstream refreshes from creating
// missing or unreferenced RULE-SET names in the Sub-Store converter.
const fixedMrsPartitions = {
  ads: { domain: 2 },
};
const builtInRules = {
  // Community and MetaCubeX reports for Gemini mobile/API dependencies that
  // are not yet present in the upstream google-gemini list.
  ai: [
    'DOMAIN-SUFFIX,g.ai',
    'DOMAIN-SUFFIX,c.gle',
    'DOMAIN-SUFFIX,optimizationguide-pa.googleapis.com',
    'DOMAIN,footprints-pa.googleapis.com',
  ],
  // Apple lists these hosts for Apple Intelligence, Siri, Search and Private
  // Cloud Compute. Keep them in the Apple provider so foreign Apple ID and
  // Siri traffic follows the Apple service policy.
  apple: [
    'DOMAIN,guzzoni.apple.com',
    'DOMAIN-SUFFIX,smoot.apple.com',
    'DOMAIN,apple-relay.cloudflare.com',
    'DOMAIN,apple-relay.fastly-edge.com',
    'DOMAIN,cp4.cloudflare.com',
    'DOMAIN,apple-relay.apple.com',
  ],
};
const builtInRuleSourceNames = {
  ai: 'built-in: Gemini mobile and API dependencies',
  apple: 'built-in: Apple Intelligence and Siri hosts',
};
const maxMrsBytes = 1_400_000;

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, { headers: { 'user-agent': userAgent }, signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 1500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url}: ${lastError?.message || 'fetch failed'}`);
}

function unquote(value) {
  let text = value.trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function parseRuleLine(rawLine, dropTypes = [], dropRules = []) {
  let line = rawLine.replace(/^\uFEFF/, '').trim();
  if (!line || line.startsWith('#') || line === 'payload:') return [];
  line = line.replace(/^[-]\s+/, '').trim();
  line = unquote(line);
  if (!line || line === 'payload:') return [];
  line = line.replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '').trim();

  // Accept hosts-file exports used by several ad-block lists.
  const hostsMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([A-Za-z0-9.-]+)(?:\s+#.*)?$/i);
  if (hostsMatch) return [`DOMAIN,${hostsMatch[1]}`];

  // v2fly/domain-list-community uses full:domain and optional @cn/@ads
  // annotations. Preserve the domain itself; category annotations are handled
  // by the destination provider and should not become part of the hostname.
  line = line.replace(/\s+@[A-Za-z0-9_-]+(?:\s+#.*)?$/, '').trim();
  if (dropRules.includes(line)) return [];
  if (line.startsWith('full:')) return [`DOMAIN,${line.slice('full:'.length).trim()}`];
  if (line.startsWith('include:') || line.startsWith('regexp:')) return [];

  if (line.startsWith('||')) {
    const match = line.match(/^\|\|([A-Za-z0-9.-]+)\^/);
    if (match) return [`DOMAIN-SUFFIX,${match[1]}`];
  }

  if (line.startsWith('+.')) return [`DOMAIN-SUFFIX,${line.slice(2)}`];
  if (line.startsWith('.')) return [`DOMAIN-SUFFIX,${line.slice(1)}`];
  if (/^[A-Za-z0-9*_-]+(\.[A-Za-z0-9*_-]+)+$/.test(line)) return [`DOMAIN,${line}`];

  const pieces = line.split(',').map(part => part.trim());
  const type = String(pieces[0] || '').toUpperCase();
  if (dropTypes.map(value => value.toUpperCase()).includes(type)) return [];
  const allowed = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'PROCESS-NAME', 'PROCESS-PATH']);
  if (!allowed.has(type) || !pieces[1]) return [];
  // Source lists often append Surge routing policies, matching modes, or
  // no-resolve flags. Those belong to the source profile, not this provider.
  const value = pieces[1].replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '').trim();
  return value ? [`${type},${value}`] : [];
}

function parseSource(text, source) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    rules.push(...parseRuleLine(line, source.dropTypes || [], source.dropRules || []));
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

function normalizeRule(rule) {
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

function minimizeRules(input) {
  const unique = [...new Set(input.map(normalizeRule).filter(Boolean))];
  const suffixes = new Set(unique.filter(rule => rule.startsWith('DOMAIN-SUFFIX,')).map(rule => rule.slice('DOMAIN-SUFFIX,'.length).toLowerCase()));
  const result = [];
  for (const rule of unique) {
    const [type, value] = rule.split(',', 2);
    if ((type === 'DOMAIN-SUFFIX' && isCoveredBySuffix(value, suffixes)) || (type === 'DOMAIN' && isCoveredBySuffix(value, suffixes, true))) {
      if (type === 'DOMAIN-SUFFIX' || suffixes.has(value.toLowerCase())) continue;
    }
    result.push(rule);
  }
  const order = new Map(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'PROCESS-NAME', 'PROCESS-PATH'].map((type, index) => [type, index]));
  return result.sort((left, right) => {
    const leftType = left.split(',', 1)[0];
    const rightType = right.split(',', 1)[0];
    return (order.get(leftType) ?? 99) - (order.get(rightType) ?? 99) || left.localeCompare(right);
  });
}

function splitRules(rules) {
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

function renderYaml(rules) {
  return `# Generated by scripts/build-rules.mjs. Do not edit manually.\npayload:\n${rules.map(rule => `  - ${JSON.stringify(rule)}`).join('\n')}\n`;
}

function toMrsPayloadRule(rule, behavior) {
  const [type, value] = rule.split(',', 2);
  if (behavior === 'domain') {
    return type === 'DOMAIN-SUFFIX' ? `.${value}` : value;
  }
  return value;
}

function renderMrsInputYaml(rules, behavior) {
  return `payload:\n${rules.map(rule => `  - ${JSON.stringify(toMrsPayloadRule(rule, behavior))}`).join('\n')}\n`;
}

function outputFileName(group, kind, part = 1) {
  const partSuffix = part === 1 ? '' : `-${part}`;
  if (kind === 'domain') return `${group}${partSuffix}.mrs`;
  if (kind === 'ipcidr') return `${group}-ipcidr${partSuffix}.mrs`;
  return `${group}-classical.yaml`;
}

function outputProviderName(group, kind, part = 1) {
  const partSuffix = part === 1 ? '' : `-${part}`;
  return kind === 'domain' ? `${group}${partSuffix}` : `${group}-${kind}${partSuffix}`;
}

async function resolveMihomoBinary() {
  const candidates = [
    process.env.MIHOMO_BIN,
    process.platform === 'win32' ? 'mihomo.exe' : 'mihomo',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      if (candidate.includes(sep) || candidate.includes('/')) continue;
    }
    try {
      await execFileAsync(candidate, ['-v'], { cwd: repoRoot, timeout: 30000 });
      return candidate;
    } catch {
      // Try the next configured path or PATH entry.
    }
  }
  throw new Error('MRS 构建需要官方 mihomo 转换器。请设置 MIHOMO_BIN，或将 mihomo/mihomo.exe 加入 PATH。');
}

async function convertYamlToMrs(binary, behavior, rules, outputPath, tempRoot, group, part) {
  const sourcePath = join(tempRoot, `${group}-${behavior}-${part}.yaml`);
  await writeFile(sourcePath, renderMrsInputYaml(rules, behavior), 'utf8');
  await execFileAsync(binary, ['convert-ruleset', behavior, 'yaml', sourcePath, outputPath], {
    cwd: repoRoot,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
}

async function splitMrsPartitions(binary, behavior, rules, tempRoot, group, part = 1) {
  const partitionCount = fixedMrsPartitions[group]?.[behavior] || 1;
  if (rules.length < partitionCount) {
    throw new Error(`${group}/${behavior} needs ${partitionCount} non-empty MRS partitions, got ${rules.length} rules`);
  }

  const chunkSize = Math.ceil(rules.length / partitionCount);
  const artifacts = [];
  for (let index = 0; index < partitionCount; index += 1) {
    const partRules = rules.slice(index * chunkSize, (index + 1) * chunkSize);
    const part = index + 1;
    const candidatePath = join(tempRoot, `${group}-${behavior}-${part}-${partRules.length}.mrs`);
    await convertYamlToMrs(binary, behavior, partRules, candidatePath, tempRoot, group, part);
    const bytes = (await stat(candidatePath)).size;
    if (bytes > maxMrsBytes) {
      throw new Error(`${group}/${behavior}/${part} is ${bytes} bytes; increase its fixed partition count and update convert.js`);
    }
    artifacts.push({ rules: partRules, candidatePath, bytes });
  }
  return artifacts;
}

function collectPreviousOutputPaths(previousManifest) {
  const paths = new Set();
  for (const output of Object.values(previousManifest?.outputs || {})) {
    if (output?.path) paths.add(resolve(repoRoot, output.path));
    for (const file of output?.files || []) {
      if (file?.path) paths.add(resolve(repoRoot, file.path));
    }
  }
  return paths;
}

let previousManifest = null;
try {
  previousManifest = JSON.parse(await readFile(outputManifestPath, 'utf8'));
} catch {
  // The first build has no previous generated manifest.
}

const binary = await resolveMihomoBinary();
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
await mkdir(outputRoot, { recursive: true });
const previousOutputPaths = collectPreviousOutputPaths(previousManifest);

const tempRoot = await mkdtemp(join(tmpdir(), 'zyxtoworld-rules-'));
const metadata = {
  schemaVersion: 2,
  sources: {},
  outputs: {},
  groups: {},
};

try {
  for (const [group, sources] of Object.entries(sourceManifest.sources)) {
    const collected = [];
    metadata.sources[group] = [];
    for (const source of sources) {
      process.stdout.write(`fetch ${group}: ${source.url}\n`);
      const text = await fetchText(source.url);
      const parsed = parseSource(text, source);
      for (const rule of parsed) collected.push(rule);
      metadata.sources[group].push({ url: source.url, source: source.source, rules: parsed.length });
    }

    const extraRules = builtInRules[group] || [];
    if (extraRules.length) {
      collected.push(...extraRules);
      metadata.sources[group].push({ source: builtInRuleSourceNames[group] || `built-in: ${group}`, rules: extraRules.length });
    }

    const inputRules = collected.length;
    const rules = minimizeRules(collected);
    const partitions = splitRules(rules);
    const files = [];

    for (const [kind, partition] of Object.entries(partitions)) {
      if (partition.length === 0) continue;
      const behavior = kind === 'domain' ? 'domain' : kind === 'ipcidr' ? 'ipcidr' : 'classical';
      const format = kind === 'classical' ? 'yaml' : 'mrs';
      const artifacts = format === 'mrs'
        ? await splitMrsPartitions(binary, behavior, partition, tempRoot, group)
        : [{ rules: partition, candidatePath: null, bytes: 0 }];

      for (let index = 0; index < artifacts.length; index += 1) {
        const artifact = artifacts[index];
        const part = index + 1;
        const fileName = outputFileName(group, kind, part);
        const relativePath = `rules/mihomo/${fileName}`;
        const outputPath = join(outputRoot, fileName);
        if (format === 'mrs') {
          await copyFile(artifact.candidatePath, outputPath);
        } else {
          await writeFile(outputPath, renderYaml(artifact.rules), 'utf8');
        }

        const bytes = (await stat(outputPath)).size;
        if (bytes === 0) throw new Error(`empty generated output: ${relativePath}`);
        const provider = outputProviderName(group, kind, part);
        metadata.outputs[provider] = {
          path: relativePath,
          group,
          behavior,
          format,
          rules: artifact.rules.length,
          bytes,
        };
        files.push(provider);
        process.stdout.write(`write ${relativePath}: ${artifact.rules.length} rules, ${bytes} bytes\n`);
      }
    }

    metadata.groups[group] = {
      inputRules,
      rules: rules.length,
      pruned: inputRules - rules.length,
      outputs: files,
    };
  }

  await writeFile(outputManifestPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const generatedFiles = new Set(Object.values(metadata.outputs).map(output => resolve(repoRoot, output.path)));
for (const outputPath of previousOutputPaths) {
  if (!generatedFiles.has(outputPath)) await rm(outputPath, { force: true });
}
for (const entry of await readdir(outputRoot)) {
  const path = join(outputRoot, entry);
  if (!generatedFiles.has(path) && (extname(entry) === '.yaml' || extname(entry) === '.mrs')) {
    await rm(path, { force: true });
  }
}
