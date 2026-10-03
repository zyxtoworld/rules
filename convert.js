// ============================================================================
// OneSmartPro MCX - Sub-Store 订阅转换脚本（最终版）
// ----------------------------------------------------------------------------
// 功能：
//   0. 节点去重：按除 name 外的完整节点配置做稳定比较；重复时优先保留能识别
//      出地区的节点名；同名但配置不同的节点自动追加序号，避免 mihomo 重名冲突。
//   1. 地区分组全自动：识别 国旗 emoji / 中文·英文全称 / 国家简写(大小写)，
//      覆盖 ISO 3166-1 全部 250 个国家/地区，有节点才建组。
//   2. 旗帜纠正：文字判定优先于旗帜，机场标错的旗帜（如把台湾标成🇨🇳）会被
//      自动改成正确旗帜后再分组；无旗节点自动补旗。
//   3. 功能分组智能化：AI/YouTube/Netflix/Telegram 等，偏好地区靠前 +
//      其余全部地区兜底，可选全地区。
//   4. 规则运行时使用自有 zyxtoworld/rules 聚合 provider；MetaCubeX、blackmatrix7
//      和 Loyalsoldier 只在规则仓库构建阶段拉取，客户端不再分别访问上游。
//   5. 下载资源低倍率：自动识别节点名里的 0.x 倍率/低倍率/省流 标记，
//      专用下载器访问已知非中国域名或非中国 IP、以及明确文件/CDN/blob 下载资源域名，
//      优先走最低倍率可用节点。
//   6. 不输出客户端通用开关：端口/API/TUN/DNS/Sniffer/IPv6/Allow-LAN/Mode 等
//      由 Clash Verge Rev、ClashMi、Nikki 自己管理，订阅只负责节点、策略组和规则。
//
// 重要：Sub-Store 对 mihomoProfile 类型文件调用的是 main(config)，而非
//   operator(proxies)。引擎会先走 func 路径并以 operator 返回值为准，抢在
//   main 之前“成功”。因此 operator 在收到 mihomoProfile 输入对象时主动抛错，
//   迫使引擎回退到 nodeFunc 路径执行 main(config)。
// ============================================================================

// mihomoProfile 入口
async function main(config) {
  const proxies = (config && Array.isArray(config.proxies)) ? config.proxies : [];
  return buildConfig(proxies);
}

// 订阅/集合入口；mihomoProfile 场景下主动抛错以回退到 main
function operator(proxies) {
  // Sub-Store passes node lists as arrays. Any object input belongs to the
  // mihomoProfile/file path and must fall back instead of becoming 0 nodes.
  if (proxies && !Array.isArray(proxies)) throw new Error('fallback to nodeFunc/main for non-array input');
  return buildConfig(Array.isArray(proxies) ? proxies : []);
}

