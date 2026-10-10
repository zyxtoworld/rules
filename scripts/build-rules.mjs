import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dedupeCrossGroupExact, minimizeRuleSet, parseSource, splitRules } from './rule-utils.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceManifestPath = join(repoRoot, 'sources.json');
const outputManifestPath = join(repoRoot, 'rules', 'manifest.json');
const outputRoot = join(repoRoot, 'rules', 'mihomo');
const userAgent = 'zyxtoworld-rules-builder/2.0';
const retryCount = 3;
const sourceConcurrency = 8;
const maxSourceBytes = 20 * 1024 * 1024;
// Keep this layout synchronized with convert.js ruleProviderParts.
// A stable provider layout prevents scheduled upstream refreshes from creating
// missing or unreferenced RULE-SET names in the Sub-Store converter.
const fixedMrsPartitions = {
  ads: { domain: 2 },
};
// Keep synchronized with convert.js rules order. Only exact duplicate rules
// are removed from lower-priority groups; parent-domain and CIDR containment
// are intentionally left untouched.
const runtimeGroupPriority = [
  'private', 'ads', 'privacy', 'cn',
  'openai', 'claude', 'ai', 'biliintl', 'crypto', 'apple', 'download',
  'youtube', 'google', 'github', 'dev', 'telegram', 'twitter', 'social',
  'netflix', 'spotify', 'disney', 'onedrive', 'microsoft', 'cloud',
  'finance', 'shopping', 'tiktok', 'media', 'speedtest', 'games',
  'direct', 'proxy-extra', 'geolocation',
];
const builtInRules = {
  // Local routing infrastructure rules are generated into a dedicated
  // provider instead of being embedded in the Sub-Store converter.
  private: [
    'IP-CIDR,0.0.0.0/8',
    'IP-CIDR,10.0.0.0/8',
    'IP-CIDR,100.64.0.0/10',
    'IP-CIDR,127.0.0.0/8',
    'IP-CIDR,169.254.0.0/16',
    'IP-CIDR,172.16.0.0/12',
    'IP-CIDR,192.168.0.0/16',
    'IP-CIDR,224.0.0.0/4',
    'IP-CIDR,240.0.0.0/4',
    'IP-CIDR6,::1/128',
    'IP-CIDR6,fc00::/7',
    'IP-CIDR6,fe80::/10',
  ],
  // Browser IP checks, WebRTC/STUN/TURN endpoints and app HTTPDNS services.
  // This provider intentionally precedes cn/direct so a domestic third-party
  // endpoint cannot reveal the host address through a direct connection.
  privacy: [
    'DOMAIN-SUFFIX,ifconfig.cc',
    'DOMAIN-SUFFIX,ifconfig.me',
    'DOMAIN-SUFFIX,ifconfig.co',
    'DOMAIN-SUFFIX,checkip.pw',
    'DOMAIN-SUFFIX,checkip.amazonaws.com',
    'DOMAIN-SUFFIX,myip.la',
    'DOMAIN-SUFFIX,myip.com',
    'DOMAIN-SUFFIX,myiplay.com',
    'DOMAIN-SUFFIX,whatismyip.com',
    'DOMAIN-SUFFIX,whatismyipaddress.com',
    'DOMAIN-SUFFIX,icanhazip.com',
    'DOMAIN-SUFFIX,ident.me',
    'DOMAIN-SUFFIX,ipify.org',
    'DOMAIN-SUFFIX,ipinfo.io',
    'DOMAIN-SUFFIX,ipwho.is',
    'DOMAIN-SUFFIX,ipwhois.io',
    'DOMAIN-SUFFIX,ipapi.co',
    'DOMAIN-SUFFIX,ip-api.com',
    'DOMAIN-SUFFIX,ipleak.net',
    'DOMAIN-SUFFIX,ip.sb',
    'DOMAIN-SUFFIX,2ip.io',
    'DOMAIN-SUFFIX,ipaddress.com',
    'DOMAIN-SUFFIX,iplocation.com',
    'DOMAIN-SUFFIX,ipgeolocation.io',
    'DOMAIN-SUFFIX,ipdata.co',
    'DOMAIN-SUFFIX,ipregistry.co',
    'DOMAIN-SUFFIX,db-ip.com',
    'DOMAIN-SUFFIX,qlivewebrtc.com',
    'DOMAIN-SUFFIX,qlivewebrtc2.com',
    'DOMAIN-SUFFIX,tlivewebrtc.com',
    'DOMAIN-SUFFIX,tlivewebrtc2.com',
    'DOMAIN-SUFFIX,tlivewebrtcpush.com',
    'DOMAIN-SUFFIX,tlivewebrtcpush2.com',
    'DOMAIN-SUFFIX,tlivewebrtcpushsch.com',
    'DOMAIN-SUFFIX,tlivewebrtcpushsch2.com',
    'DOMAIN-SUFFIX,webrtc.win',
    'DOMAIN-SUFFIX,webrtc.org',
    'DOMAIN-SUFFIX,stunnel.vip',
    'DOMAIN,stun.l.google.com',
    'DOMAIN,stun1.l.google.com',
    'DOMAIN,stun2.l.google.com',
    'DOMAIN,stun3.l.google.com',
    'DOMAIN,stun4.l.google.com',
    'DOMAIN,stun.services.mozilla.com',
    'DOMAIN,global.stun.twilio.com',
    'DOMAIN-SUFFIX,stun.cloudflare.com',
    'DOMAIN-SUFFIX,stun.nextcloud.com',
    'DOMAIN-SUFFIX,stun.sipgate.net',
    'DOMAIN-SUFFIX,stun.voipbuster.com',
    'DOMAIN-SUFFIX,stun.ekiga.net',
    'DOMAIN-SUFFIX,stun.ideasip.com',
    'DOMAIN-SUFFIX,stun.antisip.com',
    'DOMAIN-SUFFIX,stun.freeswitch.org',
    'DOMAIN-SUFFIX,stun.stunprotocol.org',
    'DOMAIN-SUFFIX,turn.livekit.cloud',
    'DOMAIN-SUFFIX,okx-httpdns.com',
    'DOMAIN-SUFFIX,okx-dns.com',
    'DOMAIN-SUFFIX,okx-dns1.com',
    'DOMAIN-SUFFIX,okx-dns2.com',
    'DOMAIN-SUFFIX,httpdns.alipay.com',
    'DOMAIN-SUFFIX,httpdns.aliyuncs.com',
    'DOMAIN-SUFFIX,httpdns.taobao.com',
    'DOMAIN-SUFFIX,httpdns.bilivideo.com',
    'DOMAIN-SUFFIX,httpdns.baidubce.com',
    'DOMAIN-SUFFIX,httpdns.n.netease.com',
    'DOMAIN-SUFFIX,httpdns.music.163.com',
    'DOMAIN-SUFFIX,httpdns.weixin.qq.com',
    'DOMAIN-SUFFIX,httpdns.gslb.yy.com',
    'DOMAIN-SUFFIX,httpdns.volcengine.com',
    'DOMAIN-SUFFIX,httpdns.bytedance.com',
    'DOMAIN-SUFFIX,httpdns.kuaishou.com',
    'DOMAIN,doh.360.cn',
    'DOMAIN,dns.jd.com',
    'DOMAIN-SUFFIX,httpdns.cdnbye.com',
    'DOMAIN-KEYWORD,stun.',
    'DOMAIN-KEYWORD,turn.',
    'DOMAIN-KEYWORD,webrtc',
    'DOMAIN-KEYWORD,httpdns',
    'DOMAIN-KEYWORD,ipify',
    'DOMAIN-KEYWORD,ifconfig',
    'DOMAIN-KEYWORD,whatismyip',
    'DOMAIN-KEYWORD,checkip',
    'DOMAIN-KEYWORD,icanhazip',
    'DOMAIN-KEYWORD,ipinfo',
    'DOMAIN-KEYWORD,ipwho',
    'DOMAIN-KEYWORD,ipleak',
  ],
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
  crypto: [
    'DOMAIN-SUFFIX,aex.com',
    'DOMAIN-SUFFIX,aicoin.com',
    'DOMAIN-SUFFIX,aimoon.com',
    'DOMAIN-SUFFIX,bibox.com',
    'DOMAIN-SUFFIX,bitcointalk.org',
    'DOMAIN-SUFFIX,bithumb.com',
    'DOMAIN-SUFFIX,coincheck.com',
    'DOMAIN-SUFFIX,coinall.ltd',
    'DOMAIN-SUFFIX,gate.com',
    'DOMAIN-SUFFIX,blastapi.io',
    'DOMAIN-SUFFIX,keplr.app',
    'DOMAIN-SUFFIX,korbit.co.kr',
    'DOMAIN-SUFFIX,okex.org',
    'DOMAIN-SUFFIX,okx-doh.com',
    'DOMAIN-SUFFIX,okx-httpdns.com',
    'DOMAIN-SUFFIX,omni-dex.io',
    'DOMAIN-SUFFIX,pancakeswap.finance',
    'DOMAIN-SUFFIX,phantom.app',
    'DOMAIN-SUFFIX,poloniex.com',
    'DOMAIN-SUFFIX,sushi.com',
  ],
  download: [
    'DOMAIN,github-releases.githubusercontent.com',
    'DOMAIN,release-assets.githubusercontent.com',
    'DOMAIN,raw.githubusercontent.com',
    'DOMAIN,codeload.github.com',
    'DOMAIN,pkg-containers.githubusercontent.com',
    'DOMAIN,production.cloudflare.docker.com',
    'DOMAIN,files.pythonhosted.org',
    'DOMAIN,static.crates.io',
    'DOMAIN,cdn-lfs.huggingface.co',
    'DOMAIN,cas-bridge.xethub.hf.co',
    'DOMAIN,download.visualstudio.microsoft.com',
    'DOMAIN,vscode.download.prss.microsoft.com',
    'DOMAIN,dl.google.com',
    'DOMAIN,edgedl.me.gvt1.com',
    'DOMAIN,dl-ssl.google.com',
    'DOMAIN,download-installer.cdn.mozilla.net',
    'DOMAIN,assets1.xboxlive.com',
    'DOMAIN,assets2.xboxlive.com',
    'DOMAIN,blizzard.gcdn.cloudn.co.kr',
    'DOMAIN,blzddist1-a.akamaihd.net',
    'DOMAIN,blzddistkr1-a.akamaihd.net',
    'DOMAIN,client.hikarifield.co.jp',
    'DOMAIN,content.cdp.bethesda.net',
    'DOMAIN,download.cdp.bethesda.net',
    'DOMAIN,download.dm.origin.com',
    'DOMAIN,download.epicgames.com',
    'DOMAIN,download.hikarifield.co.jp',
    'DOMAIN,download2.epicgames.com',
    'DOMAIN,download3.epicgames.com',
    'DOMAIN,download4.epicgames.com',
    'DOMAIN,edge.steam-dns.top.comcast.net',
    'DOMAIN,epicgames-download1.akamaized.net',
    'DOMAIN,eu.cdn.blizzard.com',
    'DOMAIN,fastly-download.epicgames.com',
    'DOMAIN,gamedownloads-rockstargames-com.akamaized.net',
    'DOMAIN,gog-cdn-lumen.secure2.footprint.net',
    'DOMAIN,kr.cdn.blizzard.com',
    'DOMAIN,level3.blizzard.com',
    'DOMAIN,origin-a.akamaihd.net',
    'DOMAIN,packagespc.xboxlive.com',
    'DOMAIN,ssl-lvlt.cdn.ea.com',
    'DOMAIN,steam.eca.qtlglb.com',
    'DOMAIN,steam.naeu.qtlglb.com',
    'DOMAIN,steam.ru.qtlglb.com',
    'DOMAIN,steampipe-kr.akamaized.net',
    'DOMAIN,steampipe-partner.akamaized.net',
    'DOMAIN,steampipe.akamaized.net',
    'DOMAIN,steamusercontent-a.akamaihd.net',
    'DOMAIN,us.cdn.blizzard.com',
    'DOMAIN,xvcf1.xboxlive.com',
    'DOMAIN,xvcf2.xboxlive.com',
    'DOMAIN-SUFFIX,cdn.ubi.com',
    'DOMAIN-SUFFIX,dyn.riotcdn.net',
    'DOMAIN-SUFFIX,steamcontent.com',
    'PROCESS-NAME,aria2c',
    'PROCESS-NAME,aria2c.exe',
    'PROCESS-NAME,BitComet',
    'PROCESS-NAME,BitComet.exe',
    'PROCESS-NAME,BitComet_x64.exe',
    'PROCESS-NAME,BitTorrent',
    'PROCESS-NAME,BitTorrent.exe',
    'PROCESS-NAME,Deluge',
    'PROCESS-NAME,deluge',
    'PROCESS-NAME,deluge.exe',
    'PROCESS-NAME,deluge-gtk',
    'PROCESS-NAME,deluge-gtk.exe',
    'PROCESS-NAME,deluged',
    'PROCESS-NAME,deluged.exe',
    'PROCESS-NAME,DownloadService',
    'PROCESS-NAME,DownloadService.exe',
    'PROCESS-NAME,dmaster',
    'PROCESS-NAME,dmaster.exe',
    'PROCESS-NAME,EagleGet',
    'PROCESS-NAME,EagleGet.exe',
    'PROCESS-NAME,fdm',
    'PROCESS-NAME,fdm.exe',
    'PROCESS-NAME,fdmd',
    'PROCESS-NAME,fdmd.exe',
    'PROCESS-NAME,FlashGet',
    'PROCESS-NAME,FlashGet.exe',
    'PROCESS-NAME,Folx',
    'PROCESS-NAME,Folx.exe',
    'PROCESS-NAME,FrostWire',
    'PROCESS-NAME,FrostWire.exe',
    'PROCESS-NAME,IDMan',
    'PROCESS-NAME,IDMan.exe',
    'PROCESS-NAME,Internet Download Manager',
    'PROCESS-NAME,Internet Download Manager.exe',
    'PROCESS-NAME,JDownloader',
    'PROCESS-NAME,JDownloader.exe',
    'PROCESS-NAME,JDownloader2',
    'PROCESS-NAME,JDownloader2.exe',
    'PROCESS-NAME,kget',
    'PROCESS-NAME,kget.exe',
    'PROCESS-NAME,MegaDownloader',
    'PROCESS-NAME,MegaDownloader.exe',
    'PROCESS-NAME,MEGAsync',
    'PROCESS-NAME,MEGAsync.exe',
    'PROCESS-NAME,Motrix',
    'PROCESS-NAME,Motrix.exe',
    'PROCESS-NAME,motrix-next',
    'PROCESS-NAME,motrix-next.exe',
    'PROCESS-NAME,motrix-next-engine',
    'PROCESS-NAME,motrix-next-engine.exe',
    'PROCESS-NAME,NeatDM',
    'PROCESS-NAME,NeatDM.exe',
    'PROCESS-NAME,NetTransport',
    'PROCESS-NAME,NetTransport.exe',
    'PROCESS-NAME,Ninja Download Manager',
    'PROCESS-NAME,Ninja Download Manager.exe',
    'PROCESS-NAME,Persepolis',
    'PROCESS-NAME,persepolis',
    'PROCESS-NAME,persepolis.exe',
    'PROCESS-NAME,PicoTorrent',
    'PROCESS-NAME,PicoTorrent.exe',
    'PROCESS-NAME,qbittorrent',
    'PROCESS-NAME,qbittorrent.exe',
    'PROCESS-NAME,qBittorrent',
    'PROCESS-NAME,qBittorrent.exe',
    'PROCESS-NAME,Tixati',
    'PROCESS-NAME,Tixati.exe',
    'PROCESS-NAME,Transmission',
    'PROCESS-NAME,Transmission.exe',
    'PROCESS-NAME,transmission-daemon',
    'PROCESS-NAME,transmission-daemon.exe',
    'PROCESS-NAME,transmission-gtk',
    'PROCESS-NAME,transmission-gtk.exe',
    'PROCESS-NAME,transmission-qt',
    'PROCESS-NAME,transmission-qt.exe',
    'PROCESS-NAME,uGet',
    'PROCESS-NAME,uget',
    'PROCESS-NAME,uGet.exe',
    'PROCESS-NAME,uget.exe',
    'PROCESS-NAME,uTorrent',
    'PROCESS-NAME,uTorrent.exe',
    'PROCESS-NAME,uTorrent Web',
    'PROCESS-NAME,uTorrent Web.exe',
    'PROCESS-NAME,Vuze',
    'PROCESS-NAME,Vuze.exe',
    'PROCESS-NAME,WebTorrent',
    'PROCESS-NAME,WebTorrent.exe',
    'PROCESS-NAME,WebTorrent Helper.exe',
    'PROCESS-NAME,WebTorrentHelper',
    'PROCESS-NAME,WebTorrentHelper.exe',
    'PROCESS-NAME,xdman',
    'PROCESS-NAME,xdman.exe',
    'PROCESS-NAME,XDM',
    'PROCESS-NAME,XDM.exe',
    'PROCESS-NAME,XLServicePlatform',
    'PROCESS-NAME,XLServicePlatform.exe',
    'PROCESS-NAME,XLLiveUD',
    'PROCESS-NAME,XLLiveUD.exe',
    'PROCESS-NAME,XunLei',
    'PROCESS-NAME,XunLei.exe',
    'PROCESS-NAME,Xunlei',
    'PROCESS-NAME,Xunlei.exe',
    'PROCESS-NAME,Thunder',
    'PROCESS-NAME,Thunder.exe',
    'PROCESS-NAME,ThunderMini',
    'PROCESS-NAME,ThunderMini.exe',
    'PROCESS-NAME,ThunderPlatform',
    'PROCESS-NAME,ThunderPlatform.exe',
    'PROCESS-NAME,ThunderVIP',
    'PROCESS-NAME,ThunderVIP.exe',
    'PROCESS-NAME,baidunetdisk',
    'PROCESS-NAME,baidunetdisk.exe',
    'PROCESS-NAME,BaiduNetdisk',
    'PROCESS-NAME,BaiduNetdisk.exe',
    'PROCESS-NAME,baidunetdiskhost',
    'PROCESS-NAME,baidunetdiskhost.exe',
    'PROCESS-NAME,BaiduNetdiskHost',
    'PROCESS-NAME,BaiduNetdiskHost.exe',
    'PROCESS-NAME,Weiyun',
    'PROCESS-NAME,Weiyun.exe',
    'PROCESS-NAME,AliYunDrive',
    'PROCESS-NAME,AliYunDrive.exe',
    'PROCESS-NAME,aliyundrive',
    'PROCESS-NAME,aliyundrive.exe',
    'PROCESS-NAME,aDrive',
    'PROCESS-NAME,aDrive.exe',
    'PROCESS-NAME,QuarkCloudDrive',
    'PROCESS-NAME,QuarkCloudDrive.exe',
    'PROCESS-NAME,QuarkNetdisk',
    'PROCESS-NAME,QuarkNetdisk.exe',
    'PROCESS-NAME,115',
    'PROCESS-NAME,115.exe',
    'PROCESS-NAME,115Desktop',
    'PROCESS-NAME,115Desktop.exe',
    'PROCESS-NAME,123pan',
    'PROCESS-NAME,123pan.exe',
  ],
  youtube: [
    'IP-CIDR,172.110.32.0/21',
    'IP-CIDR,216.73.80.0/20',
    'IP-CIDR6,2620:120:e000::/40',
  ],
  telegram: [
    'DOMAIN,api.imem.app',
    'DOMAIN,api.swiftgram.app',
    'DOMAIN-SUFFIX,mbrx.app',
    'DOMAIN-SUFFIX,stel.com',
    'DOMAIN-SUFFIX,telegramdownload.com',
    'DOMAIN-KEYWORD,nicegram',
    'IP-CIDR,5.28.192.0/18',
    'IP-CIDR,91.108.0.0/16',
    'IP-CIDR,109.239.140.0/24',
    'IP-CIDR,139.59.210.98/32',
    'IP-CIDR,149.154.160.0/20',
    'IP-CIDR,196.55.216.167/32',
    'IP-CIDR6,2001:67c:4e8::/48',
    'IP-CIDR6,2001:b28:f23c::/47',
    'IP-CIDR6,2001:b28:f23f::/48',
    'IP-CIDR6,2a0a:f280::/32',
    'PROCESS-NAME,Telegram.exe',
    'PROCESS-NAME,nekox.messenger',
    'PROCESS-NAME,org.telegram.messenger',
    'PROCESS-NAME,telegram-desktop',
    'PROCESS-NAME,tw.nekomimi.nekogram',
    'PROCESS-NAME,xyz.nextalone.nagram',
  ],
  netflix: [
    'DOMAIN,e13252.dscg.akamaiedge.net',
    'DOMAIN,h-netflix.online-metrix.net',
    'DOMAIN,netflix.com.edgesuite.net',
    'DOMAIN-KEYWORD,apiproxy-device-prod-nlb-',
    'DOMAIN-KEYWORD,dualstack.apiproxy-',
    'DOMAIN-KEYWORD,dualstack.ichnaea-web-',
    'DOMAIN-KEYWORD,netflixdnstest',
    'PROCESS-NAME,com.netflix.mediaclient',
  ],
  spotify: [
    'DOMAIN-SUFFIX,byspotify.com',
    'DOMAIN-SUFFIX,pscdn.co',
    'DOMAIN-SUFFIX,scdn.co',
    'DOMAIN-SUFFIX,spoti.fi',
    'DOMAIN-SUFFIX,spotify-everywhere.com',
    'DOMAIN-SUFFIX,spotify.app.link',
    'DOMAIN-SUFFIX,spotify.com',
    'DOMAIN-SUFFIX,spotify.design',
    'DOMAIN-SUFFIX,spotify.link',
    'DOMAIN-SUFFIX,spotifycdn.com',
    'DOMAIN-SUFFIX,spotifycdn.net',
    'DOMAIN-SUFFIX,spotifycharts.com',
    'DOMAIN-SUFFIX,spotifycodes.com',
    'DOMAIN-SUFFIX,spotifyforbrands.com',
    'DOMAIN-SUFFIX,spotifyforvendors.com',
    'DOMAIN-SUFFIX,spotifyjobs.com',
    'DOMAIN-SUFFIX,spotifynewsroom.jp',
    'DOMAIN-SUFFIX,spotilocal.com',
    'DOMAIN-SUFFIX,tospotify.com',
    'DOMAIN-SUFFIX,audio-ak-spotify-com.akamaized.net',
    'DOMAIN-SUFFIX,heads4-ak-spotify-com.akamaized.net',
    'DOMAIN-SUFFIX,spotify-com.akamaized.net',
    'DOMAIN,audio4-ak-spotify-com.akamaized.net',
    'DOMAIN,cdn-spotify-experiments.conductrics.com',
    'DOMAIN,heads-ak-spotify-com.akamaized.net',
    'DOMAIN,spotify.map.fastly.net',
    'DOMAIN,spotify.map.fastlylb.net',
    'DOMAIN,spotify.com.edgesuite.net',
    'DOMAIN-KEYWORD,spotify',
    'PROCESS-NAME,com.spotify.music',
    'IP-CIDR,104.154.127.126/32',
    'IP-CIDR,35.186.224.47/32',
  ],
};
const builtInRuleSourceNames = {
  private: 'built-in: private network ranges',
  privacy: 'built-in: privacy, IP-check, WebRTC/STUN/TURN and HTTPDNS endpoints',
  ai: 'built-in: Gemini mobile and API dependencies',
  apple: 'built-in: Apple Intelligence and Siri hosts',
  crypto: 'built-in: cryptocurrency service domains',
  download: 'built-in: download CDN domains',
  youtube: 'built-in: YouTube IP ranges',
  telegram: 'built-in: Telegram service rules',
  netflix: 'built-in: Netflix service rules',
  spotify: 'built-in: Spotify service rules',
};
const maxMrsBytes = 1_400_000;

