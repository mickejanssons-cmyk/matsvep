// Hämtar recept och priser och skriver data/data.json.
// Körs varje natt av GitHub Actions (.github/workflows/update.yml), eller lokalt: node scripts/update.mjs
import fs from 'node:fs/promises';
import { CATALOG, CATS } from './catalog.mjs';
import { parseLine, servingsOf, matchProduct } from './parse.mjs';
import { SEED } from './seed.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIMIT = { ica: 140, lidl: 70, linas: 120 };

async function get(url, { json = false, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9', accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) { if (i === tries - 1) { log('FEL', url, e.message); return null; } await sleep(1500 * (i + 1)); }
  }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); await sleep(150); } }));
  return out;
}
const uniq = a => [...new Set(a)];

function ldRecipe(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const x of [].concat(j['@graph'] || j)) if ([].concat(x['@type']).includes('Recipe')) return x;
    } catch { }
  }
  return null;
}
const imgOf = im => { if (!im) return null; if (typeof im === 'string') return im; if (Array.isArray(im)) return imgOf(im[im.length > 1 ? 1 : 0]); return im.url || im.contentUrl || null; };
const ogImage = html => (html && (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i) || [])[1]) || null;
const minutes = t => { const m = String(t || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return m ? (+(m[1] || 0) * 60 + +(m[2] || 0)) || null : null; };
const clean = s => String(s || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function build(src, url, name, img, yieldv, mins, raw, types) {
  const p = servingsOf(yieldv);
  const lines = raw.map(clean).filter(Boolean);
  const parsed = lines.map(l => parseLine(l, p));
  const relevant = parsed.filter(x => !x.skip || x.skip === 'okänd vara');
  const priced = parsed.filter(x => x.id && x.amt);
  const i = {}; const est = {};
  for (const x of priced) { i[x.id] = (i[x.id] || 0) + x.amt; if (x.est) est[x.id] = 1; }
  return {
    id: src.toLowerCase() + '-' + ((url.match(/(\d{4,})/) || [])[1] || clean(name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').slice(0, 40)),
    src, u: url, n: clean(name), img, p, min: mins || null, t: types,
    raw: lines, i: Object.entries(i).map(([k, v]) => est[k] ? [k, Math.round(v), 1] : [k, Math.round(v * 100) / 100]),
    cover: relevant.length ? Math.round(100 * priced.length / relevant.length) : 0,
  };
}

// ---------- Recept ----------
async function ica() {
  const cats = [['frukost', 'f'], ['billig/frukost', 'f'], ['grot', 'f'], ['billig/husmanskost', 'lm'], ['billig/gryta', 'lm'], ['billig/soppa', 'lm'], ['billig/pasta', 'lm'], ['billig/kottfarssas', 'lm'], ['billig/stroganoff', 'lm'], ['billig/omelett', 'lm'], ['billig/pyttipanna', 'lm'], ['billig/tacos', 'lm'], ['billig/wraps', 'l'], ['billig/risotto', 'lm'], ['billig/kottbullar', 'lm'], ['billig/chili-con-carne', 'lm'], ['billig/gratang', 'lm'], ['billig/paj', 'lm'], ['billig/pannkakor', 'lm'], ['billig/sallad', 'l'], ['billig', 'lm'], ['vardagsmat', 'lm'], ['snabb-mat', 'lm']];
  const found = new Map();
  for (const [c, t] of cats) {
    const h = await get('https://www.ica.se/recept/' + c + '/');
    if (!h) continue;
    for (const m of h.matchAll(/\/recept\/([a-z0-9-]+-\d{5,})\//g)) if (!found.has(m[1])) found.set(m[1], t);
  }
  const ids = [...found.keys()].slice(0, LIMIT.ica);
  log('ICA recept', ids.length);
  const out = await pool(ids, 4, async id => {
    const url = 'https://www.ica.se/recept/' + id + '/';
    const h = await get(url); if (!h) return null;
    const r = ldRecipe(h); if (!r || !r.recipeIngredient) return null;
    return build('ICA', url, r.name, imgOf(r.image), r.recipeYield, minutes(r.totalTime), r.recipeIngredient, found.get(id));
  });
  return out.filter(Boolean);
}

async function lidl() {
  const pages = [['urval/kategori/snabbt-och-enkelt', 'lm'], ['urval/kategori/middag', 'lm'], ['urval/kategori/vardagsmat', 'lm'], ['urval/kategori/frukost', 'f'], ['urval/kategori/vegetariskt', 'lm'], ['urval/kategori/husmanskost', 'lm']];
  const found = new Map();
  for (const [c, t] of pages) {
    const h = await get('https://recept.lidl.se/' + c); if (!h) continue;
    for (const m of h.matchAll(/href="(\/recept\/[a-z0-9-]+)"/g)) if (!found.has(m[1])) found.set(m[1], t);
  }
  const ids = [...found.keys()].slice(0, LIMIT.lidl);
  log('Lidl recept', ids.length);
  const out = await pool(ids, 3, async path => {
    const url = 'https://recept.lidl.se' + path;
    const h = await get(url); if (!h) return null;
    const r = ldRecipe(h); if (!r || !r.recipeIngredient) return null;
    return build('Lidl', url, r.name, imgOf(r.image) || ogImage(h), r.recipeYield, minutes(r.totalTime), r.recipeIngredient, found.get(path));
  });
  return out.filter(Boolean);
}

async function linas() {
  const cats = ['svenska', 'gryta', 'soppa', 'kott', 'fagel', 'fisk', 'vegetarian', 'asiatiska'];
  const found = new Set();
  for (const c of cats) for (let pg = 1; pg <= 2; pg++) {
    const h = await get(`https://www.linasmatkasse.se/receptbank/${c}${pg > 1 ? '?page=' + pg : ''}`); if (!h) break;
    for (const m of h.matchAll(/href="(\/recept\/\d+\/[a-z0-9-]+)"/g)) found.add(m[1]);
  }
  const ids = [...found].slice(0, LIMIT.linas);
  log('Linas recept', ids.length);
  const out = await pool(ids, 3, async path => {
    const url = 'https://www.linasmatkasse.se' + path;
    const h = await get(url); if (!h) return null;
    const r = ldRecipe(h); if (!r || !r.recipeIngredient) return null;
    const ing = r.recipeIngredient.filter(x => !/^0\s/.test(x));
    return build('Linas', url, r.name, imgOf(r.image), r.recipeYield, minutes(r.totalTime), ing, 'lm');
  });
  return out.filter(Boolean);
}

async function seeded() {
  return pool(SEED, 2, async s => {
    const h = await get(s.u);
    return build(s.src, s.u, s.n, ogImage(h), s.p, s.min, s.raw, s.t);
  });
}

// ---------- Priser ----------
function packOf(item, unit) {
  // returnerar förpackningsstorlek i varans enhet
  const v = String(item.displayVolume || '').toLowerCase().replace(',', '.').replace(/\s/g, '');
  if (/kr\/kg/.test(item.priceUnit) && item.averageWeight) return unit === 'st' ? 1 : item.averageWeight * 1000;
  let m = v.match(/^(\d+)x(\d+(?:\.\d+)?)(g|kg|ml|cl|dl|l)$/);
  const conv = (n, u) => n * ({ g: 1, kg: 1000, ml: 1, cl: 10, dl: 100, l: 1000 }[u] || 1);
  if (unit === 'st') { m = v.match(/(\d+)(?:p|-pack|st)/); return m ? +m[1] : 1; }
  if (m) return +m[1] * conv(+m[2], m[3]);
  m = v.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(g|kg)$/); if (m) return conv(+m[2], m[3]); // avrunnen vikt
  m = v.match(/^(?:ca:?)?(\d+(?:\.\d+)?)(g|kg|ml|cl|dl|l)$/); if (m) return conv(+m[1], m[2]);
  return null;
}

async function willys() {
  const out = {};
  await pool(CATALOG, 3, async p => {
    const j = await get('https://www.willys.se/search?q=' + encodeURIComponent(p.q) + '&size=30', { json: true });
    if (!j || !j.results) return;
    const re = new RegExp(p.re);
    const cands = j.results.filter(x => re.test(x.name) && x.priceValue > 0 && !x.outOfStock).map(x => {
      const pk = packOf(x, p.unit);
      const price = /kr\/kg/.test(x.priceUnit) && x.averageWeight ? x.priceValue * x.averageWeight : x.priceValue;
      return pk ? { name: x.name + (x.displayVolume ? ' ' + x.displayVolume : ''), pk, price: Math.round(price * 100) / 100, per: price / pk, loose: /kr\/kg/.test(x.priceUnit), promo: (x.potentialPromotions || []).map(q => q.conditionLabel || q.rewardLabel || '').filter(Boolean).join(', ') } : null;
    }).filter(Boolean);
    if (!cands.length) return;
    const fit = cands.filter(c => c.pk <= p.max * 1.05);
    const pick = (fit.length ? fit : cands.sort((a, b) => a.pk - b.pk).slice(0, 1)).sort((a, b) => a.per - b.per)[0];
    out[p.id] = pick;
  });
  log('Willys priser', Object.keys(out).length, 'av', CATALOG.length);
  return out;
}

function jsObjectToJson(src) {
  return src.replace(/new Map\(\[[^\]]*\]\)/g, '{}').replace(/new Set\(\[[^\]]*\]\)/g, '[]').replace(/:\s*undefined/g, ':null').replace(/new Date\(([^)]*)\)/g, '$1');
}

async function icaOffers() {
  const url = 'https://www.ica.se/erbjudanden/ica-supermarket-varnhem-1004543/';
  const h = await get(url); if (!h) return { ok: false };
  const m = h.match(/window\.__INITIAL_DATA__\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return { ok: false };
  let d; try { d = JSON.parse(jsObjectToJson(m[1].trim().replace(/;\s*$/, ''))); } catch (e) { log('ICA erbjudanden: kunde inte tolka', e.message); return { ok: false }; }
  const list = d?.offers?.weeklyOffers || [];
  const out = {};
  for (const o of list) {
    const name = [o.details?.name, o.details?.brand].filter(Boolean).join(' ');
    const p = matchProduct(o.details?.name || ''); if (!p) continue;
    const pm = o.parsedMechanics || {};
    const reg = parseFloat(String(o.stores?.[0]?.regularPrice || '').replace(',', '.'));
    const val = parseFloat(String(pm.value2 || '').replace(',', '.'));
    const qty = +pm.quantity || 1;
    if (!(reg > 0) || !(val > 0) || pm.benefitType !== 'FIXED') continue;
    const ratio = val / qty / reg;
    if (ratio >= 0.97 || ratio < 0.2) continue;
    const img = o.picture ? `${o.picture.baseUrl}/q_auto,f_auto/c_lpad,h_200,w_200/${o.picture.fileName}.jpg` : null;
    if (!out[p.id] || ratio < out[p.id].ratio) out[p.id] = { ratio: Math.round(ratio * 1000) / 1000, text: `${o.details?.name} ${o.details?.mechanicInfo || ''} (ord. ${o.stores?.[0]?.regularPrice} kr)`.trim(), until: (o.validTo || '').slice(0, 10), img };
  }
  log('ICA Värnhem erbjudanden', list.length, 'matchade', Object.keys(out).length);
  return { ok: true, total: list.length, items: out };
}

// ---------- Kör ----------
const t0 = Date.now();
const [prices, offersIca, rIca, rLidl, rLinas, rSeed] = await Promise.all([willys(), icaOffers(), ica(), lidl(), linas(), seeded()]);
let recipes = [...rIca, ...rLidl, ...rLinas, ...rSeed].filter(r => r && r.i.length >= 2 && r.cover >= 60 && r.n);
const seen = new Set(); recipes = recipes.filter(r => !seen.has(r.id) && seen.add(r.id));
const products = CATALOG.filter(p => prices[p.id]).map(p => ({ id: p.id, n: p.n, c: p.c, unit: p.unit, base: p.base ? 1 : 0, pk: prices[p.id].pk, price: prices[p.id].price, wn: prices[p.id].name, loose: prices[p.id].loose ? 1 : 0, promo: prices[p.id].promo || '' }));
const have = new Set(products.map(p => p.id));
recipes = recipes.filter(r => r.i.every(([id]) => have.has(id)) || (r.i = r.i.filter(([id]) => have.has(id))).length >= 2);

let old = null; try { old = JSON.parse(await fs.readFile('data/data.json', 'utf8')); } catch { }
if (products.length < 40 || recipes.length < 30) {
  log('För lite data hämtades (produkter', products.length, 'recept', recipes.length + '). Behåller förra filen.');
  if (old) process.exit(0); else process.exit(1);
}
const data = {
  updated: new Date().toISOString(),
  stores: {
    willys: { n: 'Willys Katrinelund', addr: 'Celsiusgatan 38', how: 'Willys hyllpriser från willys.se (samma i hela landet)' },
    lidl: { n: 'Lidl Knivgatan', addr: 'Knivgatan 1B', how: 'Uppskattat: Willys-pris × 0,97 (Lidl visar inga priser på nätet)', f: 0.97 },
    ica: { n: 'ICA Supermarket Värnhem', addr: 'Värnhem', how: 'Uppskattat: Willys-pris × 1,07 enligt PRO:s prisundersökning, plus butikens egna veckoerbjudanden', f: 1.07 },
    coop: { n: 'Coop Värnhem', addr: 'Föreningsgatan 72', how: 'Uppskattat: Willys-pris × 1,08', f: 1.08 },
  },
  cats: CATS,
  products,
  offers: { ica: offersIca.ok ? offersIca.items : {} },
  recipes,
  stats: { ica: rIca.length, lidl: rLidl.length, linas: rLinas.length, seed: rSeed.length, kept: recipes.length, secs: Math.round((Date.now() - t0) / 1000) },
};
await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/data.json', JSON.stringify(data));
log('Klart:', products.length, 'varor,', recipes.length, 'recept', data.stats);
