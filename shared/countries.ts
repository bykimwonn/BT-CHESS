/** ISO 3166-1 alpha-2 codes used for voluntary country display and policy keys. */
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

export const UNDISCLOSED_COUNTRY = 'ZZ';
export const GLOBAL_POLICY = '*';

export function normalizeCountryCode(value: unknown): string | null {
  const code = String(value ?? '').trim().toUpperCase();
  if (code === UNDISCLOSED_COUNTRY) return UNDISCLOSED_COUNTRY;
  return COUNTRY_CODES.includes(code) ? code : null;
}

export function countryName(code: string | null | undefined): string {
  if (!code || code === UNDISCLOSED_COUNTRY) return 'Country not shared';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; }
  catch { return code; }
}

export function countryFlag(code: string | null | undefined): string {
  const normalised = normalizeCountryCode(code);
  if (!normalised || normalised === UNDISCLOSED_COUNTRY) return '🌐';
  return String.fromCodePoint(...[...normalised].map((char) => 127397 + char.charCodeAt(0)));
}

export function countryOptions(): Array<{ code: string; label: string; flag: string }> {
  return [
    { code: UNDISCLOSED_COUNTRY, label: 'Prefer not to say', flag: '🌐' },
    ...COUNTRY_CODES.map((code) => ({ code, label: countryName(code), flag: countryFlag(code) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone }); return true; }
  catch { return false; }
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function formatLocalDateTime(value: string | number | Date, timeZone?: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short',
      timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : undefined,
    }).format(date);
  } catch { return date.toISOString(); }
}

export function localTimeZoneLabel(timeZone?: string): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : browserTimeZone();
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? zone;
  } catch { return zone; }
}