function jsdelivrMirrorUrl(url) {
  const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return match ? `https://testingcf.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}` : null;
}

async function fetchText(url) {
  const candidates = [...new Set([jsdelivrMirrorUrl(url), url].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch(candidate, { headers: { 'user-agent': userAgent }, signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > maxSourceBytes) throw new Error(`source exceeds ${maxSourceBytes} bytes`);
        const sha256 = createHash('sha256').update(body).digest('hex');
        const text = body.toString('utf8');
        if (/^<!doctype html|^<html[\s>]/i.test(text.trimStart())) throw new Error('source returned HTML instead of a rule list');
        return {
          text,
          bytes: body.byteLength,
          sha256,
          fetchedUrl: candidate,
        };
      } catch (error) {
        lastError = error;
        if (attempt < retryCount) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 1500));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`${url}: ${lastError?.message || 'fetch failed'}`);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function fetchSources(group, sources) {
  return mapWithConcurrency(sources, sourceConcurrency, async source => {
    process.stdout.write(`fetch ${group}: ${source.url}\n`);
    const fetched = await fetchText(source.url);
    if (source.sha256 && source.sha256.toLowerCase() !== fetched.sha256) {
      throw new Error(`${source.url}: sha256 mismatch; expected ${source.sha256}, got ${fetched.sha256}`);
    }
    const parsed = parseSource(fetched.text, source);
    return {
      source,
      parsed,
      metadata: {
        url: source.url,
        fetchedUrl: fetched.fetchedUrl,
        source: source.source,
        rules: parsed.length,
        bytes: fetched.bytes,
        sha256: fetched.sha256,
      },
    };
  });
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

async function moveIfExists(from, to) {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceGeneratedOutputs(stagedOutputRoot, stagedManifestPath) {
  const token = `${process.pid}-${Date.now()}`;
  const backupRoot = `${outputRoot}.backup-${token}`;
  const backupManifest = `${outputManifestPath}.backup-${token}`;
  let oldRootMoved = false;
  let oldManifestMoved = false;
  let newRootMoved = false;
  let newManifestMoved = false;
  try {
    oldManifestMoved = await moveIfExists(outputManifestPath, backupManifest);
    oldRootMoved = await moveIfExists(outputRoot, backupRoot);
    await rename(stagedOutputRoot, outputRoot);
    newRootMoved = true;
    await rename(stagedManifestPath, outputManifestPath);
    newManifestMoved = true;
    await rm(backupManifest, { force: true });
    await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (newManifestMoved) await rm(outputManifestPath, { force: true });
    if (oldManifestMoved) await moveIfExists(backupManifest, outputManifestPath);
    if (newRootMoved) await rm(outputRoot, { recursive: true, force: true });
    if (oldRootMoved) await moveIfExists(backupRoot, outputRoot);
    throw error;
  } finally {
    await rm(backupManifest, { force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }
}

const binary = await resolveMihomoBinary();
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
const tempRoot = await mkdtemp(join(tmpdir(), 'zyxtoworld-rules-'));
const stagedOutputRoot = await mkdtemp(join(dirname(outputRoot), '.mihomo-stage-'));
const stagedManifestPath = join(dirname(outputManifestPath), `.manifest-${process.pid}-${Date.now()}.tmp`);
const metadata = {
  schemaVersion: 2,
  sources: {},
  outputs: {},
  groups: {},
};
const ruleGroupIndex = new Map();
let committed = false;

try {
  const preparedGroups = new Map();
  for (const [group, sources] of Object.entries(sourceManifest.sources)) {
    const collected = [];
    const fetchedSources = await fetchSources(group, sources);
    metadata.sources[group] = fetchedSources.map(result => result.metadata);
    for (const result of fetchedSources) {
      for (const rule of result.parsed) collected.push(rule);
    }

    const extraRules = builtInRules[group] || [];
    if (extraRules.length) {
      collected.push(...extraRules);
      metadata.sources[group].push({ source: builtInRuleSourceNames[group] || `built-in: ${group}`, rules: extraRules.length });
    }

    const minimized = minimizeRuleSet(collected);
    preparedGroups.set(group, { minimized });
    for (const rule of minimized.rules) {
      let groups = ruleGroupIndex.get(rule);
      if (!groups) {
        groups = new Set();
        ruleGroupIndex.set(rule, groups);
      }
      groups.add(group);
    }
  }

  const groupRules = new Map([...preparedGroups].map(([group, { minimized }]) => [group, minimized.rules]));
  const { deduped, removed } = dedupeCrossGroupExact(groupRules, runtimeGroupPriority);
  for (const [group, { minimized }] of preparedGroups) {
    const rules = deduped.get(group) || [];
    let crossGroupPruned = removed.get(group) || 0;
    const originalPartitions = splitRules(minimized.rules);
    const partitions = splitRules(rules);
    for (const kind of Object.keys(partitions)) {
      if (partitions[kind].length === 0 && originalPartitions[kind].length > 0) {
        // Keep one redundant anchor so convert.js keeps its fixed provider layout.
        partitions[kind] = [originalPartitions[kind][0]];
        crossGroupPruned -= 1;
      }
    }
    const outputRuleCount = Object.values(partitions).reduce((sum, partition) => sum + partition.length, 0);
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
        const outputPath = join(stagedOutputRoot, fileName);
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
      inputRules: minimized.inputRules,
      normalizedRules: minimized.normalizedRules,
      duplicateRules: minimized.duplicateRules,
      coveredRules: minimized.coveredRules,
      crossGroupPruned,
      rules: outputRuleCount,
      pruned: minimized.inputRules - outputRuleCount,
      outputs: files,
    };
  }

  const crossGroupRules = [...ruleGroupIndex.values()].filter(groups => groups.size > 1);
  metadata.summary = {
    groups: Object.keys(metadata.groups).length,
    inputRules: Object.values(metadata.groups).reduce((sum, group) => sum + group.inputRules, 0),
    normalizedRules: Object.values(metadata.groups).reduce((sum, group) => sum + group.normalizedRules, 0),
    duplicateRules: Object.values(metadata.groups).reduce((sum, group) => sum + group.duplicateRules, 0),
    coveredRules: Object.values(metadata.groups).reduce((sum, group) => sum + group.coveredRules, 0),
    rules: Object.values(metadata.groups).reduce((sum, group) => sum + group.rules, 0),
    crossGroupPruned: Object.values(metadata.groups).reduce((sum, group) => sum + group.crossGroupPruned, 0),
    crossGroupRules: crossGroupRules.length,
    crossGroupDuplicateOccurrences: crossGroupRules.reduce((sum, groups) => sum + groups.size - 1, 0),
  };

  await writeFile(stagedManifestPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await replaceGeneratedOutputs(stagedOutputRoot, stagedManifestPath);
  committed = true;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  if (!committed) await rm(stagedOutputRoot, { recursive: true, force: true });
  await rm(stagedManifestPath, { force: true });
}
