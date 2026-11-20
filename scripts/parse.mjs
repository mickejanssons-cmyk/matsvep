// Tolkar en svensk receptrad ("2 dl crème fraiche", "1 gul lök", "4 port ris")
// och översätter den till en vara i katalogen med mängd i varans enhet.
import { CATALOG, SKIP } from './catalog.mjs';

const W = '[a-zåäöéü]';
const fixB = src => src.replace(/\\b(?=[a-zåäöéü(\\\\])/g, `(?<!${W})`).replace(/\\b/g, `(?!${W})`);
const KW = CATALOG.map(p => ({ p, re: new RegExp(fixB(p.kw), 'g') }));
const SKIPRE = new RegExp(fixB(SKIP.source));
const VOL = { ml: 1, cl: 10, dl: 100, l: 1000, liter: 1000, msk: 15, tsk: 5, krm: 1 };
const WT = { g: 1, gram: 1, kg: 1000, hg: 100 };
const PCS = /^(st|stk|styck|klyfta|klyftor|skiva|skivor|kruka|krukor|knippe|knippen|blad|stjälk|stjälkar|bit|bitar|huvud|huvuden|nypa)$/;
const PKG = /^(förp|förpackning|förpackningar|paket|pkt|burk|burkar|påse|påsar|frp|tub|flaska)$/;
const PORT = /^(port|portion|portioner)$/;

function num(s) {
  s = s.replace(/½/g, '.5').replace(/¼/g, '.25').replace(/¾/g, '.75').replace(/⅓/g, '.333').replace(/⅔/g, '.667');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)/); if (m) return [+m[1] + m[2] / m[3], m[0].length];
  m = s.match(/^(\d+)\/(\d+)/); if (m) return [m[1] / m[2], m[0].length];
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:-|–)\s*(\d+(?:[.,]\d+)?)/); if (m) return [(parseFloat(m[1].replace(',', '.')) + parseFloat(m[2].replace(',', '.'))) / 2, m[0].length];
  m = s.match(/^\.?\d+(?:[.,]\d+)?/); if (m) return [parseFloat(m[0].replace(',', '.').replace(/^\./, '0.')), m[0].length];
  return [null, 0];
}

export function matchProduct(text) {
  const t = text.toLowerCase();
  let best = null;
  for (const { p, re } of KW) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const len = m[0].length;
      if (!best || len > best.len) best = { p, len };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return best ? best.p : null;
}

export function parseLine(raw, servings) {
  let s = raw.trim().replace(/\s+/g, ' ').replace(/(^|\s|-)ca\.?\s+/gi, '$1');
  const lower = s.toLowerCase();
  // förpackningsvikt "(à 390 g)" / "à 120 g"
  let pkg = null;
  const pm = lower.match(/à\s*(?:ca\s*)?(\d+(?:[.,]\d+)?)\s*(g|kg|ml|cl|dl|l)\b/);
  if (pm) { const v = parseFloat(pm[1].replace(',', '.')); pkg = { v: v * (WT[pm[2]] || VOL[pm[2]] || 1), vol: !!VOL[pm[2]] }; }
  const [q, used] = num(lower);
  let rest = lower.slice(used).trim();
  let unit = null;
  const um = rest.match(/^([a-zåäö]+)[.,]?\s+/);
  if (q != null && um && (VOL[um[1]] || WT[um[1]] || PCS.test(um[1]) || PKG.test(um[1]) || PORT.test(um[1]))) { unit = um[1]; rest = rest.slice(um[0].length); }
  const name = rest.replace(/\([^)]*\)/g, ' ').replace(/,.*$/, '').trim();
  if (q === 0) return { raw, skip: 'mängd 0' };
  if (SKIPRE.test(name)) return { raw, skip: 'krydda/vatten' };
  const ca = lower.match(/\(ca\.?\s*(\d+)\s*(g|kg)\)/);
  const p = matchProduct(name) || matchProduct(lower.replace(/\([^)]*\)/g, ' '));
  if (!p) return { raw, skip: 'okänd vara' };
  if (q == null) { if (p.port && servings) return { raw, id: p.id, amt: p.port * servings, est: 1 }; return { raw, id: p.id, amt: null, note: 'ingen mängd' }; }
  let amt = null; // i varans enhet
  const d = p.d || 1, pc = p.pc || 100;
  if (p.id === 'buljong' && VOL[unit]) amt = q * VOL[unit] / 500;
  else if (!unit && ca && p.unit === 'g') amt = +ca[1] * WT[ca[2]];
  else if (WT[unit]) { const g = q * WT[unit]; amt = p.unit === 'g' ? g : p.unit === 'ml' ? g / d : g / pc; }
  else if (VOL[unit]) { const ml = q * VOL[unit]; amt = p.unit === 'ml' ? ml : p.unit === 'g' ? ml * d : (ml * d) / pc; }
  else if (PORT.test(unit || '')) { const g = q * (p.port || 75); amt = p.unit === 'g' ? g : g / pc; }
  else if (PKG.test(unit || '')) {
    if (pkg) { amt = q * (p.unit === 'st' ? pkg.v / pc : p.unit === 'ml' && !pkg.vol ? pkg.v / d : p.unit === 'g' && pkg.vol ? pkg.v * d : pkg.v); }
    else amt = p.unit === 'st' ? q : q * (p.defPkg || p.max || 400) * 0.5; // förpackning utan vikt: anta en halv standardförpackning per "förp" i snitt
    if (!pkg && (p.id === 'bacon')) amt = q * 140;
    if (!pkg && (p.id === 'kross' || p.id === 'bonor' || p.id === 'kikarter' || p.id === 'majs' || p.id === 'vitabonor')) amt = q * (p.id === 'kross' ? 400 : 250);
    if (!pkg && p.id === 'kokos') amt = q * 400;
    if (!pkg && p.id === 'tacokrydda') amt = q;
  }
  else if (unit && PCS.test(unit)) {
    if (/klyft/.test(unit)) amt = p.unit === 'g' ? q * 5 : q * 5 / pc;
    else if (/kruka|knippe/.test(unit)) amt = p.unit === 'st' ? q : q * (p.pc || 30);
    else if (/skiv/.test(unit)) amt = p.unit === 'g' ? q * (p.id === 'brod' ? 40 : 20) : q;
    else amt = p.unit === 'st' ? q : q * pc;
  }
  else { // inget mått: antal styck
    amt = p.unit === 'st' ? q : p.unit === 'g' ? q * pc : q * pc / d;
  }
  if (p.id === 'agg' && /äggul|äggvit/.test(lower)) amt = q; // en äggula = ett ägg
  if (p.id === 'orter') amt = Math.min(1, amt || 1);
  if (!(amt > 0)) return { raw, id: p.id, amt: null, note: 'kunde inte räkna' };
  if (amt > (p.max || 1000) * 6) return { raw, id: p.id, amt: null, note: 'orimlig mängd' };
  return { raw, id: p.id, amt: Math.round(amt * 100) / 100 };
}

export function servingsOf(y) {
  const s = Array.isArray(y) ? y[0] : y;
  const m = String(s || '').match(/\d+/);
  const n = m ? +m[0] : 4;
  return n > 0 && n <= 12 ? n : 4;
}
