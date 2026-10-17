export type LiveTvSettings = {
  version: 1;
  enabled: boolean;
  defaultChannelEnabled: boolean;
  defaultChannelName: string;
  defaultChannelDescription: string;
  defaultChannelUrls: string[];
  customM3uPathOrUrl: string;
  userAgent: string;
  localRegion: string;
};

export const defaultSenadoUrls = [
  'http://45.162.64.114/TV_SENADO/index.m3u8',
  'http://168.197.104.22/TV_SENADO/index.m3u8',
  'http://170.83.16.50/TV_SENADO/index.m3u8',
  'http://170.83.49.66:8083/TVSENADOHD/index.m3u8',
  'http://186.219.52.187/tv_senado/index.m3u8'
];

export const maxLiveTvSettingsBytes = 30 * 1024;

export function defaultLiveTvSettings(): LiveTvSettings {
  return {
    version: 1,
    enabled: true,
    defaultChannelEnabled: true,
    defaultChannelName: 'TV Senado',
    defaultChannelDescription: 'Canal de Boas-Vindas · Ao Vivo 24h',
    defaultChannelUrls: [...defaultSenadoUrls],
    customM3uPathOrUrl: '',
    userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
    localRegion: 'none'
  };
}

export function liveTvSettingsKey(server: string, user: string): string {
  return `jellyfin-cinema.livetv-settings.v1:${encodeURIComponent(server)}:${encodeURIComponent(user)}`;
}

export function parseLiveTvSettings(value: unknown): LiveTvSettings {
  const invalid = () => new Error('Jellyfin retornou configurações de TV Ao Vivo inválidas.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;

  const text = (val: unknown, length: number): val is string =>
    typeof val === 'string' && val.length <= length && !/[\u0000-\u001f\u007f-\u009f]/.test(val);

  if (data.version !== 1) throw invalid();
  if (typeof data.enabled !== 'boolean') throw invalid();
  if (typeof data.defaultChannelEnabled !== 'boolean') throw invalid();
  if (!text(data.defaultChannelName, 120)) throw invalid();
  if (!text(data.defaultChannelDescription, 200)) throw invalid();
  if (typeof data.customM3uPathOrUrl !== 'string' || data.customM3uPathOrUrl.length > 500) throw invalid();

  const userAgent = typeof data.userAgent === 'string' && text(data.userAgent, 300)
    ? data.userAgent.trim()
    : 'VLC/3.0.20 LibVLC/3.0.20';

  const localRegion = typeof data.localRegion === 'string' && text(data.localRegion, 50)
    ? data.localRegion.trim()
    : 'none';

  if (!Array.isArray(data.defaultChannelUrls)) throw invalid();
  const urls: string[] = [];
  for (const item of data.defaultChannelUrls) {
    if (typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 500) {
      urls.push(item.trim());
    }
  }

  return {
    version: 1,
    enabled: data.enabled,
    defaultChannelEnabled: data.defaultChannelEnabled,
    defaultChannelName: data.defaultChannelName,
    defaultChannelDescription: data.defaultChannelDescription,
    defaultChannelUrls: urls.length > 0 ? urls : [...defaultSenadoUrls],
    customM3uPathOrUrl: data.customM3uPathOrUrl.trim(),
    userAgent,
    localRegion
  };
}

export const BRAZILIAN_PREMIERE_REGEX = /^(?:(?:BR|BRASIL)[\s:\-\]]*)?(?:CANAL\s+)?PREMIERE(?:\s*(?:\d+|CLUBES|HD|FHD|UHD|4K|MOSAICO|INTERATIVO|24H|FUTEBOL))?(?:\s*(?:HD|FHD|UHD|4K|SD))?$/i;
export const INTL_INDICATOR_REGEX = /^(?:\|[A-Z]{2,3}\||\([A-Z]{2,3}\)|\[[A-Z]{2,3}\]|[A-Z]{2,3}[\-:]|\b(?:UK|FR|DE|US|ES|IT|PT|COL|ARG|CHILE|PARIS|SKY|CINEMA)\b)/i;
export const BR_PREFIX_REGEX = /^(?:BR|BRASIL)[\s:\-\]]/i;

export function isBrazilianPremiere(name: string, groupTitle: string = ''): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (groupTitle.startsWith('▶')) return false;
  if (INTL_INDICATOR_REGEX.test(trimmed) && !BR_PREFIX_REGEX.test(trimmed)) return false;
  return BRAZILIAN_PREMIERE_REGEX.test(trimmed);
}

