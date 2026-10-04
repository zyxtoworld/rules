import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const convertPath = join(repoRoot, 'convert.js');
const sourceManifestPath = join(repoRoot, 'sources.json');
const outputManifestPath = join(repoRoot, 'rules', 'manifest.json');
const outputRoot = join(repoRoot, 'rules', 'mihomo');
const maxOutputBytes = 1_400_000;
const maxTotalOutputBytes = 4 * 1024 * 1024;

function fail(errors) {
  if (errors.length === 0) return;
  throw new Error(`规则契约校验失败：\n${errors.map(error => `- ${error}`).join('\n')}`);
}

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value));
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function outputFilePath(output) {
  return resolve(repoRoot, output?.path || '');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadConverterConfig() {
  const source = await readFile(convertPath, 'utf8');
  const context = {};
  vm.runInNewContext(`${source}\nthis.__buildConfig = buildConfig;`, context, { filename: convertPath });
  return context.__buildConfig([]);
}

function referencedRuleProviders(rules) {
  const names = new Set();
  for (const rule of rules || []) {
    for (const match of String(rule).matchAll(/RULE-SET,([^,)]+)/g)) names.add(match[1]);
  }
  return names;
}

async function main() {
  const errors = [];
  const sourceManifest = await readJson(sourceManifestPath);
  const manifest = await readJson(outputManifestPath);
  const config = await loadConverterConfig();
  const providers = config['rule-providers'];
  const manifestOutputs = manifest.outputs;
  const manifestGroups = manifest.groups;
  const dns = config.dns;
  const dnsServers = Array.isArray(dns?.nameserver) ? dns.nameserver : [];
  const dnsPolicies = dns?.['nameserver-policy'] || {};
  if (config.ipv6 !== true) errors.push('转换器必须保留全局 IPv6，旁路防护由 TUN strict-route 提供');
  if (dns?.enable !== true) errors.push('转换器必须启用 DNS');
  if (dns?.ipv6 !== true) errors.push('DNS 必须保留 IPv6 解析');
  if (dns?.['enhanced-mode'] !== 'fake-ip') errors.push('DNS 必须使用 fake-ip 模式');
  if (!dns?.['fake-ip-range6']) errors.push('DNS 必须配置 fake-ip-range6');
  if (!dnsServers.some(server => String(server).includes('#🔍 谷歌服务'))) errors.push('默认 DNS 必须通过谷歌策略组代理');
  if (!Array.isArray(dns?.['proxy-server-nameserver']) || dns['proxy-server-nameserver'].length === 0) errors.push('必须配置 proxy-server-nameserver，避免代理节点解析回退到系统 DNS');
  if (!Array.isArray(dns?.['direct-nameserver']) || dns['direct-nameserver'].some(server => server === 'system')) errors.push('DIRECT DNS 不得使用系统明文解析');
  for (const key of ['geosite:geolocation-!cn', '+.google.com', '+.googleapis.com', '+.gstatic.com']) {
    const servers = Array.isArray(dnsPolicies[key]) ? dnsPolicies[key] : [];
    if (!servers.some(server => String(server).includes('#🔍 谷歌服务'))) errors.push(`DNS policy ${key} 必须通过谷歌策略组代理`);
  }

  if (manifest.schemaVersion !== 2) errors.push(`manifest schemaVersion 应为 2，实际为 ${manifest.schemaVersion}`);
  if (!sourceManifest.sources || typeof sourceManifest.sources !== 'object' || Array.isArray(sourceManifest.sources)) {
    errors.push('sources.json.sources 必须是对象');
  } else {
    for (const [group, sources] of Object.entries(sourceManifest.sources)) {
      if (!Array.isArray(sources)) {
        errors.push(`sources.json: ${group} 必须是数组`);
        continue;
      }
      for (const [index, source] of sources.entries()) {
        if (!source || typeof source !== 'object') {
          errors.push(`sources.json: ${group}[${index}] 必须是对象`);
          continue;
        }
        if (typeof source.url !== 'string' || !source.url) errors.push(`sources.json: ${group}[${index}] 缺少 url`);
        else {
          try {
            new URL(source.url);
          } catch {
            errors.push(`sources.json: ${group}[${index}] URL 无效：${source.url}`);
          }
        }
        if (source.sha256 !== undefined && (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256))) {
          errors.push(`sources.json: ${group}[${index}].sha256 必须是 64 位十六进制字符串`);
        }
        if (typeof source.kind !== 'string' || !source.kind) errors.push(`sources.json: ${group}[${index}] 缺少 kind`);
        if (typeof source.source !== 'string' || !source.source) errors.push(`sources.json: ${group}[${index}] 缺少 source`);
        for (const field of ['dropTypes', 'dropRules']) {
          if (source[field] !== undefined && (!Array.isArray(source[field]) || source[field].some(value => typeof value !== 'string'))) {
            errors.push(`sources.json: ${group}[${index}].${field} 必须是字符串数组`);
          }
        }
      }
    }
  }

  const providerNames = new Set(Object.keys(providers || {}));
  const outputNames = new Set(Object.keys(manifestOutputs || {}));
  for (const name of setDifference(providerNames, outputNames)) errors.push(`转换器引用了 manifest 中不存在的 provider：${name}`);
  for (const name of setDifference(outputNames, providerNames)) errors.push(`manifest 包含转换器未声明的 provider：${name}`);

  const referencedPaths = new Set();
  let totalOutputBytes = 0;
  const pathOwners = new Map();
  for (const [name, provider] of Object.entries(providers || {})) {
    const output = manifestOutputs?.[name];
    if (!output) continue;
    const outputPath = outputFilePath(output);
    const outputName = basename(output.path || '');
    if (!isWithin(outputRoot, outputPath)) errors.push(`${name} 的输出路径越界：${output.path}`);
    if (pathOwners.has(output.path)) errors.push(`多个 provider 共享输出路径：${pathOwners.get(output.path)} 与 ${name}`);
    pathOwners.set(output.path, name);
    referencedPaths.add(outputName);

    if (typeof provider.url !== 'string') {
      errors.push(`${name} 缺少 provider URL`);
    } else {
      try {
        const providerFile = basename(new URL(provider.url).pathname);
        if (providerFile !== outputName) errors.push(`${name} URL 文件名 ${providerFile} 与 manifest 文件名 ${outputName} 不一致`);
      } catch {
        errors.push(`${name} URL 无效：${provider.url}`);
      }
    }
    if (provider.behavior !== output.behavior) errors.push(`${name} behavior 不一致：转换器=${provider.behavior}，manifest=${output.behavior}`);
    if (provider.format !== output.format) errors.push(`${name} format 不一致：转换器=${provider.format}，manifest=${output.format}`);
    const expectedExtension = output.format === 'mrs' ? '.mrs' : output.format === 'yaml' ? '.yaml' : null;
    if (!expectedExtension || !outputName.endsWith(expectedExtension)) errors.push(`${name} format 与文件扩展名不一致：${output.format} / ${outputName}`);
    if (!Number.isInteger(output.rules) || output.rules <= 0) errors.push(`${name} 规则数必须是正整数：${output.rules}`);
    if (!Number.isInteger(output.bytes) || output.bytes <= 0) errors.push(`${name} 字节数必须是正整数：${output.bytes}`);
    if (output.bytes > maxOutputBytes) errors.push(`${name} 超过单文件上限：${output.bytes} > ${maxOutputBytes}`);
    totalOutputBytes += Number.isFinite(output.bytes) ? output.bytes : 0;

    try {
      const fileStat = await stat(outputPath);
      if (fileStat.size === 0) errors.push(`${name} 输出为空：${output.path}`);
      if (fileStat.size !== output.bytes) errors.push(`${name} 字节数不一致：manifest=${output.bytes}，实际=${fileStat.size}`);
    } catch {
      errors.push(`${name} 输出文件不存在：${output.path}`);
    }
  }
  if (totalOutputBytes > maxTotalOutputBytes) errors.push(`生成产物总大小超过上限：${totalOutputBytes} > ${maxTotalOutputBytes}`);

  for (const [name, output] of Object.entries(manifestOutputs || {})) {
    if (!manifestGroups?.[output.group]) errors.push(`${name} 指向不存在的 group：${output.group}`);
    else if (!manifestGroups[output.group].outputs.includes(name)) errors.push(`${name} 未列入 group ${output.group}.outputs`);
  }

  for (const [group, metadata] of Object.entries(manifestGroups || {})) {
    const outputRules = metadata.outputs.reduce((sum, name) => sum + (manifestOutputs?.[name]?.rules || 0), 0);
    if (outputRules !== metadata.rules) errors.push(`group ${group} 规则数不一致：group=${metadata.rules}，outputs=${outputRules}`);
    const dedupeFields = ['normalizedRules', 'duplicateRules', 'coveredRules'];
    if (dedupeFields.some(field => metadata[field] !== undefined)) {
      for (const field of dedupeFields) {
        if (!Number.isInteger(metadata[field]) || metadata[field] < 0) errors.push(`group ${group}.${field} 必须是非负整数：${metadata[field]}`);
      }
      if (metadata.normalizedRules + metadata.duplicateRules !== metadata.inputRules) errors.push(`group ${group} 去重前后统计不一致：normalized + duplicate != input`);
      if (metadata.duplicateRules + metadata.coveredRules !== metadata.pruned) errors.push(`group ${group} 剪枝统计不一致：duplicate + covered != pruned`);
    }
    for (const name of metadata.outputs) {
      if (!manifestOutputs?.[name]) errors.push(`group ${group} 引用了不存在的 output：${name}`);
    }
  }
  if (manifest.summary) {
    const summaryFields = ['groups', 'inputRules', 'normalizedRules', 'duplicateRules', 'coveredRules', 'rules', 'crossGroupRules', 'crossGroupDuplicateOccurrences'];
    for (const field of summaryFields) {
      if (!Number.isInteger(manifest.summary[field]) || manifest.summary[field] < 0) errors.push(`manifest.summary.${field} 必须是非负整数：${manifest.summary[field]}`);
    }
    const groups = Object.values(manifestGroups || {});
    for (const field of ['inputRules', 'normalizedRules', 'duplicateRules', 'coveredRules', 'rules']) {
      const total = groups.reduce((sum, group) => sum + (group[field] || 0), 0);
      if (manifest.summary[field] !== total) errors.push(`manifest.summary.${field} 汇总不一致：summary=${manifest.summary[field]}，groups=${total}`);
    }
    if (manifest.summary.groups !== groups.length) errors.push(`manifest.summary.groups 汇总不一致：summary=${manifest.summary.groups}，groups=${groups.length}`);
  }

  const actualFiles = (await readdir(outputRoot)).filter(name => ['.mrs', '.yaml'].includes(extname(name)));
  for (const file of actualFiles) {
    if (!referencedPaths.has(file)) errors.push(`存在未被 manifest/provider 引用的生成文件：${file}`);
  }
  for (const file of referencedPaths) {
    if (!actualFiles.includes(file)) errors.push(`manifest/provider 引用了不存在的生成文件：${file}`);
  }

  const unknownRuleProviders = setDifference(referencedRuleProviders(config.rules), providerNames);
  for (const name of unknownRuleProviders) errors.push(`rules 引用了未声明的 provider：${name}`);

  fail(errors);
  console.log(`规则契约校验通过：${providerNames.size} providers，${actualFiles.length} outputs，${Object.keys(manifestGroups || {}).length} groups`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