function buildConfig(proxies) {
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }
  function proxyDedupKey(proxy) {
    const normalized = {};
    for (const key of Object.keys(proxy || {}).sort()) {
      if (key === 'name') continue;
      normalized[key] = proxy[key];
    }
    return stableStringify(normalized);
  }
  function dedupeProxies(list, rankProxy) {
    const entries = new Map();
    for (let index = 0; index < list.length; index++) {
      const proxy = list[index];
      if (!proxy || typeof proxy !== 'object') continue;
      const key = proxyDedupKey(proxy);
      const score = rankProxy ? rankProxy(proxy) : 0;
      const current = entries.get(key);
      if (!current) {
        entries.set(key, { proxy, firstIndex: index, score });
        continue;
      }
      if (score > current.score) {
        current.proxy = proxy;
        current.score = score;
      }
    }
    return [...entries.values()]
      .sort((a, b) => a.firstIndex - b.firstIndex)
      .map(entry => entry.proxy);
  }
  function ensureUniqueProxyNames(list) {
    const used = new Map();
    for (const proxy of list) {
      const baseName = String(proxy.name || '未命名节点').trim() || '未命名节点';
      const count = used.get(baseName) || 0;
      used.set(baseName, count + 1);
      if (count === 0) {
        proxy.name = baseName;
        continue;
      }
      let nextName;
      let suffix = count + 1;
      do {
        nextName = `${baseName} #${suffix}`;
        suffix += 1;
      } while (used.has(nextName));
      used.set(nextName, 1);
      proxy.name = nextName;
    }
  }

  // ===== ISO 3166-1 国家/地区码 -> 中文名（全球 250 个）=====
  // 不在表内的代码：带国旗仍能建组，组名退化为 ISO 码，节点零遗漏。
  const ISO_CN = {
    AD:"安道尔", AE:"阿联酋", AF:"阿富汗", AG:"安提瓜和巴布达", AI:"安圭拉", AL:"阿尔巴尼亚", AM:"亚美尼亚", AO:"安哥拉",
    AQ:"南极洲", AR:"阿根廷", AS:"美属萨摩亚", AT:"奥地利", AU:"澳大利亚", AW:"阿鲁巴", AX:"奥兰群岛", AZ:"阿塞拜疆",
    BA:"波黑", BB:"巴巴多斯", BD:"孟加拉国", BE:"比利时", BF:"布基纳法索", BG:"保加利亚", BH:"巴林", BI:"布隆迪",
    BJ:"贝宁", BL:"圣巴泰勒米", BM:"百慕大", BN:"文莱", BO:"玻利维亚", BQ:"博奈尔", BR:"巴西", BS:"巴哈马",
    BT:"不丹", BV:"布韦岛", BW:"博茨瓦纳", BY:"白俄罗斯", BZ:"伯利兹", CA:"加拿大", CC:"科科斯群岛", CD:"刚果(金)",
    CF:"中非", CG:"刚果(布)", CH:"瑞士", CI:"科特迪瓦", CK:"库克群岛", CL:"智利", CM:"喀麦隆", CN:"中国大陆",
    CO:"哥伦比亚", CR:"哥斯达黎加", CU:"古巴", CV:"佛得角", CW:"库拉索", CX:"圣诞岛", CY:"塞浦路斯", CZ:"捷克",
    DE:"德国", DJ:"吉布提", DK:"丹麦", DM:"多米尼克", DO:"多米尼加", DZ:"阿尔及利亚", EC:"厄瓜多尔", EE:"爱沙尼亚",
    EG:"埃及", EH:"西撒哈拉", ER:"厄立特里亚", ES:"西班牙", ET:"埃塞俄比亚", FI:"芬兰", FJ:"斐济", FK:"福克兰群岛",
    FM:"密克罗尼西亚", FO:"法罗群岛", FR:"法国", GA:"加蓬", GB:"英国", GD:"格林纳达", GE:"格鲁吉亚", GF:"法属圭亚那",
    GG:"根西", GH:"加纳", GI:"直布罗陀", GL:"格陵兰", GM:"冈比亚", GN:"几内亚", GP:"瓜德罗普", GQ:"赤道几内亚",
    GR:"希腊", GS:"南乔治亚", GT:"危地马拉", GU:"关岛", GW:"几内亚比绍", GY:"圭亚那", HK:"香港", HM:"赫德岛",
    HN:"洪都拉斯", HR:"克罗地亚", HT:"海地", HU:"匈牙利", ID:"印尼", IE:"爱尔兰", IL:"以色列", IM:"马恩岛",
    IN:"印度", IO:"英属印度洋领地", IQ:"伊拉克", IR:"伊朗", IS:"冰岛", IT:"意大利", JE:"泽西", JM:"牙买加",
    JO:"约旦", JP:"日本", KE:"肯尼亚", KG:"吉尔吉斯斯坦", KH:"柬埔寨", KI:"基里巴斯", KM:"科摩罗", KN:"圣基茨和尼维斯",
    KP:"朝鲜", KR:"韩国", KW:"科威特", KY:"开曼群岛", KZ:"哈萨克斯坦", LA:"老挝", LB:"黎巴嫩", LC:"圣卢西亚",
    LI:"列支敦士登", LK:"斯里兰卡", LR:"利比里亚", LS:"莱索托", LT:"立陶宛", LU:"卢森堡", LV:"拉脱维亚", LY:"利比亚",
    MA:"摩洛哥", MC:"摩纳哥", MD:"摩尔多瓦", ME:"黑山", MF:"法属圣马丁", MG:"马达加斯加", MH:"马绍尔群岛", MK:"北马其顿",
    ML:"马里", MM:"缅甸", MN:"蒙古", MO:"澳门", MP:"北马里亚纳群岛", MQ:"马提尼克", MR:"毛里塔尼亚", MS:"蒙特塞拉特",
    MT:"马耳他", MU:"毛里求斯", MV:"马尔代夫", MW:"马拉维", MX:"墨西哥", MY:"马来西亚", MZ:"莫桑比克", NA:"纳米比亚",
    NC:"新喀里多尼亚", NE:"尼日尔", NF:"诺福克岛", NG:"尼日利亚", NI:"尼加拉瓜", NL:"荷兰", NO:"挪威", NP:"尼泊尔",
    NR:"瑙鲁", NU:"纽埃", NZ:"新西兰", OM:"阿曼", PA:"巴拿马", PE:"秘鲁", PF:"法属波利尼西亚", PG:"巴布亚新几内亚",
    PH:"菲律宾", PK:"巴基斯坦", PL:"波兰", PM:"圣皮埃尔和密克隆", PN:"皮特凯恩群岛", PR:"波多黎各", PS:"巴勒斯坦", PT:"葡萄牙",
    PW:"帕劳", PY:"巴拉圭", QA:"卡塔尔", RE:"留尼汪", RO:"罗马尼亚", RS:"塞尔维亚", RU:"俄罗斯", RW:"卢旺达",
    SA:"沙特阿拉伯", SB:"所罗门群岛", SC:"塞舌尔", SD:"苏丹", SE:"瑞典", SG:"新加坡", SH:"圣赫勒拿", SI:"斯洛文尼亚",
    SJ:"斯瓦尔巴", SK:"斯洛伐克", SL:"塞拉利昂", SM:"圣马力诺", SN:"塞内加尔", SO:"索马里", SR:"苏里南", SS:"南苏丹",
    ST:"圣多美和普林西比", SV:"萨尔瓦多", SX:"荷属圣马丁", SY:"叙利亚", SZ:"斯威士兰", TC:"特克斯和凯科斯群岛", TD:"乍得", TF:"法属南方领地",
    TG:"多哥", TH:"泰国", TJ:"塔吉克斯坦", TK:"托克劳", TL:"东帝汶", TM:"土库曼斯坦", TN:"突尼斯", TO:"汤加",
    TR:"土耳其", TT:"特立尼达和多巴哥", TV:"图瓦卢", TW:"台湾", TZ:"坦桑尼亚", UA:"乌克兰", UG:"乌干达", UM:"美国本土外小岛屿",
    US:"美国", UY:"乌拉圭", UZ:"乌兹别克斯坦", VA:"梵蒂冈", VC:"圣文森特和格林纳丁斯", VE:"委内瑞拉", VG:"英属维尔京群岛", VI:"美属维尔京群岛",
    VN:"越南", VU:"瓦努阿图", WF:"瓦利斯和富图纳", WS:"萨摩亚", XK:"科索沃", YE:"也门", YT:"马约特", ZA:"南非",
    ZM:"赞比亚", ZW:"津巴布韦",
  };

  // ISO 码 -> 国旗 emoji（程序生成）
  function flagFromIso(iso) {
    if (!/^[A-Z]{2}$/.test(iso)) return '';
    return String.fromCodePoint(...[...iso].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }
  // 地区组显示名：表内用中文名，表外退化为 ISO 码，统一带国旗
  function regionLabel(iso) {
    return `${flagFromIso(iso)} ${ISO_CN[iso] || iso}`;
  }

  // 文字关键词 -> ISO。中文名从 ISO_CN 自动生成（覆盖 250 国），再并入城市/英文/繁体别名。
  // 按关键词长度降序匹配，避免子串截胡（如"印度尼西亚"先于"印度"命中）。
  const EXTRA_ALIAS = [
    ['台灣|Taiwan', 'TW'], ['澳門|Macao|Macau', 'MO'],
    ['HongKong|Hong Kong', 'HK'], ['狮城|Singapore', 'SG'],
    ['东京|大阪|Japan|Tokyo|Osaka', 'JP'], ['首尔|韓國|Korea|Seoul', 'KR'],
    ['新泽西|New Jersey|美國|United States|America|圣何塞|硅谷|洛杉矶|San Jose|Los Angeles', 'US'],
    ['英國|伦敦|United Kingdom|Britain|London', 'GB'],
    ['德國|法兰克福|Germany|Frankfurt', 'DE'], ['法國|巴黎|France|Paris', 'FR'],
    ['Canada', 'CA'], ['澳洲|悉尼|Australia|Sydney', 'AU'],
    ['孟买|India|Mumbai', 'IN'], ['迪拜|Dubai|UAE', 'AE'],
    ['苏黎世|Switzerland|Zurich', 'CH'], ['莫斯科|Russia|Moscow', 'RU'],
    ['吉隆坡|Malaysia', 'MY'], ['雅加达|Indonesia|Jakarta', 'ID'],
    ['Turkey', 'TR'], ['Vietnam', 'VN'], ['Thailand', 'TH'], ['Philippines', 'PH'],
    ['Netherlands', 'NL'], ['Sweden', 'SE'], ['Norway', 'NO'], ['Finland', 'FI'],
    ['Poland', 'PL'], ['Spain', 'ES'], ['Italy', 'IT'], ['Brazil', 'BR'],
    ['Argentina', 'AR'], ['Mexico', 'MX'], ['New Zealand', 'NZ'],
    ['South Africa', 'ZA'], ['Ireland', 'IE'], ['Saudi', 'SA'], ['Israel', 'IL'],
  ];
  const KEYWORD_TO_ISO = (() => {
    const list = [];
    for (const iso in ISO_CN) list.push([ISO_CN[iso].toLowerCase(), iso]); // 250 国中文名
    for (const [kw, iso] of EXTRA_ALIAS) for (const k of kw.split('|')) list.push([k.toLowerCase(), iso]);
    return list.sort((a, b) => b[0].length - a[0].length);       // 长名优先，防截胡
  })();
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function providerPattern(names) {
    const alternatives = names.map(escapeRegExp).join('|');
    return new RegExp(`(^|[^A-Za-z0-9])(?:${alternatives})(?=$|[^A-Za-z0-9])`, 'i');
  }

  // 运营商/线路名 -> ISO。仅收录高置信别名，跨国品牌/普通词不强行映射。
  const PROVIDER_ALIAS = [
    [['AT&T', 'AT＆T', 'ATT', 'Verizon', 'Comcast', 'Cox Communications', 'Charter Communications'], 'US'],
    [['NTT', 'NTTPC', 'KDDI', 'SoftBank', 'Softbank', 'Docomo', 'IIJ', 'So-net', 'BBTEC'], 'JP'],
    [['SKB', 'SK Broadband', 'SKT', 'KT', 'Korea Telecom', 'LG U+', 'LGU+', 'LG Dacom', 'LGDACOM'], 'KR'],
    [['PCCW', 'HKT', 'HKBN', 'HGC', 'CMHK', 'SmarTone', 'WTT'], 'HK'],
    [['HiNet', 'Chunghwa', 'CHT', 'Taiwan Mobile', 'TWM', 'FarEasTone', 'FET'], 'TW'],
    [['Singtel', 'StarHub', 'M1', 'MyRepublic SG'], 'SG'],
    [['British Telecom', 'BT Broadband', 'Virgin Media UK', 'TalkTalk', 'Sky Broadband'], 'GB'],
    [['Deutsche Telekom'], 'DE'],
    [['Free SAS', 'Free Telecom', 'Bouygues Telecom', 'SFR'], 'FR'],
    [['KPN', 'Ziggo'], 'NL'],
    [['Bell Canada', 'Rogers', 'Telus', 'Shaw Communications'], 'CA'],
    [['Telstra', 'Optus', 'Aussie Broadband', 'TPG Telecom', 'iiNet'], 'AU'],
    [['Spark NZ', 'One NZ', '2degrees'], 'NZ'],
    [['Jio', 'BSNL', 'ACT Fibernet'], 'IN'],
    [['Viettel', 'VNPT', 'FPT Telecom', 'Mobifone', 'Vinaphone'], 'VN'],
    [['AIS', 'TrueOnline', 'TrueMove', '3BB', 'CAT Telecom', 'TOT'], 'TH'],
    [['Telekom Malaysia', 'TM Net', 'Maxis', 'Time Fibre', 'Celcom'], 'MY'],
    [['Telkom Indonesia', 'Telkomsel', 'Biznet', 'Indosat', 'XL Axiata', 'First Media'], 'ID'],
    [['PLDT', 'Globe Telecom', 'Converge ICT', 'Smart Communications'], 'PH'],
    [['Telmex', 'Telcel', 'Totalplay', 'Axtel', 'Izzi'], 'MX'],
    [['Telecom Argentina', 'Fibertel', 'Personal Argentina'], 'AR'],
    [['VTR', 'Entel Chile', 'GTD'], 'CL'],
    [['Turk Telekom', 'Turkcell', 'Superonline'], 'TR'],
    [['Rostelecom', 'MegaFon'], 'RU'],
    [['Kyivstar', 'Ukrtelecom', 'Lifecell'], 'UA'],
    [['Orange Polska', 'Netia'], 'PL'],
    [['Fastweb', 'WindTre'], 'IT'],
    [['Jazztel', 'MasMovil'], 'ES'],
    [['Swisscom', 'Salt Mobile'], 'CH'],
    [['Bahnhof'], 'SE'],
    [['Altibox', 'NextGenTel'], 'NO'],
    [['Elisa Finland', 'DNA Finland'], 'FI'],
    [['YouSee', 'Stofa'], 'DK'],
    [['Eir', 'Virgin Media Ireland'], 'IE'],
    [['Bezeq', 'Partner Israel', 'Cellcom Israel'], 'IL'],
    [['Etisalat UAE', 'Emirates Integrated Telecommunications'], 'AE'],
    [['Saudi Telecom', 'Mobily', 'Zain KSA'], 'SA'],
    [['Telkom SA', 'Vodacom South Africa'], 'ZA'],
    [['Telecom Egypt'], 'EG'],
    [['RCS RDS', 'Digi Romania'], 'RO'],
    [['O2 Czech', 'CETIN'], 'CZ'],
    [['OTE', 'Cosmote'], 'GR'],
    [['PTCL', 'Jazz Pakistan', 'Zong'], 'PK'],
    [['Grameenphone', 'Banglalink'], 'BD'],
    [['Ncell', 'Nepal Telecom'], 'NP'],
    [['Dialog Axiata', 'SLT Mobitel'], 'LK'],
    [['Kazakhtelecom', 'Kcell'], 'KZ'],
    [['Uzbektelecom', 'Ucell'], 'UZ'],
    [['China Telecom', 'China Unicom', 'China Mobile', 'CMCC', 'CERNET'], 'CN'],
  ].map(([names, iso]) => [providerPattern(names), iso]);
  // 两字母 ISO 简写（独立成词，避免匹配单词/拼音内部）
  const ABBR_SET = new Set([
    'HK','TW','MO','JP','SG','US','KR','GB','UK','DE','FR','CA','AU','IN','AE',
    'CH','RU','MY','ID','TR','VN','TH','PH','NL','SE','NO','FI','PL','ES','IT',
    'BR','AR','MX','NZ','ZA','IE','SA','IL','CN',
  ]);
  const ABBR_ALIAS = { UK: 'GB' };
  // 小写歧义码：同时是英文常用词，小写时不识别（大写仍识别）
  const LOWER_BLOCK = new Set([
    'IN','IT','NO','MY','ID','DE','ES','TH','PH','CA','AU','RU','AR','SA','IE','IL','TR','NZ','SE','FI',
  ]);
  function isoFromAbbr(name) {
    const text = String(name || '');
    let m = text.match(/(?<![A-Za-z])[A-Z]{2}(?![A-Za-z])/g);     // 大写优先
    if (m) for (const c of m) { if (ABBR_SET.has(c)) return ABBR_ALIAS[c] || c; }
    m = text.match(/(?<![A-Za-z])[A-Za-z]{2}(?![A-Za-z])/g);      // 含小写，排除歧义码
    if (m) for (const t of m) {
      const c = t.toUpperCase();
      if (ABBR_SET.has(c) && !LOWER_BLOCK.has(c)) return ABBR_ALIAS[c] || c;
    }
    return null;
  }

  // 大区（无具体国家时）
  const MACRO_REGIONS = [
    [/亚洲|亞洲|Asia/i, '🌏 亚洲'],
    [/欧洲|歐洲|Europe/i, '🌍 欧洲'],
    [/美洲|Americas/i, '🌎 美洲'],
  ];

  // 国旗 emoji -> ISO
  function flagPairIso(a, b) {
    if (a < 0x1F1E6 || a > 0x1F1FF || b < 0x1F1E6 || b > 0x1F1FF) return null;
    return String.fromCharCode(a - 0x1F1E6 + 65) + String.fromCharCode(b - 0x1F1E6 + 65);
  }
  function isoFromFlag(name) {
    const ch = Array.from(String(name || ''));
    for (let i = 0; i < ch.length - 1; i++) {
      const a = ch[i].codePointAt(0), b = ch[i + 1].codePointAt(0);
      const iso = flagPairIso(a, b);
      if (iso) return iso;
    }
    return null;
  }
  function regionTargetText(name) {
    const parts = String(name || '').split(/\s*(?:->|=>|→|⇒|➡|➜|»|›)\s*/);
    return parts.length > 1 ? parts[parts.length - 1] : String(name || '');
  }
  function isoByText(name) {
    const target = regionTargetText(name);
    const low = target.toLowerCase();
    for (const [kw, code] of KEYWORD_TO_ISO) {
      // English aliases need letter boundaries so names like "Indiana" do
      // not become India. Digits remain valid delimiters for names like Japan01.
      if (/^[a-z0-9 ]+$/i.test(kw)) {
        const boundary = new RegExp(`(?<![a-z])${escapeRegExp(kw)}(?![a-z])`, 'i');
        if (boundary.test(low)) return code;
      } else if (low.includes(kw)) {
        return code;
      }
    }
    for (const [re, code] of PROVIDER_ALIAS) {
      if (re.test(target)) return code;
    }
    return null;
  }
  // 识别优先级：文字 > 国旗 > 简写
  function isoOf(name) {
    const target = regionTargetText(name);
    return isoByText(name) || isoFromFlag(target) || isoFromFlag(name) || isoFromAbbr(target) || isoFromAbbr(name);
  }
  function detectRegion(name) {
    const iso = isoOf(name);
    if (iso) return regionLabel(iso);
    for (const [re, label] of MACRO_REGIONS) if (re.test(name)) return label;
    return null;
  }
  function regionRank(name) {
    if (isoOf(name)) return 2;
    for (const [re] of MACRO_REGIONS) if (re.test(name)) return 1;
    return 0;
  }
  // 去掉名字开头的国旗 emoji
  function stripLeadingFlag(s) {
    const ch = Array.from(s);
    return leadingFlagIso(s) ? ch.slice(2).join('') : s;
  }
  function leadingFlagIso(name) {
    const ch = Array.from(name);
    if (ch.length < 2) return null;
    const a = ch[0].codePointAt(0), b = ch[1].codePointAt(0);
    return flagPairIso(a, b);
  }

  proxies = dedupeProxies(Array.isArray(proxies) ? proxies : [], proxy => regionRank(proxy.name));

  // ===== 先纠正/补全国旗，再分组 =====
  for (const p of proxies) {
    p.name = String(p.name || '未命名节点').trim() || '未命名节点';
    const target = regionTargetText(p.name);
    const textIso = isoByText(p.name);   // 文字判定（最可信）
    const targetIso = textIso || isoFromFlag(target) || isoFromAbbr(target);
    const leadingIso = leadingFlagIso(p.name);
    const flagIso = isoFromFlag(p.name); // 现有旗帜
    if (targetIso) {
      if (leadingIso !== targetIso) p.name = `${flagFromIso(targetIso)}${stripLeadingFlag(p.name)}`;
      continue;
    }
    if (flagIso) continue;               // 文字判不出但有旗帜，保持
    const abbrIso = isoFromAbbr(regionTargetText(p.name)) || isoFromAbbr(p.name);
    if (abbrIso) { p.name = `${flagFromIso(abbrIso)}${p.name}`; continue; }
    for (const [re, label] of MACRO_REGIONS) {
      if (re.test(p.name)) { p.name = `${label.split(' ')[0]}${p.name}`; break; }
    }
  }
  ensureUniqueProxyNames(proxies);

  // 按地区聚合（有节点才建组），按节点数从多到少排序；无法识别的节点放入独立兜底组。
  const regionMap = {};
  const regionOrder = [];
  const unknownRegionLabel = '❓ 未识别地区';
  const unknownRegionProxies = [];
  for (const p of proxies) {
    const r = detectRegion(p.name);
    if (!r) {
      unknownRegionProxies.push(p.name);
      continue;
    }
    if (!regionMap[r]) { regionMap[r] = []; regionOrder.push(r); }
    regionMap[r].push(p.name);
  }
  regionOrder.sort((a, b) => regionMap[b].length - regionMap[a].length);
  const allRegionGroups = unknownRegionProxies.length
    ? [...regionOrder, unknownRegionLabel]
    : regionOrder.slice();
  const allProxyNames = proxies.map(p => p.name);

  const DIRECT = 'DIRECT';
  const REJECT = 'REJECT';
  const POLICY = {
    manual: '🚀 手动切换',
    auto: '♻️ 自动选择',
    fallback: '⚠️ 故障转移',
    lowRateDownload: '📥 低倍率下载',
    ai: '🤖 AI服务',
    crypto: '💰 加密货币',
    bilibili: '📺 哔哩哔哩国际',
    games: '🎮 游戏平台',
    tiktok: '🎵 TikTok',
    media: '🎬 国际媒体',
    social: '🌐 社交平台',
    dev: '🛠️ 开发服务',
    cloud: '☁️ 云服务',
    finance: '💳 海外金融',
    shopping: '🛍️ 海外购物',
    apple: '🍎 苹果服务',
    telegram: '📲 Telegram',
    youtube: '🎥 YouTube',
    google: '🔍 谷歌服务',
    github: '🐙 GitHub',
    microsoft: 'Ⓜ️ 微软服务',
    twitter: '🐦 Twitter',
    spotify: '🎵 Spotify',
    netflix: '🎥 Netflix',
    speedtest: '📡 Speedtest',
    ads: '🛑 广告拦截',
    leak: '🐟 漏网之鱼'
  };
  function unique(list) {
    return [...new Set(list.filter(Boolean))];
  }

  const autoCandidates = allRegionGroups.length ? allRegionGroups : (allProxyNames.length ? allProxyNames : [DIRECT]);
  const failoverCandidates = allProxyNames.length ? allProxyNames : [DIRECT];

  function rateOfName(name) {
    const text = String(name || '').toLowerCase().replace(/[×＊✕]/g, 'x');
    const lowRateKeyword = /低倍|低倍率|省流|low[-_\s]*rate|low[-_\s]*traffic/.test(text);
    const suffixRate = text.match(/(?:^|[^0-9])([0-9]+(?:\.[0-9]+)?)\s*(?:x|倍|倍率)(?![0-9])/);
    const prefixRate = text.match(/(?:^|[^a-z0-9])(?:x|倍|倍率)\s*([0-9]+(?:\.[0-9]+)?)(?![0-9])/);
    const rate = Number((suffixRate && suffixRate[1]) || (prefixRate && prefixRate[1]));
    if (Number.isFinite(rate) && rate > 0) return rate;
    return lowRateKeyword ? 0.99 : Infinity;
  }
  const lowRateProxyNames = proxies
    .map((p, index) => ({ name: p.name, rate: rateOfName(p.name), index }))
    .filter(p => p.rate < 1)
    .sort((a, b) => a.rate - b.rate || a.index - b.index)
    .map(p => p.name);
  const lowRateDownloadCandidates = lowRateProxyNames.length
    ? [...lowRateProxyNames, POLICY.manual, POLICY.auto]
    : [POLICY.manual, POLICY.auto];

  // 功能组地区选择：偏好地区靠前 + 其余全部地区兜底（去重）
  function prefThenAll(prefIso) {
    const pref = prefIso.map(regionLabel).filter(l => regionMap[l]);
    const rest = allRegionGroups.filter(l => !pref.includes(l));
    return [...pref, ...rest];
  }

  // 远程规则统一由自有 zyxtoworld/rules provider 管理，客户端只访问一个镜像入口。
  const remoteRuleProvider = (url, path, behavior = 'classical', format = 'yaml') => ({
    type: 'http',
    behavior,
    format,
    url,
    path,
    interval: 172800,
    proxy: POLICY.fallback
  });

  // MRS 只支持 domain/ipcidr；无法表达的 DOMAIN-KEYWORD、PROCESS-* 等规则保留为 classical YAML。
  const ruleProviderParts = {
    ai: ['domain', 'classical'],
    crypto: ['domain'],
    biliintl: ['domain'],
    direct: ['domain', 'ipcidr', 'classical'],
    // Keep synchronized with fixedMrsPartitions.ads.domain in build-rules.mjs.
    ads: ['domain', 'domain-2'],
    download: ['domain', 'classical'],
    google: ['domain', 'ipcidr', 'classical'],
    apple: ['domain', 'ipcidr', 'classical'],
    microsoft: ['domain', 'classical'],
    games: ['domain', 'classical'],
    youtube: ['domain', 'ipcidr', 'classical'],
    telegram: ['domain', 'ipcidr', 'classical'],
    twitter: ['domain'],
    spotify: ['domain', 'ipcidr', 'classical'],
    netflix: ['domain', 'classical'],
    tiktok: ['domain'],
    media: ['domain', 'classical'],
    social: ['domain', 'ipcidr'],
    dev: ['domain'],
    cloud: ['domain', 'ipcidr'],
    finance: ['domain'],
    shopping: ['domain'],
    'proxy-extra': ['domain']
  };
  const ruleProviderBaseUrl = 'https://testingcf.jsdelivr.net/gh/zyxtoworld/rules@main/rules/mihomo';
  const isDomainPart = kind => kind === 'domain' || kind.startsWith('domain-');
  const isIpcidrPart = kind => kind === 'ipcidr' || kind.startsWith('ipcidr-');
  const providerFileName = (name, kind) => {
    const suffix = kind === 'domain'
      ? ''
      : isDomainPart(kind)
        ? `-${kind.slice('domain-'.length)}`
        : `-${kind}`;
    const extension = kind === 'classical' ? 'yaml' : 'mrs';
    return `${name}${suffix}.${extension}`;
  };
  const providerName = (name, kind) => kind === 'domain'
    ? name
    : isDomainPart(kind)
      ? `${name}-${kind.slice('domain-'.length)}`
      : `${name}-${kind}`;
  const providerBehavior = kind => isDomainPart(kind) ? 'domain' : isIpcidrPart(kind) ? 'ipcidr' : 'classical';
  const providerFormat = kind => kind === 'classical' ? 'yaml' : 'mrs';
  const providerRuleSet = (name, policy) => ruleProviderParts[name]
    .map(kind => `RULE-SET,${providerName(name, kind)},${policy}`);

  // ===== 基础配置 =====
  const config = {
    'geodata-mode': true,
    'geodata-loader': 'memconservative',
    'geosite-matcher': 'succinct',
    'geox-url': {
      geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
      geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
      mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
      asn: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb'
    },
    'rule-providers': Object.fromEntries(
      Object.entries(ruleProviderParts).flatMap(([name, parts]) => parts.map(kind => {
        const fileName = providerFileName(name, kind);
        return [
          providerName(name, kind),
          remoteRuleProvider(
            `${ruleProviderBaseUrl}/${fileName}`,
            `./rule-providers/${fileName}`,
            providerBehavior(kind),
            providerFormat(kind)
          )
        ];
      }))
    )
  };
  // ===== 策略组 =====
  const healthCheckUrl = 'https://www.gstatic.com/generate_204';
  const healthCheckInterval = 300;
  const proxyGroups = [];

  function addGroup(group) {
    proxyGroups.push({ ...group, proxies: unique(group.proxies) });
  }
  function addSelectGroup(name, proxies) {
    addGroup({ name, type: 'select', proxies });
  }
  function addHealthCheckGroup(name, type, proxies, extra) {
    addGroup({ name, type, url: healthCheckUrl, interval: healthCheckInterval, ...(extra || {}), proxies });
  }

  addHealthCheckGroup(POLICY.manual, 'select', [POLICY.auto, POLICY.fallback, ...allProxyNames]);
  addHealthCheckGroup(POLICY.auto, 'url-test', autoCandidates, { tolerance: 50, lazy: false });
  addHealthCheckGroup(POLICY.fallback, 'fallback', failoverCandidates);
  addHealthCheckGroup(POLICY.lowRateDownload, 'fallback', lowRateDownloadCandidates, { lazy: true });

  // 功能组（偏好地区靠前 + 全部地区兜底）
  const featureGroups = [
    [POLICY.ai, [POLICY.manual, POLICY.auto, ...prefThenAll(['US', 'JP', 'SG', 'GB', 'DE', 'KR'])]],
    [POLICY.crypto, [POLICY.manual, POLICY.auto, ...allRegionGroups]],
    [POLICY.bilibili, [DIRECT, POLICY.manual, ...prefThenAll(['HK', 'TW'])]],
    [POLICY.games, [DIRECT, POLICY.manual, ...prefThenAll(['HK', 'JP', 'SG', 'US'])]],
    [POLICY.tiktok, [POLICY.manual, ...prefThenAll(['JP', 'US', 'SG', 'TW'])]],
    [POLICY.media, [POLICY.manual, ...prefThenAll(['HK', 'JP', 'SG', 'US', 'TW'])]],
    [POLICY.social, [POLICY.manual, ...prefThenAll(['US', 'JP', 'SG', 'HK', 'TW'])]],
    [POLICY.dev, [POLICY.manual, POLICY.auto, ...prefThenAll(['US', 'JP', 'SG', 'GB', 'DE', 'NL'])]],
    [POLICY.cloud, [DIRECT, POLICY.manual, ...prefThenAll(['US', 'JP', 'SG', 'HK'])]],
    [POLICY.finance, [POLICY.manual, POLICY.auto, ...prefThenAll(['US', 'JP', 'SG', 'GB', 'HK'])]],
    [POLICY.shopping, [POLICY.manual, POLICY.auto, ...prefThenAll(['US', 'JP', 'SG', 'GB', 'HK'])]],
    [POLICY.apple, [DIRECT, POLICY.manual, ...prefThenAll(['US', 'JP'])]],
    [POLICY.telegram, [POLICY.manual, ...prefThenAll(['SG', 'HK', 'US', 'JP'])]],
    [POLICY.youtube, [POLICY.manual, ...prefThenAll(['US', 'JP', 'SG', 'TW', 'HK'])]],
    [POLICY.google, [POLICY.manual, ...prefThenAll(['US', 'JP', 'SG', 'HK'])]],
    [POLICY.github, [POLICY.manual, ...prefThenAll(['JP', 'SG', 'US', 'HK', 'TW'])]],
    [POLICY.microsoft, [DIRECT, POLICY.manual, ...prefThenAll(['US', 'JP', 'SG', 'HK'])]],
    [POLICY.twitter, [POLICY.manual, ...prefThenAll(['US', 'SG', 'JP', 'HK'])]],
    [POLICY.spotify, [...prefThenAll(['HK', 'TW', 'SG', 'JP', 'US']), POLICY.manual, DIRECT]],
    [POLICY.netflix, [POLICY.manual, ...prefThenAll(['SG', 'JP', 'US', 'HK', 'TW'])]],
    [POLICY.speedtest, [DIRECT, POLICY.manual, POLICY.auto]],
    [POLICY.ads, [REJECT, DIRECT, POLICY.manual]],
    [POLICY.leak, [POLICY.manual, DIRECT, POLICY.auto]]
  ];
  for (const [name, groupProxies] of featureGroups) addSelectGroup(name, groupProxies);

  // 地区分组（按订阅实际出现自动生成）
  for (const label of regionOrder) {
    addSelectGroup(label, regionMap[label]);
  }
  if (unknownRegionProxies.length) {
    addSelectGroup(unknownRegionLabel, unknownRegionProxies);
  }

  // ===== 规则 =====
  function geosite(name, policy) {
    return `GEOSITE,${name},${policy}`;
  }
  function domainRules(domains, policy) {
    return domains.map(domain => `DOMAIN,${domain},${policy}`);
  }
  function domainSuffixRules(domains, policy) {
    return domains.map(domain => `DOMAIN-SUFFIX,${domain},${policy}`);
  }
  function domainKeywordRules(keywords, policy) {
    return keywords.map(keyword => `DOMAIN-KEYWORD,${keyword},${policy}`);
  }
  function processNameRules(names, policy) {
    return names.map(name => `PROCESS-NAME,${name},${policy}`);
  }
  function cidrRules(cidrs, policy) {
    return cidrs.map(cidr => `IP-CIDR,${cidr},${policy},no-resolve`);
  }
  function cidr6Rules(cidrs, policy) {
    return cidrs.map(cidr => `IP-CIDR6,${cidr},${policy},no-resolve`);
  }
  function ruleSet(policy, sections) {
    const builders = {
      domain: domainRules,
      suffix: domainSuffixRules,
      keyword: domainKeywordRules,
      process: processNameRules,
      cidr: cidrRules,
      cidr6: cidr6Rules
    };
    const result = [];
    for (const [type, values] of sections) {
      result.push(...builders[type](values, policy));
    }
    return result;
  }

  const privateIpv4Cidrs = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4'
  ];
  const privateIpv6Cidrs = ['::1/128', 'fc00::/7', 'fe80::/10'];
  const privateIpRules = [
    ...cidrRules(privateIpv4Cidrs, DIRECT),
    ...cidr6Rules(privateIpv6Cidrs, DIRECT)
  ];

  const downloadProcessNames = [
    'aria2c',
    'aria2c.exe',
    'BitComet',
    'BitComet.exe',
    'BitComet_x64.exe',
    'BitTorrent',
    'BitTorrent.exe',
    'Deluge',
    'deluge',
    'deluge.exe',
    'deluge-gtk',
    'deluge-gtk.exe',
    'deluged',
    'deluged.exe',
    'DownloadService',
    'DownloadService.exe',
    'dmaster',
    'dmaster.exe',
    'EagleGet',
    'EagleGet.exe',
    'fdm',
    'fdm.exe',
    'fdmd',
    'fdmd.exe',
    'FlashGet',
    'FlashGet.exe',
    'Folx',
    'Folx.exe',
    'FrostWire',
    'FrostWire.exe',
    'IDMan',
    'IDMan.exe',
    'Internet Download Manager',
    'Internet Download Manager.exe',
    'JDownloader',
    'JDownloader.exe',
    'JDownloader2',
    'JDownloader2.exe',
    'kget',
    'kget.exe',
    'MegaDownloader',
    'MegaDownloader.exe',
    'MEGAsync',
    'MEGAsync.exe',
    'Motrix',
    'Motrix.exe',
    'motrix-next',
    'motrix-next.exe',
    'motrix-next-engine',
    'motrix-next-engine.exe',
    'NeatDM',
    'NeatDM.exe',
    'NetTransport',
    'NetTransport.exe',
    'Ninja Download Manager',
    'Ninja Download Manager.exe',
    'Persepolis',
    'persepolis',
    'persepolis.exe',
    'PicoTorrent',
    'PicoTorrent.exe',
    'qbittorrent',
    'qbittorrent.exe',
    'qBittorrent',
    'qBittorrent.exe',
    'Tixati',
    'Tixati.exe',
    'Transmission',
    'Transmission.exe',
    'transmission-daemon',
    'transmission-daemon.exe',
    'transmission-gtk',
    'transmission-gtk.exe',
    'transmission-qt',
    'transmission-qt.exe',
    'uGet',
    'uget',
    'uGet.exe',
    'uget.exe',
    'uTorrent',
    'uTorrent.exe',
    'uTorrent Web',
    'uTorrent Web.exe',
    'Vuze',
    'Vuze.exe',
    'WebTorrent',
    'WebTorrent.exe',
    'WebTorrent Helper.exe',
    'WebTorrentHelper',
    'WebTorrentHelper.exe',
    'xdman',
    'xdman.exe',
    'XDM',
    'XDM.exe',
    'XLServicePlatform',
    'XLServicePlatform.exe',
    'XLLiveUD',
    'XLLiveUD.exe',
    'XunLei',
    'XunLei.exe',
    'Xunlei',
    'Xunlei.exe',
    'Thunder',
    'Thunder.exe',
    'ThunderMini',
    'ThunderMini.exe',
    'ThunderPlatform',
    'ThunderPlatform.exe',
    'ThunderVIP',
    'ThunderVIP.exe',
    'baidunetdisk',
    'baidunetdisk.exe',
    'BaiduNetdisk',
    'BaiduNetdisk.exe',
    'baidunetdiskhost',
    'baidunetdiskhost.exe',
    'BaiduNetdiskHost',
    'BaiduNetdiskHost.exe',
    'Weiyun',
    'Weiyun.exe',
    'AliYunDrive',
    'AliYunDrive.exe',
    'aliyundrive',
    'aliyundrive.exe',
    'aDrive',
    'aDrive.exe',
    'QuarkCloudDrive',
    'QuarkCloudDrive.exe',
    'QuarkNetdisk',
    'QuarkNetdisk.exe',
    '115',
    '115.exe',
    '115Desktop',
    '115Desktop.exe',
    '123pan',
    '123pan.exe'
  ];
  const downloadProcessMatchers = unique(downloadProcessNames).map(name => `(PROCESS-NAME,${name})`).join(',');
  const downloadProcessRule =
    `AND,((OR,(${downloadProcessMatchers})),` +
    `(OR,((GEOSITE,geolocation-!cn),(NOT,((GEOIP,CN)))))),${POLICY.lowRateDownload}`;

  // 固定文件/CDN 主机用 DOMAIN；只有确认需要覆盖子域的 CDN 根域才用 DOMAIN-SUFFIX。
  const fileDownloadDomains = [
    'github-releases.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'raw.githubusercontent.com',
    'codeload.github.com',
    'pkg-containers.githubusercontent.com',
    'production.cloudflare.docker.com',
    'files.pythonhosted.org',
    'static.crates.io',
    'cdn-lfs.huggingface.co',
    'cas-bridge.xethub.hf.co',
    'download.visualstudio.microsoft.com',
    'vscode.download.prss.microsoft.com',
    'dl.google.com',
    'edgedl.me.gvt1.com',
    'dl-ssl.google.com',
    'download-installer.cdn.mozilla.net',
    'assets1.xboxlive.com',
    'assets2.xboxlive.com',
    'blizzard.gcdn.cloudn.co.kr',
    'blzddist1-a.akamaihd.net',
    'blzddistkr1-a.akamaihd.net',
    'client.hikarifield.co.jp',
    'content.cdp.bethesda.net',
    'download.cdp.bethesda.net',
    'download.dm.origin.com',
    'download.epicgames.com',
    'download.hikarifield.co.jp',
    'download2.epicgames.com',
    'download3.epicgames.com',
    'download4.epicgames.com',
    'edge.steam-dns.top.comcast.net',
    'epicgames-download1.akamaized.net',
    'eu.cdn.blizzard.com',
    'fastly-download.epicgames.com',
    'gamedownloads-rockstargames-com.akamaized.net',
    'gog-cdn-lumen.secure2.footprint.net',
    'kr.cdn.blizzard.com',
    'level3.blizzard.com',
    'origin-a.akamaihd.net',
    'packagespc.xboxlive.com',
    'ssl-lvlt.cdn.ea.com',
    'steam.eca.qtlglb.com',
    'steam.naeu.qtlglb.com',
    'steam.ru.qtlglb.com',
    'steampipe-kr.akamaized.net',
    'steampipe-partner.akamaized.net',
    'steampipe.akamaized.net',
    'steamusercontent-a.akamaihd.net',
    'us.cdn.blizzard.com',
    'xvcf1.xboxlive.com',
    'xvcf2.xboxlive.com'
  ];
  const fileDownloadSuffixes = [
    'cdn.ubi.com',
    'dyn.riotcdn.net',
    'steamcontent.com'
  ];
  const lowRateDownloadRules = [
    downloadProcessRule,
    ...domainRules(fileDownloadDomains, POLICY.lowRateDownload),
    ...domainSuffixRules(fileDownloadSuffixes, POLICY.lowRateDownload)
  ];
  const cryptoRules = ruleSet(POLICY.crypto, [
    ['suffix', [
      'aex.com',
      'aicoin.com',
      'aimoon.com',
      'bibox.com',
      'bitcointalk.org',
      'bithumb.com',
      'coincheck.com',
      'coinall.ltd',
      'gate.com',
      'blastapi.io',
      'keplr.app',
      'korbit.co.kr',
      'okex.org',
      'okx-doh.com',
      'okx-httpdns.com',
      'omni-dex.io',
      'pancakeswap.finance',
      'phantom.app',
      'poloniex.com',
      'sushi.com',
    ]]
  ]);
  const youtubeRules = ruleSet(POLICY.youtube, [
    ['cidr', [
      '172.110.32.0/21',
      '216.73.80.0/20'
    ]],
    ['cidr6', ['2620:120:e000::/40']]
  ]);
  const telegramRules = ruleSet(POLICY.telegram, [
    ['domain', [
      'api.imem.app',
      'api.swiftgram.app'
    ]],
    ['suffix', [
      'mbrx.app',
      'stel.com',
      'telegramdownload.com'
    ]],
    ['keyword', ['nicegram']],
    ['cidr', [
      '5.28.192.0/18',
      '91.108.0.0/16',
      '109.239.140.0/24',
      '139.59.210.98/32',
      '149.154.160.0/20',
      '196.55.216.167/32'
    ]],
    ['cidr6', [
      '2001:67c:4e8::/48',
      '2001:b28:f23c::/47',
      '2001:b28:f23f::/48',
      '2a0a:f280::/32',
    ]],
    ['process', [
      'Telegram.exe',
      'nekox.messenger',
      'org.telegram.messenger',
      'telegram-desktop',
      'tw.nekomimi.nekogram',
      'xyz.nextalone.nagram'
    ]]
  ]);
  const netflixRules = ruleSet(POLICY.netflix, [
    ['domain', [
      'e13252.dscg.akamaiedge.net',
      'h-netflix.online-metrix.net',
      'netflix.com.edgesuite.net'
    ]],
    ['keyword', [
      'apiproxy-device-prod-nlb-',
      'dualstack.apiproxy-',
      'dualstack.ichnaea-web-',
      'netflixdnstest'
    ]],
    ['process', ['com.netflix.mediaclient']]
  ]);
  const spotifyRules = ruleSet(POLICY.spotify, [
    ['suffix', [
      'byspotify.com',
      'pscdn.co',
      'scdn.co',
      'spoti.fi',
      'spotify-everywhere.com',
      'spotify.app.link',
      'spotify.com',
      'spotify.design',
      'spotify.link',
      'spotifycdn.com',
      'spotifycdn.net',
      'spotifycharts.com',
      'spotifycodes.com',
      'spotifyforbrands.com',
      'spotifyforvendors.com',
      'spotifyjobs.com',
      'spotifynewsroom.jp',
      'spotilocal.com',
      'tospotify.com'
    ]],
    ['suffix', [
      'audio-ak-spotify-com.akamaized.net',
      'heads4-ak-spotify-com.akamaized.net',
      'spotify-com.akamaized.net',
    ]],
    ['domain', [
      'audio4-ak-spotify-com.akamaized.net',
      'cdn-spotify-experiments.conductrics.com',
      'heads-ak-spotify-com.akamaized.net',
      'spotify.map.fastly.net',
      'spotify.map.fastlylb.net',
      'spotify.com.edgesuite.net'
    ]],
    ['keyword', ['spotify']],
    ['process', ['com.spotify.music']],
    ['cidr', [
      '104.154.127.126/32',
      '35.186.224.47/32'
    ]]
  ]);

  const rules = [
    // 1. 私有地址先直连，避免被后续 GeoSite/IP 规则误判。
    geosite('private', DIRECT),
    ...privateIpRules,

    // 2. 高优先级服务：使用自有聚合文件，GeoSite 保留为兜底。
    ...providerRuleSet('ai', POLICY.ai),
    geosite('google-gemini', POLICY.ai),
    geosite('openai', POLICY.ai),
    geosite('anthropic', POLICY.ai),
    geosite('category-ai-chat-!cn', POLICY.ai),
    ...providerRuleSet('biliintl', POLICY.bilibili),
    geosite('biliintl', POLICY.bilibili),

    // 3. 加密货币与国内服务：国内例外优先于广告和宽分类。
    ...providerRuleSet('crypto', POLICY.crypto),
    ...cryptoRules,
    geosite('category-cryptocurrency', POLICY.crypto),
    geosite('google@cn', DIRECT),
    geosite('steam@cn', DIRECT),
    geosite('category-games@cn', DIRECT),
    geosite('category-entertainment@cn', DIRECT),
    geosite('apple-cn', DIRECT),
    geosite('apple@cn', DIRECT),
    geosite('icloud@cn', DIRECT),
    geosite('microsoft@cn', DIRECT),
    geosite('cn', DIRECT),
    ...providerRuleSet('direct', DIRECT),

    // 4. 广告：自有聚合集先行，MetaCubeX GeoSite 作兜底。
    ...providerRuleSet('ads', POLICY.ads),
    geosite('category-ads-all', POLICY.ads),

    // 5. 下载器和明确下载资源。
    ...providerRuleSet('download', POLICY.lowRateDownload),
    ...lowRateDownloadRules,

    // 6. 服务分类：专用服务优先，开发/社交/云/金融等分类补齐遗漏。
    ...providerRuleSet('youtube', POLICY.youtube),
    ...youtubeRules,
    geosite('youtube', POLICY.youtube),
    ...providerRuleSet('google', POLICY.google),
    geosite('google', POLICY.google),
    geosite('github', POLICY.github),
    ...providerRuleSet('dev', POLICY.dev),
    ...telegramRules,
    ...providerRuleSet('telegram', POLICY.telegram),
    geosite('telegram', POLICY.telegram),
    geosite('twitter', POLICY.twitter),
    ...providerRuleSet('twitter', POLICY.twitter),
    ...providerRuleSet('social', POLICY.social),
    geosite('facebook', POLICY.social),
    geosite('discord', POLICY.social),
    geosite('reddit', POLICY.social),
    geosite('whatsapp', POLICY.social),
    geosite('instagram', POLICY.social),
    geosite('linkedin', POLICY.social),
    geosite('zoom', POLICY.social),
    geosite('slack', POLICY.social),
    geosite('category-communication', POLICY.social),
    ...providerRuleSet('netflix', POLICY.netflix),
    ...netflixRules,
    geosite('netflix', POLICY.netflix),
    ...providerRuleSet('spotify', POLICY.spotify),
    ...spotifyRules,
    geosite('spotify', POLICY.spotify),
    ...providerRuleSet('apple', POLICY.apple),
    geosite('icloud', POLICY.apple),
    geosite('apple', POLICY.apple),
    ...providerRuleSet('cloud', POLICY.cloud),
    geosite('dropbox', POLICY.cloud),
    geosite('onedrive', POLICY.cloud),
    ...providerRuleSet('microsoft', POLICY.microsoft),
    geosite('microsoft', POLICY.microsoft),
    ...providerRuleSet('finance', POLICY.finance),
    geosite('paypal', POLICY.finance),
    geosite('category-finance', POLICY.finance),
    ...providerRuleSet('shopping', POLICY.shopping),
    geosite('amazon', POLICY.shopping),
    ...providerRuleSet('tiktok', POLICY.tiktok),
    geosite('tiktok', POLICY.tiktok),
    ...providerRuleSet('media', POLICY.media),
    geosite('speedtest', POLICY.speedtest),

    // 7. 自有代理补充集：排除 MetaCubeX 中国域名和中国 IP。
    `AND,((RULE-SET,proxy-extra),(NOT,((GEOSITE,cn))),(NOT,((GEOIP,CN)))),${POLICY.manual}`,

    // 8. 游戏/媒体宽分类必须在所有服务特例之后。
    ...providerRuleSet('games', POLICY.games),
    geosite('category-games-!cn', POLICY.games),
    geosite('category-entertainment', POLICY.media),

    // 9. IP 与最终兜底。
    `GEOIP,CN,${DIRECT}`,
    `GEOIP,telegram,${POLICY.telegram},no-resolve`,
    `GEOIP,google,${POLICY.google},no-resolve`,
    `GEOIP,netflix,${POLICY.netflix},no-resolve`,
    `GEOIP,twitter,${POLICY.twitter},no-resolve`,
    `GEOIP,facebook,${POLICY.social},no-resolve`,
    `IP-CIDR6,::/0,${POLICY.manual},no-resolve`,
    geosite('geolocation-!cn', POLICY.manual),
    `MATCH,${POLICY.leak}`
  ];

  config.proxies = proxies;
  config['proxy-groups'] = proxyGroups;
  config.rules = rules;
  return config;
}