export function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export const STATE_REGEX_MAP: Record<string, RegExp> = {
  BA: /\b(BA|BAHIA|SALVADOR|ITABUNA|FEIRA)\b/i,
  SP: /\b(SP|S[AÃ]O\s+PAULO|PAULISTA|CAMPINAS|SANTOS|TAUBAT[EÉ]|GUARUJ[AÁ]|VALE\s+DO\s+PARA[IÍ]BA)\b/i,
  RJ: /\b(RJ|RIO\s+DE\s+JANEIRO|CARIOCA|INTER\s+TV)\b/i,
  MG: /\b(MG|MINAS|MINAS\s+GERAIS|BH|BELO\s+HORIZONTE|EPTV\s+SUL)\b/i,
  RS: /\b(RS|RIO\s+GRANDE\s+DO\s+SUL|GA[UÚ]CH[AO]|RBS|POA|PASSO\s+FUNDO)\b/i,
  PR: /\b(PR|PARAN[AÁ]|CURITIBA|RPC|TAROB[AÁ]|CASCAVEL)\b/i,
  SC: /\b(SC|SANTA\s+CATARINA|FLORIAN[OÓ]POLIS|NSC)\b/i,
  GO: /\b(GO|GOI[AÁ]S|GOI[AÂ]NIA|ANHANGUERA)\b/i,
  DF: /\b(DF|BRAS[IÍ]LIA|DISTRITO\s+FEDERAL)\b/i,
  PE: /\b(PE|PERNAMBUCO|RECIFE|TRIBUNA\s+RECIFE)\b/i,
  CE: /\b(CE|CEAR[AÁ]|FORTALEZA|VERDES\s+MARES)\b/i,
  ES: /\b(ES|ESP[IÍ]RITO\s+SANTO|VIT[OÓ]RIA)\b/i,
  PA: /\b(PA|PAR[AÁ]|BEL[EÉ]M|RBA)\b/i,
  AM: /\b(AM|AMAZONAS|MANAUS)\b/i,
  RN: /\b(RN|RIO\s+GRANDE\s+DO\s+NORTE|NATAL)\b/i,
  PB: /\b(PB|PARA[IÍ]BA|PARA[IÍ]BAN[AO]|JO[AÃ]O\s+PESSOA|ARAPUAN|TAMBA[UÚ]|BORBOREMA)\b/i,
  AL: /\b(AL|ALAGOAS|MACEI[OÓ]|GAZETA\s+AL)\b/i,
  SE: /\b(SE|SERGIPE|ARACAJU)\b/i,
  MA: /\b(MA|MARANH[AÃ]O|S[AÃ]O\s+LU[IÍ]S|MIRA)\b/i,
  PI: /\b(PI|PIAU[IÍ]|TERESINA)\b/i,
  MT: /\b(MT|MATO\s+GROSSO|CUIAB[AÁ])\b/i,
  MS: /\b(MS|MATO\s+GROSSO\s+DO\s+SUL|CAMPO\s+GRANDE)\b/i,
  TO: /\b(TO|TOCANTINS|PALMAS)\b/i,
  RO: /\b(RO|ROND[OÔ]NIA|PORTO\s+VELHO)\b/i,
  AC: /\b(AC|ACRE|RIO\s+BRANCO)\b/i,
  AP: /\b(AP|AMAP[AÁ]|MACAP[AÁ])\b/i,
  RR: /\b(RR|RORAIMA|BOA\s+VISTA)\b/i
};

export const STATE_NAME_MAP: Record<string, string> = {
  BA: 'Bahia', SP: 'São Paulo', RJ: 'Rio de Janeiro', MG: 'Minas Gerais',
  RS: 'Rio Grande do Sul', PR: 'Paraná', SC: 'Santa Catarina', GO: 'Goiás',
  DF: 'Distrito Federal', PE: 'Pernambuco', CE: 'Ceará', ES: 'Espírito Santo',
  PA: 'Pará', AM: 'Amazonas', RN: 'Rio Grande do Norte', PB: 'Paraíba',
  AL: 'Alagoas', SE: 'Sergipe', MA: 'Maranhão', PI: 'Piauí', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', TO: 'Tocantins', RO: 'Rondônia', AC: 'Acre',
  AP: 'Amapá', RR: 'Roraima'
};

export interface StateChannelLike {
  name: string;
  groupTitle?: string;
}

export function isChannelInState(c: StateChannelLike, stateCode: string): boolean {
  const code = (stateCode || '').trim().toUpperCase();
  const regex = STATE_REGEX_MAP[code];
  if (!regex) return false;
  const name = removeDiacritics(c.name || '');
  const group = removeDiacritics(c.groupTitle || '');

  // Proteção estrita: canais da Paraíba (PB/Paraíba) ou Paranaíba (MG) nunca devem cair na Bahia (BA)
  if (code === 'BA') {
    if (/\b(PB|PARAIBA|PARAIBAN[AO]|PARANA[IÍ]?BA)\b/i.test(name) || /\b(PB|PARAIBA|PARAIBAN[AO]|PARANA[IÍ]?BA)\b/i.test(group)) {
      return false;
    }
  }

  // Proteção estrita: "Vale do Paraíba" pertence a SP e não ao estado da Paraíba (PB)
  if (code === 'PB') {
    if (/\bVALE\s+DO\s+PARAIBA\b/i.test(name) || /\bVALE\s+DO\s+PARAIBA\b/i.test(group)) {
      return false;
    }
    if (/\b(BA|BAHIA)\b/i.test(name) && !/\b(PB|PARAIBA)\b/i.test(name)) {
      return false;
    }
  }

  // Proteção estrita: Pará não deve casar com Paraíba, Paraná ou Paranaíba
  if (code === 'PA') {
    if (/\b(PARAIBA|PARANA|PARANAIBA|PARAGUAI|PARAGUAY|PARAMOUNT)\b/i.test(name)) {
      return false;
    }
  }

  return regex.test(name) || regex.test(group);
}

