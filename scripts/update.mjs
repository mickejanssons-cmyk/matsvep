// Hämtar recept och priser och skriver data/data.json.
// Körs varje natt av GitHub Actions (.github/workflows/update.yml), eller lokalt: node scripts/update.mjs
import fs from 'node:fs/promises';
import { CATALOG, CATS } from './catalog.mjs';
import { parseLine, servingsOf, matchProduct } from './parse.mjs';
import { SEED } from './seed.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIMIT = { ica: 190, lidl: 70, linas: 130 };

async function get(url, { json = false, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9', accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) { if (i === tries - 1) { log('FEL', url, e.message); return null; } await sleep((/403|429/.test(e.message) ? 8000 : 1500) * (i + 1)); }
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
const ogImage = html => (html && (html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image/i) || [])[1]) || null;
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
  const cats = [['notkott', 'lm'], ['kottfars', 'lm'], ['biff', 'lm'], ['pannbiff', 'lm'], ['kalops', 'lm'], ['gryta', 'lm'], ['lasagne', 'lm'], ['hamburgare', 'lm'], ['fisk', 'lm'], ['lax', 'lm'], ['torsk', 'lm'], ['fiskgryta', 'lm'], ['rakor', 'lm'], ['fisk-och-skaldjur', 'lm'], ['frukost', 'f'], ['billig/frukost', 'f'], ['grot', 'f'], ['billig/husmanskost', 'lm'], ['billig/gryta', 'lm'], ['billig/soppa', 'lm'], ['billig/pasta', 'lm'], ['billig/kottfarssas', 'lm'], ['billig/stroganoff', 'lm'], ['billig/omelett', 'lm'], ['billig/pyttipanna', 'lm'], ['billig/tacos', 'lm'], ['billig/wraps', 'l'], ['billig/risotto', 'lm'], ['billig/kottbullar', 'lm'], ['billig/chili-con-carne', 'lm'], ['billig/gratang', 'lm'], ['billig/paj', 'lm'], ['billig/pannkakor', 'lm'], ['billig/sallad', 'l'], ['vardagsmat', 'lm']];
  const found = new Map();
  for (const [c, t] of cats) {
    const h = await get('https://www.ica.se/recept/' + c + '/');
    if (!h) continue;
    for (const m of h.matchAll(/\/recept\/([a-z0-9-]+-\d{5,})\//g)) if (!found.has(m[1])) found.set(m[1], t);
  }
  const ids = [...found.keys()].slice(0, LIMIT.ica);
  log('ICA recept', ids.length);
  const out = await pool(ids, 1, async id => {
    await sleep(700);
    const url = 'https://www.ica.se/recept/' + id + '/';
    const h = await get(url); if (!h) return null;
    const r = ldRecipe(h); if (!r || !r.recipeIngredient) return null;
    return build('ICA', url, r.name, imgOf(r.image), r.recipeYield, minutes(r.totalTime), r.recipeIngredient, found.get(id));
  });
  return out.filter(Boolean);
}

async function lidl() {
  const pages = [['urval/kategori/kott', 'lm'], ['urval/kategori/notkott', 'lm'], ['urval/kategori/fisk-och-skaldjur', 'lm'], ['urval/kategori/fisk', 'lm'], ['urval/kategori/husmanskost', 'lm'], ['urval/kategori/middag', 'lm'], ['urval/kategori/vardagsmat', 'lm'], ['urval/kategori/snabbt-och-enkelt', 'lm'], ['urval/kategori/frukost', 'f']];
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
  const cats = ['kott', 'fisk', 'skaldjur', 'svenska', 'gryta', 'fagel', 'soppa', 'asiatiska'];
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
  if (unit === 'st') { m = (v + ' ' + String(item.name || '').toLowerCase()).match(/(\d+)\s?(?:p\b|-pack|pack|st\b)/); return m ? +m[1] : 1; }
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
    const re = new RegExp(p.re), ex = p.ex ? new RegExp(p.ex) : null;
    const cands = j.results.filter(x => re.test(x.name) && !(ex && ex.test(x.name)) && x.priceValue > 0 && !x.outOfStock).map(x => {
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

const BAD_OFFER = /,|röra|röror|marin|wienerbröd|chips|kryddad|margarin|bulle|kaka|smoothie|godis|choklad|glass|läsk|pant|blommor|rosor|ljus|tvätt|papper|schampo|kaffe|energidryck|proteinshake|pizzakit|pinsa|nutella|salladsbar|julskinka|kebab|fiskpinnar|lingonbröd|köttbullar|panerad|gratäng|pytt|pizza|paj|soppa|färdigrätt|grillad|sallad med|wrap|burgare|nuggets/i;
function offerProduct(name) {
  if (!name || BAD_OFFER.test(name)) return null;
  const p = matchProduct(name); if (!p) return null;
  const first = name.split(' ').slice(0, 3).join(' ');
  return new RegExp(p.re, 'i').test(first) || new RegExp(p.kw, 'i').test(name.split(' ')[0]) ? p : null;
}
const num = s => parseFloat(String(s || '').replace(/[^0-9,.-]/g, '').replace(',', '.'));

async function willysOffers() {
  const all = [];
  for (let page = 0; page < 4; page++) {
    const j = await get(`https://www.willys.se/search/campaigns/offline?q=2114&type=PERSONAL_GENERAL&page=${page}&size=100`, { json: true });
    if (!j || !j.results || !j.results.length) break;
    all.push(...j.results);
    if (page + 1 >= (j.pagination?.numberOfPages || 1)) break;
  }
  const list = [];
  for (const x of all) {
    const pr = (x.potentialPromotions || [])[0]; if (!pr) continue;
    const ord = num(x.price), qty = pr.qualifyingCount || 1, val = num(pr.rewardLabel) || pr.price;
    const per = val / (/för/.test(pr.conditionLabel || '') ? qty : 1);
    const ratio = ord > 0 && per > 0 ? per / ord : null;
    const p = offerProduct(x.name);
    list.push({ n: x.name, t: `${pr.conditionLabel ? pr.conditionLabel + ' ' : ''}${pr.rewardLabel || ''}${/kg/.test(x.priceUnit) ? '' : ''}`.trim() + (pr.redeemLimitLabel ? ` · ${pr.redeemLimitLabel}` : ''), ord: x.price, r: ratio && ratio < 0.97 && ratio > 0.2 ? Math.round(ratio * 1000) / 1000 : null, pid: p ? p.id : null, img: x.image?.url || x.thumbnail?.url || null, until: pr.endDate || '', plus: pr.campaignType === 'LOYALTY' ? 1 : 0, w: pr.weightVolume || '' });
  }
  log('Willys Katrinelund erbjudanden', list.length, 'matchade', list.filter(o => o.pid && o.r).length);
  return list;
}

function unesc(s) { return s.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
async function lidlOffers() {
  const home = await get('https://www.lidl.se/'); if (!home) return [];
  const links = uniq([...home.matchAll(/\/c\/store\/([a-z0-9-]+)\/a(\d+)/g)].filter(m => /frukt|mandag|tisdag|onsdag|torsdag|fredag|lidl-plus-erbjudanden|superklipp|kott|fisk/.test(m[1])).map(m => `/c/store/${m[1]}/a${m[2]}`));
  const list = [], seen = new Set();
  for (const l of links.slice(0, 12)) {
    const h = await get('https://www.lidl.se' + l); if (!h) continue;
    for (const m of h.matchAll(/data-grid-data="([^"]+)"/g)) {
      let d; try { d = JSON.parse(unesc(m[1])); } catch { continue; }
      const title = d.fullTitle || d.title; if (!title || seen.has(title)) continue;
      const rp = d.regionsPrices ? Object.values(d.regionsPrices)[0] : null;
      const cp = rp?.currentPrice?.price || rp?.currentLidlPlusPrice?.price || d.price;
      if (!cp || !(cp.price > 0)) continue;
      const old = cp.oldPrice || cp.discount?.deletedPrice || null;
      const unit = cp.basePrice?.text || cp.packaging?.text || '';
      const p = offerProduct(title);
      seen.add(title);
      list.push({ n: title, t: `${String(cp.price).replace('.', ',')} kr${/^\//.test(unit) ? unit : ''}${unit && !/^\//.test(unit) ? ' (jfr ' + unit + ')' : ''}`, ord: old ? String(old).replace('.', ',') + ' kr' : '', r: old && cp.price < old ? Math.round(cp.price / old * 1000) / 1000 : null, pid: p ? p.id : null, img: d.image || d.imageList_V1?.[0]?.image || null, until: (cp.endDate || '').slice(0, 10), plus: rp?.currentLidlPlusPrice ? 1 : 0, w: d.keyfacts?.supplementalDescription || '' });
    }
  }
  log('Lidl erbjudanden', list.length, 'matchade', list.filter(o => o.pid && o.r).length);
  return list;
}

async function icaOffers() {
  const url = 'https://www.ica.se/erbjudanden/ica-supermarket-varnhem-1004543/';
  const h = await get(url); if (!h) return { ok: false };
  const m = h.match(/window\.__INITIAL_DATA__\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return { ok: false };
  let d; try { d = JSON.parse(jsObjectToJson(m[1].trim().replace(/;\s*$/, ''))); } catch (e) { log('ICA erbjudanden: kunde inte tolka', e.message); return { ok: false }; }
  const list = d?.offers?.weeklyOffers || [];
  const out = {}; const all = [];
  for (const o of list) {
    const name = [o.details?.name, o.details?.brand].filter(Boolean).join(' ');
    const on = o.details?.name || '';
    if (/,|röra|röror|marin|wienerbröd|chips|kryddad|margarin|bulle|kaka|smoothie|dryck(?!.*havre)/i.test(on)) continue;
    const p = offerProduct(on);
    const pm = o.parsedMechanics || {};
    const reg = parseFloat(String(o.stores?.[0]?.regularPrice || '').replace(',', '.'));
    const val = parseFloat(String(pm.value2 || '').replace(',', '.'));
    const qty = +pm.quantity || 1;
    const img = o.picture ? `${o.picture.baseUrl}/q_auto,f_auto/c_lpad,h_200,w_200/${o.picture.fileName}.jpg` : null;
    const ratio = reg > 0 && val > 0 && pm.benefitType === 'FIXED' ? val / qty / reg : null;
    all.push({ n: on, t: o.details?.mechanicInfo || '', ord: o.stores?.[0]?.regularPrice ? o.stores[0].regularPrice + ' kr' : '', r: ratio && ratio < 0.97 && ratio > 0.2 ? Math.round(ratio * 1000) / 1000 : null, pid: p ? p.id : null, img, until: (o.validTo || '').slice(0, 10), plus: (o.traits || []).includes('Stammis') ? 1 : 0, w: o.details?.packageInformation || '' });
    if (!p || !ratio || ratio >= 0.97 || ratio < 0.2) continue;
    if (!out[p.id] || ratio < out[p.id].ratio) out[p.id] = { ratio: Math.round(ratio * 1000) / 1000, text: `${o.details?.name} ${o.details?.mechanicInfo || ''} (ord. ${o.stores?.[0]?.regularPrice} kr)`.trim(), until: (o.validTo || '').slice(0, 10), img };
  }
  log('ICA Värnhem erbjudanden', list.length, 'matchade', Object.keys(out).length);
  return { ok: true, total: list.length, items: out, all };
}

// ---------- Kör ----------
const t0 = Date.now();
const [prices, offersIca, offWillys, offLidl, rIca, rLidl, rLinas, rSeed] = await Promise.all([willys(), icaOffers(), willysOffers(), lidlOffers(), ica(), lidl(), linas(), seeded()]);
let recipes = [...rIca, ...rLidl, ...rLinas, ...rSeed].filter(r => r && r.i.length >= 2 && r.cover >= 60 && r.n);
const seen = new Set(); recipes = recipes.filter(r => !seen.has(r.id) && seen.add(r.id));
const products = CATALOG.filter(p => prices[p.id]).map(p => ({ id: p.id, n: p.n, c: p.c, unit: p.unit, base: p.base ? 1 : 0, pk: prices[p.id].pk, price: prices[p.id].price, wn: prices[p.id].name, loose: prices[p.id].loose ? 1 : 0, promo: prices[p.id].promo || '' }));
const have = new Set(products.map(p => p.id));
const PP = Object.fromEntries(products.map(p => [p.id, p]));
const perPortion = r => r.i.reduce((t, [id, a]) => PP[id] ? t + a / r.p / PP[id].pk * PP[id].price : t, 0);
recipes = recipes.filter(r => r.i.every(([id]) => have.has(id)) || (r.i = r.i.filter(([id]) => have.has(id))).length >= 2);
recipes = recipes.filter(r => { const c = perPortion(r); r.pp = Math.round(c * 10) / 10; return c > 0.5 && c <= 110; });

let old = null; try { old = JSON.parse(await fs.readFile('data/data.json', 'utf8')); } catch { }
if (products.length < 40 || recipes.length < 30) {
  log('För lite data hämtades (produkter', products.length, 'recept', recipes.length + '). Behåller förra filen.');
  if (old) process.exit(0); else process.exit(1);
}
function toMap(list) { const m = {}; for (const o of list) if (o.pid && o.r && (!m[o.pid] || o.r < m[o.pid].ratio)) m[o.pid] = { ratio: o.r, text: `${o.n} ${o.t}${o.ord ? ' (ord. ' + o.ord + ')' : ''}`, until: o.until, img: o.img }; return m; }
const data = {
  updated: new Date().toISOString(),
  stores: {
    willys: { n: 'Willys Katrinelund', addr: 'Celsiusgatan 38', how: 'Willys hyllpriser från willys.se (samma i hela landet), plus butikens veckoerbjudanden', url: 'https://www.willys.se/erbjudanden/butik' },
    lidl: { n: 'Lidl Knivgatan', addr: 'Knivgatan 1B', how: 'Uppskattat: Willys-pris × 0,97 (Lidl visar inga ordinarie priser på nätet), plus veckans erbjudanden (samma i alla Lidl-butiker)', f: 0.97, url: 'https://www.lidl.se/c/reklamblad/s10018018' },
    ica: { n: 'ICA Supermarket Värnhem', addr: 'Värnhem', how: 'Uppskattat: Willys-pris × 1,07 enligt PRO:s prisundersökning, plus butikens egna veckoerbjudanden', f: 1.07, url: 'https://www.ica.se/erbjudanden/ica-supermarket-varnhem-1004543/' },
    coop: { n: 'Coop Värnhem', addr: 'Föreningsgatan 72', how: 'Uppskattat: Willys-pris × 1,08. Coops erbjudanden är låsta för andra appar och kan inte hämtas.', f: 1.08, url: 'https://www.coop.se/butiker-erbjudanden/coop/coop-varnhem/' },
  },
  cats: CATS,
  products,
  offers: { ica: offersIca.ok ? offersIca.items : {}, willys: toMap(offWillys), lidl: toMap(offLidl), coop: {} },
  offerLists: { ica: offersIca.ok ? offersIca.all : [], willys: offWillys, lidl: offLidl, coop: [] },
  recipes,
  stats: { ica: rIca.length, lidl: rLidl.length, linas: rLinas.length, seed: rSeed.length, kept: recipes.length, secs: Math.round((Date.now() - t0) / 1000) },
};
await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/data.json', JSON.stringify(data));
log('Klart:', products.length, 'varor,', recipes.length, 'recept', data.stats);
