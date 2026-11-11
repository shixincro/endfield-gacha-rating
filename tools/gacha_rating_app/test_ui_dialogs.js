'use strict';
// Complete-source frontend tests with a deliberately small DOM/API simulator.
// This is deterministic state-flow coverage, not browser/layout acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticDir = path.join(__dirname, 'static');
const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8');
const model = fs.readFileSync(path.join(staticDir, 'ui-model.js'), 'utf8');
const editModel = fs.readFileSync(path.join(staticDir, 'character-edit.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this._text = ''; this.attributes = {}; this.listeners = {}; this.style = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.open = false; this.returnValue = ''; this.className = ''; this.dataset = {}; this.inert = false;
    this.classList = {
      add: (...names) => {this.className = [...new Set([...this.className.split(/\s+/), ...names])].filter(Boolean).join(' ');},
      remove: (...names) => {this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' ');},
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {const on = force ?? !this.classList.contains(name); this.classList[on ? 'add' : 'remove'](name); return on;},
    };
  }
  set textContent(value) {this._text = String(value ?? ''); this.children = [];}
  get textContent() {return this._text + this.children.map(c => c.textContent ?? String(c)).join('');}
  append(...items) {for (const item of items) {const child = typeof item === 'string' ? Object.assign(new Element('#text'), {_text: item}) : item; if (!child) continue; child.parentNode = this; this.children.push(child);}}
  appendChild(child) {this.append(child); return child;}
  replaceChildren(...items) {this._text = ''; this.children = []; this.append(...items);}
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'id') this.id = String(value);
    if (key === 'inert') this.inert = true;
    if (key === 'hidden') this.hidden = true;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(key) {return this.attributes[key] ?? null;}
  hasAttribute(key) {return Object.hasOwn(this.attributes, key);}
  removeAttribute(key) {delete this.attributes[key]; if (key === 'inert') this.inert = false; if (key === 'hidden') this.hidden = false;}
  addEventListener(type, fn) {(this.listeners[type] ||= []).push(fn);}
  removeEventListener(type, fn) {this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);}
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    event.preventDefault ||= function () {this.defaultPrevented = true;};
    this['on' + event.type]?.(event);
    for (const fn of this.listeners[event.type] || []) fn(event);
    return !event.defaultPrevented;
  }
  click() {if (!this.disabled) return this.onclick?.({target: this, preventDefault() {}});}
  showModal() {this.open = true;}
  close(value = '') {this.returnValue = value; this.open = false; this.dispatchEvent({type: 'close'});}
  focus() {this.focused = true;}
  getBoundingClientRect() {return {left: 100, top: 100, right: 700, bottom: 600};}
  remove() {if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this);}
  contains(node) {return this === node || this.children.some(c => c.contains?.(node));}
  get firstChild() {return this.children[0] || null;}
  get firstElementChild() {return this.children[0] || null;}
  get childNodes() {return this.children;}
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attr = selector.match(/^([a-z]+)?\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/i);
    if (attr) return (!attr[1] || this.tagName.toLowerCase() === attr[1].toLowerCase()) &&
      this.hasAttribute(attr[2]) && (attr[3] === undefined || this.getAttribute(attr[2]) === attr[3]);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const all = [];
    const walk = node => {for (const child of node.children) {if (child.matches(selector)) all.push(child); walk(child);}};
    walk(this); return all;
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
}

function harness(config = {}) {
  const nodes = {}, staticNodes = [], pending = [], requests = [], timers = new Map(); let timerId = 0, clockTime = 0;
  const replies = new Map([['/api/config', {token: 'test-token', ...config}], ['/api/sessions', []]]);
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const node = new Element(match[1]); node.id = match[2];
    for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    node.hidden = /\shidden(?=[\s>])/.test(match[0]); node.disabled = /\sdisabled(?=[\s>])/.test(match[0]);
    node.inert = /\sinert(?=[\s>])/.test(match[0]);
    nodes[node.id] = node; staticNodes.push(node);
  }
  for (const match of html.matchAll(/<button\b[^>]*\bdata-close-dialog="([^"]+)"[^>]*>([^<]*)<\/button>/gi)) {
    const node = new Element('button'); node.dataset.closeDialog = match[1];
    node.setAttribute('data-close-dialog', match[1]); node.textContent = match[2]; staticNodes.push(node);
  }
  const document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    body: new Element('body'), activeElement: null,
    querySelector: selector => selector.startsWith('#') ? nodes[selector.slice(1)] || null : null,
    querySelectorAll: selector => [...new Set([...staticNodes.filter(n => n.matches(selector)),
      ...Object.values(nodes).flatMap(n => n.querySelectorAll(selector))])],
  };
  const ctx = vm.createContext({
    console, document, window: {}, structuredClone, Blob, URL, JSON, Date,
    FileReader: class {
      readAsDataURL(file) {this.result = 'data:image/png;base64,' + (file.data || 'fixture'); this.onload?.();}
    },
    setTimeout: (fn, ms) => {const id = ++timerId; timers.set(id, {fn, ms, at:clockTime+(Number(ms)||0)}); return id;},
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({url, body});
      if (replies.has(url)) return {ok: true, json: async () => structuredClone(replies.get(url))};
      if (url === '/api/validate' && !config.manualValidation) return {ok: true, json: async () => ({ledger: structuredClone(body.session.ledger)})};
      return new Promise((resolve, reject) => pending.push({url, body, resolve: (value, ok=true) => resolve({ok, json: async () => value}), reject}));
    },
  });
  vm.runInContext(model, ctx, {filename: 'ui-model.js'});
  vm.runInContext(editModel, ctx, {filename: 'character-edit.js'});
  vm.runInContext(source, ctx, {filename: 'app.js'});
  return {ctx, nodes, staticNodes, pending, requests, replies, timers,
    read: code => vm.runInContext(code, ctx),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(session)', ctx)),
    flushTimers: () => {const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job.fn();},
    advanceTimers: milliseconds => {
      const until=clockTime+milliseconds;
      while(true){const next=[...timers.entries()].filter(([,job])=>job.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;
        timers.delete(next[0]);clockTime=next[1].at;next[1].fn();}
      clockTime=until;
    },
  };
}

function pool(extra = {}) {
  return {id: 'p0', banner: '熔火灼痕', up: '莱万汀', index: 0, total: 60,
    initialPity: 0, tail: 10, quota: 5000, events: [{at: 50, character: '莱万汀', source: 'main'}],
    rushUsed: true, rushAt: 30, rush: [], tokens: [], ended: true, issues: [], ...extra};
}
function record(id = 'A', pools = [pool()], weapon = {N: 60, K6: 2, KU: 1, B: 1, H80: null}) {
  return {id, schemaVersion: 'gacha-rating-session-v1', revision: 1, reviewed: true,
    documents: [{file: 'fixture.png', source_sha256: 'abc', sourceImage: '/data/fixture/source.png'}],
    ledger: {schemaVersion: 'gacha-ledger-v1', character: {pools, initialPity: 0, initialOwned: [], completeHistory: true}, weapon, issues: []},
    result: {axes: {}, scoredAxes: 0, elapsedSeconds: .001, warnings: [], planning: {pools: []}},
  };
}
function scoredAxes(values = {}) {
  return Object.fromEntries(['characterSix', 'up', 'limited', 'five', 'weaponSix', 'signature']
    .map(key => [key, {score: values[key] ?? 50, status: 'scored'}]));
}
function radarScore(root, label) {
  const text = root.querySelectorAll('text');
  const index = text.findIndex(node => node.textContent === label);
  assert(index >= 0, 'radar axis missing: ' + label);
  return text[index + 1].textContent;
}
function findField(root, label) {
  const wrapper = root.querySelectorAll('label').find(n => n.children.some(c => c.tagName === 'SPAN' && c.textContent.includes(label)));
  assert(wrapper, 'field not found: ' + label);
  const input = wrapper.querySelector('input') || wrapper.querySelector('select');
  assert(input, 'input not found: ' + label); return input;
}
function setField(root, label, value) {
  const input = findField(root, label); input.value = String(value); input.onchange?.({target: input}); return input;
}
function findButton(root, text) {
  const found = root.querySelectorAll('button').find(n => n.textContent === text);
  assert(found, 'button not found: ' + text); return found;
}
function assertNoManualAcknowledgement(root) {
  assert.equal(root.querySelectorAll('button').filter(n => /核对|已对照原图纠正/.test(n.textContent)).length, 0,
    'saving structurally valid corrections must not require a separate acknowledgement button');
}
function erroneousPool(id, index, extra = {}) {
  return pool({id, index, initialPity:index===0?0:10,banner: '测试卡池' + index,
    issues: [{code: 'fixture_ocr_error', severity: 'error', message: '请核对测试卡池' + index}],
    ...extra});
}
function openProfileWeapon(h) {
  h.nodes.weaponConfigured.click();const toggle=findField(h.nodes.weaponReview,'潜能配置修正');
  if(!toggle.checked){toggle.checked=true;toggle.onchange();}
}
function weaponButtonActive(h){return h.nodes.weaponConfigured.getAttribute('aria-pressed')==='true';}
function escape(dialog) {
  const event = {type: 'cancel', defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}};
  dialog.dispatchEvent(event); if (!event.defaultPrevented) dialog.close();
}
// Drain the complete cross-context promise chain, not a guessed number of awaits.
// App-owned delayed timers still run only when flushTimers() is called.
const tick = () => new Promise(resolve => setImmediate(resolve));
const planningVersion = 'planning-local-table-v2.1-free-floor-20261016';

async function main() {
  const results = [];
  const test = async (name, fn) => {
    try {await fn(); results.push(name);} catch (error) {error.message = '[' + name + '] ' + error.message; throw error;}
  };
  const loaded = async () => {
    const h = harness(); await tick(); h.ctx.loadSession(record()); await tick();
    assert.equal(h.pending.length, 0, 'complete defaults should not rescore on load');
    return h;
  };
  const mainRows = h => h.nodes.review.querySelectorAll('tr').filter(row => row.children[0]?.textContent === '主池');
  const rushRows = h => h.nodes.review.querySelectorAll('tr').filter(row => row.children[0]?.textContent === '加急');
  const chooseCharacter = (row, name) => {
    const input = row.querySelector('select'); assert(input); input.value = name; input.onchange({target: input});
  };
  await test('supplement keeps expanded pools visible and focuses the new main input', async () => {
    const h = await loaded();
    h.ctx.loadSession(record('two-pools', [pool(), pool({id:'p1',index:1,banner:'轻飘飘的信使',up:'洁尔佩塔'})]));
    h.nodes.openResults.click();h.nodes.review.querySelectorAll('details')[0].open=true;
    findButton(h.nodes.review.querySelectorAll('details')[0],'补充出货记录').click();h.flushTimers();
    const blocks=h.nodes.review.querySelectorAll('details');
    assert.equal(blocks[0].open,true);assert.equal(blocks[1].open,false);
    const row=blocks[0].querySelectorAll('tr').at(-1);
    assert.equal(row.querySelector('input').focused,true);
    assert.equal(h.read('characterDraft.pools[0].events.length'),2);
    assert.equal(h.state().ledger.character.pools[0].events.length,1);
  });
  await test('main supplement recalculates the ending pity and saves without a second manual edit', async () => {
    const h=await loaded(),before=h.state();h.nodes.openResults.click();
    findButton(h.nodes.review,'补充出货记录').click();
    setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),5);
    assert.deepEqual(h.state(),before);h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.state().ledger.character.pools[0].tail,5);
    assert.deepEqual(h.state().ledger.character.pools[0].events.map(e=>e.at),[50,55]);
    h.flushTimers();await tick();assert.equal(h.pending.filter(p=>p.url==='/api/score').length,1);
    assert.equal(h.pending.find(p=>p.url==='/api/score').body.session.ledger.character.pools[0].tail,5);
  });
  await test('inserting a missed earlier hit keeps the latest ending pity and saves sorted events', async () => {
    const h=await loaded();h.nodes.openResults.click();findButton(h.nodes.review,'补充出货记录').click();
    setField(mainRows(h).at(-1),'累计抽数',20);chooseCharacter(mainRows(h).at(-1),'余烬');
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),10);h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);
    assert.deepEqual(h.state().ledger.character.pools[0].events.map(e=>e.at),[20,50]);
  });
  await test('editing total and latest hit keeps displayed and submitted ending pity synchronized', async () => {
    const h=await loaded();h.nodes.openResults.click();
    setField(h.nodes.review,'主池总抽数',61);assert.equal(Number(findField(h.nodes.review,'期末水位').value),11);
    setField(mainRows(h)[0],'累计抽数',56);assert.equal(Number(findField(h.nodes.review,'期末水位').value),5);
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.state().ledger.character.pools[0].tail,5);
  });
  await test('removing the final main hit restores the known no-hit ending pity without collapsing the pool', async () => {
    const h=await loaded();h.nodes.openResults.click();h.nodes.review.querySelector('details').open=true;
    findButton(mainRows(h)[0],'移除行').click();
    assert.equal(h.nodes.review.querySelector('details').open,true);
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),60);
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.state().ledger.character.pools[0].events.length,0);
    assert.equal(h.state().ledger.character.pools[0].tail,60);
  });
  await test('known opening pity participates in no-hit ending-pity updates', async () => {
    const h=await loaded();h.ctx.loadSession(record('known-start',[pool({total:30,initialPity:7,tail:37,events:[]})]));
    h.nodes.openResults.click();setField(h.nodes.review,'期初水位',9);
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),39);
    setField(h.nodes.review,'主池总抽数',31);assert.equal(Number(findField(h.nodes.review,'期末水位').value),40);
    h.nodes.resultsApply.click();assert.equal(h.state().ledger.character.pools[0].tail,40);
  });
  await test('unknown opening pity is never replaced by zero while supplementing an incomplete record', async () => {
    const h=await loaded();h.ctx.loadSession(record('unknown-start',[pool({total:30,initialPity:null,tail:37,events:[]})]));
    h.nodes.openResults.click();setField(h.nodes.review,'主池总抽数',31);
    assert.equal(h.read('characterDraft.pools[0].initialPity'),null);
    assert.equal(findField(h.nodes.review,'期末水位').value,'');
    assert.equal(h.read('characterDraft.pools[0].tail'),null);
    findButton(h.nodes.review,'补充出货记录').click();setField(mainRows(h)[0],'累计抽数',20);
    chooseCharacter(mainRows(h)[0],'余烬');assert.equal(Number(findField(h.nodes.review,'期末水位').value),11);
    assert.equal(h.read('characterDraft.pools[0].initialPity'),null);
  });
  await test('invalid added positions stay invalid and cannot overwrite the saved record', async () => {
    for(const at of [61,50,55.5,'']){
      const h=await loaded(),before=h.state();h.nodes.openResults.click();findButton(h.nodes.review,'补充出货记录').click();
      setField(mainRows(h).at(-1),'累计抽数',at);chooseCharacter(mainRows(h).at(-1),'余烬');h.nodes.resultsApply.click();
      assert.equal(h.nodes.resultsDialog.open,true);assert.deepEqual(h.state(),before);
      assert(h.nodes.characterDialogError.textContent.includes('六星记录'));
      assert.equal(h.pending.length,0);
    }
  });
  await test('rush supplement records an independent hit without changing main pity', async () => {
    const h=await loaded();h.ctx.loadSession(record('rush-new',[pool({rushUsed:false,rushAt:null})]));h.nodes.openResults.click();
    h.nodes.review.querySelector('details').open=true;findButton(h.nodes.review,'补充加急出货').click();h.flushTimers();
    assert.equal(h.nodes.review.querySelector('details').open,true);
    const row=rushRows(h)[0];assert(row);assert.equal(row.querySelector('input'),null);
    assert.equal(row.querySelector('select').focused,true);chooseCharacter(row,'余烬');
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),10);h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);const p=h.state().ledger.character.pools[0];
    assert.equal(p.rushUsed,true);assert.equal(p.rushAt,30);assert.equal(p.tail,10);
    assert.equal(p.events.length,1);assert.equal(p.rush.length,1);assert.equal(p.rush[0].character,'余烬');
  });
  await test('removing a rush hit does not reset the main pity or erase rush use', async () => {
    const h=await loaded();h.ctx.loadSession(record('rush-delete',[pool({rush:[{character:'余烬',source:'rush'}]})]));
    h.nodes.openResults.click();h.nodes.review.querySelector('details').open=true;findButton(rushRows(h)[0],'移除行').click();
    assert.equal(h.nodes.review.querySelector('details').open,true);assert.equal(Number(findField(h.nodes.review,'期末水位').value),10);
    h.nodes.resultsApply.click();const p=h.state().ledger.character.pools[0];
    assert.equal(p.rush.length,0);assert.equal(p.rushUsed,true);assert.equal(p.tail,10);
  });
  await test('rush supplement unlocks after correcting the main total and stops at ten hits', async () => {
    const h=await loaded();h.ctx.loadSession(record('rush-unlock',[pool({total:20,tail:20,events:[],rushUsed:false,rushAt:null})]));
    h.nodes.openResults.click();assert.equal(findButton(h.nodes.review,'补充加急出货').disabled,true);
    setField(h.nodes.review,'主池总抽数',30);assert.equal(findButton(h.nodes.review,'补充加急出货').disabled,false);
    for(let i=0;i<10;i++){
      findButton(h.nodes.review,'补充加急出货').click();chooseCharacter(rushRows(h).at(-1),'余烬');
    }
    const add=findButton(h.nodes.review,'补充加急出货');assert.equal(add.disabled,true);add.click();
    assert.equal(rushRows(h).length,10);h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.state().ledger.character.pools[0].rushAt,30);
  });
  await test('supplemented main and rush records remain consumable by the production character scorer', async () => {
    const h=await loaded();h.nodes.openResults.click();findButton(h.nodes.review,'补充出货记录').click();
    setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    findButton(h.nodes.review,'补充加急出货').click();chooseCharacter(rushRows(h)[0],'莱万汀');h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);
    const scored=require('./character_score').scoreCharacter(h.state().ledger.character);
    for(const axis of ['characterSix','up','limited'])assert.equal(scored.axes[axis].status,'scored',scored.axes[axis].reason);
  });
  await test('rush status redraw preserves an open pool and main supplement values', async () => {
    const h=await loaded();h.nodes.openResults.click();h.nodes.review.querySelector('details').open=true;
    findButton(h.nodes.review,'补充出货记录').click();setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    setField(h.nodes.review,'加急使用状态','false');
    assert.equal(h.nodes.review.querySelector('details').open,true);
    assert.equal(Number(findField(mainRows(h).at(-1),'累计抽数').value),55);
    assert.equal(mainRows(h).at(-1).querySelector('select').value,'余烬');
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),5);
  });
  await test('cancel discards added hits and derived pity changes without touching the saved record', async () => {
    const h=await loaded(),before=h.state();h.nodes.openResults.click();findButton(h.nodes.review,'补充出货记录').click();
    setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    findButton(h.nodes.review,'补充加急出货').click();chooseCharacter(rushRows(h)[0],'余烬');
    h.nodes.resultsCancel.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
    h.nodes.openResults.click();assert.equal(mainRows(h).length,1);assert.equal(rushRows(h).length,0);
    assert.equal(Number(findField(h.nodes.review,'期末水位').value),10);
  });
  await test('opening and saving an unchanged dialog does not silently repair existing ending-pity evidence', async () => {
    const h=await loaded();h.ctx.loadSession(record('original-tail',[pool({tail:12})]));const before=h.state();
    h.nodes.openResults.click();assert.equal(Number(findField(h.nodes.review,'期末水位').value),12);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
  });
  await test('main supplement propagates ending pity only through a matching contiguous inheritance link', async () => {
    const h=await loaded(),saved=record('carry',[pool(),pool({id:'p1',index:1,total:20,initialPity:10,tail:30,events:[],rushUsed:false,rushAt:null}),
      pool({id:'p2',index:3,total:20,initialPity:30,tail:50,events:[],rushUsed:false,rushAt:null})]);
    saved.ledger.character.completeHistory=false;h.ctx.loadSession(saved);
    h.nodes.openResults.click();const first=h.nodes.review.querySelectorAll('details')[0];first.open=true;
    findButton(first,'补充出货记录').click();setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    const draft=JSON.parse(h.read('JSON.stringify(characterDraft)'));
    assert.equal(draft.pools[0].tail,5);assert.equal(draft.pools[1].initialPity,5);assert.equal(draft.pools[1].tail,25);
    assert.equal(draft.pools[2].initialPity,30);assert.equal(draft.pools[2].tail,50);
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.state().ledger.character.pools[1].initialPity,5);
  });
  await test('supplement updates aggregate coverage counts without changing recorded quota output', async () => {
    const h=await loaded(),saved=record('quota-supplement',[pool({quota:null})]);
    saved.ledger.character.quotaSummary={scope:'all-pools',Q:5000,N:60,R:1,K6:1};h.ctx.loadSession(saved);h.nodes.openResults.click();
    findButton(h.nodes.review,'补充出货记录').click();setField(mainRows(h).at(-1),'累计抽数',55);chooseCharacter(mainRows(h).at(-1),'余烬');
    findButton(h.nodes.review,'补充加急出货').click();chooseCharacter(rushRows(h)[0],'余烬');
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    const q=h.state().ledger.character.quotaSummary;assert.equal(q.Q,5000);assert.equal(q.N,60);assert.equal(q.R,1);assert.equal(q.K6,3);
  });
  await test('Si is editable as a recognized character in the new banner',async()=>{
    const h=harness();await tick();
    const saved=record('si-pool',[pool({index:11,banner:'万物更新',up:'祀',events:[{at:50,character:'祀',forced:false,source:'main'}]})]);
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();
    assert(h.nodes.review.querySelectorAll('option').some(n=>n.textContent==='祀'));
    assert.equal(h.read('validateEditedPool(session.ledger.character.pools[0])'),'');
  });
  await test('full source loads with UI model and without a mean DOM node', async () => {
    const h = await loaded(); assert(h.ctx.window.RatingUIModel); assert(!h.nodes.mean);
    assert(!/\$\(['"]mean['"]\)/.test(source), 'app must not access deleted mean element');
  });
  await test('A zero with positive B remains visible while opportunity explanations are removed', async () => {
    const h = harness(); await tick(); const saved=record();
    saved.result.planning={pools:[{id:'p0',banner:'临渊望北',status:'ok',localLoss:0,
      total:70,idealStop:70,actual:{stop:70,pity:0},anchor:{at:70,source:'main',kind:'new-limited',character:'卡缪'},
      permanentDelta:0,waterValueDelta:0,rewardValueDelta:0,
      opportunity:{status:'ok',value:16.32,message:'比较本池继续与换池',limitations:'局部首UP机会估值',
        stay:{paid:45.4,terminal:60,net:105.4},switch:{paid:60,terminal:61.72,net:121.72}}}]};
    h.ctx.loadSession(saved);await tick();
    assert(h.nodes.planningHighlights.textContent.includes('自律狂人'));
    assert(h.nodes.planningHighlights.textContent.includes('资源损耗'));
    assert(h.nodes.planningHighlights.textContent.includes('0.00'));
    assert(h.nodes.planningHighlights.textContent.includes('16.32'));
    assert(!h.nodes.planningHighlights.textContent.includes('不与A相加'));
    assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length,0);
    h.nodes.openAllPlanning.click();findButton(h.nodes.planning,'详情').click();
    assert(h.nodes.planningDetailDialog.open);
    const detail=h.nodes.planningDetailContent.textContent;
    for(const text of ['New限定「卡缪」','机会估值 · 16.32'])assert(detail.includes(text));
    for(const text of ['继续本池','换到下池','终态资源成本','比较本池继续与换池','局部首UP机会估值','不与A相加'])assert(!detail.includes(text));
    assert.equal(h.pending.length,0,'opening detail never reruns DP or OCR');
  });
  await test('partial A can have known B and open details without formatting null as zero',async()=>{
    const h=harness();await tick();const saved=record();
    saved.result.planning={pools:[{id:'p0',banner:'未知New',status:'partial',localLoss:null,
      warnings:['New未知'],opportunity:{status:'ok',value:5,message:'独立可算'}}]};
    h.ctx.loadSession(saved);await tick();
    assert(h.nodes.planningHighlights.textContent.includes('5.00'));
    assert(h.nodes.planningHighlights.textContent.includes('数据不足'));
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.rating-title').length,0);
    findButton(h.nodes.planning,'详情').click();
    assert(h.nodes.planningDetailTitle.textContent.includes('数据不足'));
    assert(h.nodes.planningDetailContent.textContent.includes('New未知'));
    assert(h.nodes.planningDetailContent.textContent.includes('5.00'));
  });
  await test('main page keeps planning left, luck right, and all editing inside results tabs', async () => {
    const h = await loaded();
    assert.equal((html.match(/<section class="panel\b/g) || []).length, 2);
    for (const id of ['confirm', 'reviewState', 'weaponReviewState', 'openCharacterReview', 'openWeaponReview', 'characterDialog', 'weaponDialog', 'infoDialog', 'openInfo', 'summaryPlaceholder']) {
      assert(!h.nodes[id], id + ' is no longer part of the UI');
    }
    assert(!h.nodes.historySection, 'history must not remain a bottom page section');
    assert(!html.includes('核对'), 'static UI must not contain removed verification prompts');
    assert(html.indexOf('planning-score-panel') < html.indexOf('radar-panel'));
    assert(html.indexOf('id="openResults"') < html.indexOf('id="save"'));
    assert(!h.nodes.weaponDock);assert.equal(h.nodes.weaponConfigured.tagName,'BUTTON'); assert(h.nodes.luckTitle);
    const order=['openResults','weaponConfigured','manualSupplement','exportRadar','save'].map(id=>html.indexOf('id="'+id+'"'));
    assert.deepEqual(order,[...order].sort((a,b)=>a-b));assert(order[0]>=0);assert(!html.includes('<footer>'));
    for (const id of ['planningDetailDialog', 'planningAllDialog', 'resultsDialog', 'historyDialog']) {
      assert(h.nodes[id]); assert.equal(h.nodes[id].open, false, id + ' must remain closed on load');
    }
  });
  await test('top five losses stay compact and reveal their detail only after clicking', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: Array.from({length: 6}, (_, i) => ({id: 'p' + i,
      banner: '规划卡池' + i, status: 'ok', localLoss: (i + 1) * 10, total: 60,
      idealStop: 20, actual: {stop: 60}, permanentDelta: (i + 1) * 10, waterValueDelta: 0, rewardValueDelta: 0}))};
    h.ctx.loadSession(saved); await tick();
    const details = h.nodes.planningTopPools.querySelectorAll('button').filter(n => n.textContent === '详情');
    assert.equal(details.length, 5); assert.equal(h.nodes.planningTopPools.querySelectorAll('details').length, 0);
    assert(h.nodes.planningTopPools.textContent.includes('规划卡池5'));
    assert(!h.nodes.planningTopPools.textContent.includes('规划卡池0'));
    assert(!h.nodes.planningDetailDialog.open);
    details[0].click(); assert(h.nodes.planningDetailDialog.open);
    assert(h.nodes.planningDetailTitle.textContent.includes('规划卡池5'));
    assert(h.nodes.planningDetailContent.textContent.includes('永久投入差'));
    assert(h.nodes.planningDetailContent.textContent.includes('60.00'));
    const close = h.staticNodes.find(n => n.dataset.closeDialog === 'planningDetailDialog');
    close.click(); assert(!h.nodes.planningDetailDialog.open);
    h.nodes.openAllPlanning.click(); assert(h.nodes.planningAllDialog.open);
    assert(h.nodes.planning.textContent.includes('规划卡池0'));
    assert(h.nodes.planning.textContent.includes('规划卡池5'));
    assert(h.nodes.planning.textContent.includes('210.00'));
    escape(h.nodes.planningAllDialog); assert(!h.nodes.planningAllDialog.open);
  });
  await test('planning summary is compact and the all-results action belongs to the loss ranking header', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: [{id: 'p0', banner: '熔火灼痕', status: 'ok', localLoss: 10,
      total: 60, idealStop: 50, actual: {stop: 60}, permanentDelta: 10, waterValueDelta: 0, rewardValueDelta: 0}]};
    h.ctx.loadSession(saved); await tick();
    assert.equal(h.nodes.planningBreakdown.hidden, false);
    assert(h.nodes.planningHighlights.textContent.includes('自律狂人'));
    assert(h.nodes.planningHighlights.textContent.includes('资源损耗'));
    assert(h.nodes.planningHighlights.textContent.includes('10.00'));
    assert(!h.nodes.planningHighlights.textContent.includes('熔火灼痕'), 'ranking must be separate from summary typography');
    assert.equal(h.nodes.planningHighlights.querySelectorAll('button').length, 0);
    for (const explanation of ['越低越好', '负数表示', '不授予规划称号', '全账号重新规划的反事实']) {
      assert(!h.nodes.planningHighlights.textContent.includes(explanation));
      assert(!h.nodes.planning.textContent.includes(explanation));
    }
    const header = html.match(/<div\b[^>]*id="planningRankHeader"[^>]*>([\s\S]*?)<\/div>/);
    assert(header, 'the ranking has a stable header container');
    assert(header[1].includes('亏损最多'));
    assert(header[1].includes('TOP 5'));
    assert(header[1].includes('id="openAllPlanning"'), 'view all must share the ranking header rather than float below the panel');
    assert(!html.includes('直接累计亏损抽数，越低越好。'));
    assert(!html.includes('最后UP／信物为停点，46—59补60'));
  });
  await test('stale planning hides the old ranking and recomputation restores it', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: [{id: 'p0', banner: '熔火灼痕', status: 'ok', localLoss: 10,
      total: 60, idealStop: 50, actual: {stop: 60}, permanentDelta: 10, waterValueDelta: 0, rewardValueDelta: 0}]};
    h.ctx.loadSession(saved); await tick();
    assert.equal(h.nodes.planningBreakdown.hidden, false);
    assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length, 1);
    h.ctx.markStale();
    assert.equal(h.nodes.planningBreakdown.hidden, true);
    assert.equal(h.nodes.planningTopPools.textContent, '');
    assert(!h.nodes.planningHighlights.textContent.includes('10.00'));
    h.ctx.renderResults();
    assert.equal(h.nodes.planningBreakdown.hidden, false);
    assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length, 1);
  });
  await test('simplified planning keeps partial-data status and concrete calculation warnings', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: [
      {id: 'p0', banner: '熔火灼痕', status: 'ok', localLoss: 10, total: 60, idealStop: 50,
        actual: {stop: 60}, permanentDelta: 10, waterValueDelta: 0, rewardValueDelta: 0},
      {id: 'p1', banner: '缺项卡池', status: 'partial', localLoss: null},
    ], warnings: [{code: 'missing_water', severity: 'warning', message: '缺项卡池的期初水位缺失'}]};
    h.ctx.loadSession(saved); await tick();
    assert(h.nodes.planningHighlights.textContent.includes('资源损耗'));
    assert(h.nodes.planningHighlights.textContent.includes('已算 1/2 池'));
    assert(h.nodes.planningHighlights.textContent.includes('数据不完整'));
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.rating-title').length, 0);
    assert(h.nodes.planning.textContent.includes('缺项卡池的期初水位缺失'));
    assert(h.nodes.planning.textContent.includes('部分合计'));
  });
  await test('unavailable planning totals are not presented as zero draws or awarded a title', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: [{id: 'p0', banner: '缺项卡池', status: 'partial', localLoss: null}]};
    h.ctx.loadSession(saved); await tick();
    assert(h.nodes.planningHighlights.textContent.includes('数据不足'));
    assert(h.nodes.planningHighlights.textContent.includes('已算 0/1 池'));
    assert(!h.nodes.planningHighlights.textContent.includes('0.00'));
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.planning-score-unit').length, 0);
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.is-unavailable').length, 2);
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.rating-title').length, 0);
    assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length, 0);
  });
  await test('early free-stop details distinguish missing water valuation from actual future pulls', async () => {
    const h = harness(); await tick(); const saved = record('early-stop', [pool({total: 5, tail: 5,
      events: [], rushUsed: false, rushAt: null, quota: 100})]);
    const reason = '未用完免费额度，少积累5抽水位；参考水位仅用于规划估值，不代表实际补抽结果。';
    saved.result.planning = {version: planningVersion, pools: [{id: 'p0', banner: '熔火灼痕',
      status: 'ok', total: 5, idealStop: 10, freeAllowance: 10, missedFree: 5, missingPity: 5,
      actual: {stop: 5, pity: 5}, reference: {stop: 10, pity: 10, pityIsValuation: true},
      referencePitySource: 'early-stop-water-extension', reason, localLoss: 1.25,
      permanentDelta: 0, waterValueDelta: -1.25, rewardValueDelta: 0}]};
    h.ctx.loadSession(saved); await tick(); findButton(h.nodes.planningTopPools, '详情').click();
    assert(h.nodes.planningDetailDialog.open);
    const detail = h.nodes.planningDetailContent.textContent;
    assert(detail.includes('少积累水位')); assert(detail.includes('5 抽水位'));
    assert(detail.includes(reason)); assert(detail.includes('5 / 10 抽'));
    assert(detail.includes('永久投入差')); assert(detail.includes('水位价值差')); assert(detail.includes('赠券价值差'));
    assert.equal(h.pending.length, 0, 'detail display must not trigger OCR, simulation, or a new score');
  });
  await test('early node-stop details keep permanent water and reward net differences', async () => {
    const h = harness(); await tick(); const saved = record('early-node', [pool({total: 55, tail: 5})]);
    saved.result.planning = {version: planningVersion, pools: [{id: 'p0', banner: '熔火灼痕',
      status: 'ok', total: 55, idealStop: 60, freeAllowance: 10, missedFree: 0, missingPity: 5,
      anchor: {at: 50, source: 'main'}, actual: {stop: 55, pity: 5},
      reference: {stop: 60, pity: 10, pityIsValuation: true},
      referencePitySource: 'early-stop-water-extension',
      reason: '提前停手按永久抽、水位与60节点赠券的净差估值，并非实际补抽结果。',
      localLoss: 6.25, permanentDelta: -5, waterValueDelta: -1.25, rewardValueDelta: -10}]};
    h.ctx.loadSession(saved); await tick(); findButton(h.nodes.planningTopPools, '详情').click();
    const detail = h.nodes.planningDetailContent.textContent;
    assert(detail.includes('55 / 60 抽')); assert(detail.includes('少积累水位'));
    assert(detail.includes('永久抽、水位与60节点赠券的净差估值'));
    const rows = h.nodes.planningDetailContent.querySelector('dl').children;
    const values = Object.fromEntries(rows.filter((_, index) => index % 2 === 0)
      .map((node, index) => [node.textContent, rows[index * 2 + 1].textContent]));
    assert.equal(values['永久投入差'], '-5.00 抽');
    assert.equal(values['水位价值差'], '-1.25 抽');
    assert.equal(values['赠券价值差'], '-10.00 抽');
    assert(detail.includes('6.25 抽'), 'the detail must display the supplied net result, not just five missing water');
  });
  await test('free-hit detail explains why ideal stop is the free allowance not the hit',async()=>{
    const h=harness();await tick();const saved=record();
    saved.result.planning={version:planningVersion,pools:[{id:'p0',banner:'熔火灼痕',status:'ok',
      total:20,idealStop:20,freeAllowance:20,localLoss:0,stopRule:'complete-free-allowance',
      anchor:{at:5,source:'main'},actual:{stop:20,pity:15},reference:{stop:20,pity:15},
      permanentDelta:0,waterValueDelta:0,rewardValueDelta:0,opportunity:{status:'ok',value:0}}]};
    h.ctx.loadSession(saved);await tick();findButton(h.nodes.planning,'详情').click();
    const text=h.nodes.planningDetailContent.textContent;
    assert(text.includes('第5抽'));assert(text.includes('用完本池20抽免费额度'));
    assert(text.includes('20 / 20 抽'));
  });
  await test('character and weapon open independent editors with four accessible character pages',async()=>{
    const h=await loaded(),before=h.state();h.nodes.openResults.click();
    assert.equal(h.nodes.resultsDialogTitle.textContent,'限定池识别结果');assert(h.nodes.weaponResultsPanel.hidden);
    h.nodes.resultsCharacterTab.dispatchEvent({type:'keydown',key:'ArrowRight'});
    assert.equal(h.nodes.interruptionTab.getAttribute('aria-selected'),'true');assert(!h.nodes.interruptionReview.hidden);
    h.nodes.initialHistoryTab.click();assert(!h.nodes.initialHistory.hidden);
    h.nodes.initialHistoryTab.dispatchEvent({type:'keydown',key:'End'});
    assert(!h.nodes.summaryReview.hidden);assert(h.nodes.characterResultsPanel.hidden);
    escape(h.nodes.resultsDialog);h.nodes.weaponConfigured.click();
    assert.equal(h.nodes.resultsDialogTitle.textContent,'武器修正');
    assert(h.nodes.characterTabs.hidden);assert(!h.nodes.weaponResultsPanel.hidden);assert(h.nodes.characterResultsPanel.hidden);
    h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
  });
  await test('reopened history exposes both root and character-level input problems', async () => {
    const h = harness(); await tick(); const saved = record('history-issues');
    saved.ledger.issues = [{code: 'account_mismatch', severity: 'error', message: '来源账号存在冲突'}];
    saved.ledger.character.issues = [{code: 'incomplete_history', severity: 'error', message: '前史不完整不能推断期初水位'}];
    h.ctx.loadSession(saved); await tick(); h.nodes.openResults.click();
    assert(h.nodes.resultsDialog.open); assert(h.nodes.currentGlobalIssues.textContent.includes('来源账号存在冲突'));
    assert(h.nodes.currentGlobalIssues.textContent.includes('前史不完整不能推断期初水位'));
    assert.equal(h.pending.length, 0);
  });
  await test('history is a modal and choosing a saved record closes it', async () => {
    const h = await loaded(); h.replies.set('/api/sessions', [{id: 'saved-history', name: '测试本机历史', updatedAt: 1000, reviewed: true}]);
    await h.nodes.openHistory.click(); await tick(); assert(h.nodes.historyDialog.open);
    const historyButton = h.nodes.history.querySelectorAll('button').find(n => n.textContent.startsWith('测试本机历史'));
    assert(historyButton); const opening = historyButton.click();
    await tick(); const request = h.pending.find(p => p.url === '/api/sessions/saved-history'); assert(request);
    request.resolve(record('saved-history')); await opening; await tick();
    assert.equal(h.state().id, 'saved-history'); assert(!h.nodes.historyDialog.open);
  });
  await test('character dialog cancel discards edits without a request or revision change', async () => {
    const h = await loaded(), before = h.state();
    h.nodes.openResults.click(); assert(h.nodes.resultsDialog.open);
    setField(h.nodes.review, '武库配额', 5180);
    assert.deepEqual(h.state(), before, 'typing must touch only draft');
    h.nodes.resultsCancel.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.deepEqual(h.state(), before); assert.equal(h.pending.length, 0);
  });
  await test('character dialog Escape discards edits', async () => {
    const h = await loaded(), before = h.state();
    h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 5180);
    escape(h.nodes.resultsDialog); h.flushTimers(); await tick();
    assert.deepEqual(h.state(), before); assert.equal(h.pending.length, 0);
  });
  await test('character page switches preserve one character draft, cancel discards all its pages',async()=>{
    const h=await loaded(),before=h.state();h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5180);
    h.nodes.summaryTab.click();h.nodes.initialHistoryTab.click();h.nodes.resultsCharacterTab.click();
    assert.equal(Number(findField(h.nodes.review,'武库配额').value),5180);
    h.nodes.resultsCancel.click();h.nodes.openResults.click();assert.equal(Number(findField(h.nodes.review,'武库配额').value),5000);
    h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
  });
  await test('weapon saves independently of character conflicts and character data remains intact',async()=>{
    const h=await loaded(),saved=record();saved.ledger.character.pools[0].tail=99;h.ctx.loadSession(saved);h.nodes.resultsCancel.click();
    const before=h.state().ledger.character;assert(h.nodes.openResults.classList.contains('has-conflicts'));
    h.nodes.weaponConfigured.click();setField(h.nodes.weaponReview,'武器总抽数',70);
    h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert(!h.nodes.resultsDialog.open);assert.equal(h.pending.length,1);
    assert.deepEqual(h.state().ledger.character,before);assert.equal(h.state().ledger.weapon.N,70);
  });
  await test('character status uses scoped contradictions and ignores weapon-only errors',async()=>{
    const h=await loaded();assert(h.nodes.openResults.classList.contains('is-consistent'));
    const w=record();w.ledger.issues=[{code:'weapon-source',severity:'error',axes:['weaponSix','signature'],message:'武器汇总有误'}];
    h.ctx.loadSession(w);assert(h.nodes.openResults.classList.contains('is-consistent'));h.nodes.resultsCancel.click();
    const c=record();c.ledger.issues=[{code:'character_summary_mismatch',severity:'error',axes:['up'],message:'顶部数字冲突'}];
    h.ctx.loadSession(c);assert(h.nodes.openResults.classList.contains('has-conflicts'));
    assert(!h.nodes.summaryReview.hidden);
    h.ctx.loadSession(record());assert(!h.nodes.openResults.classList.contains('has-conflicts'));
  });
  await test('confirm empty rush sets a used batch, preserves main hits and timing, and cancels or saves',async()=>{
    const h=await loaded(),saved=record('rush-none',[pool({events:[{at:50,character:'莱万汀',source:'main',forced:false}],rushAt:37,rush:[{source:'rush',character:'余烬'}]})]);
    h.ctx.loadSession(saved);const before=h.state();h.nodes.openResults.click();findButton(h.nodes.review,'确认加急未出').click();
    assert.equal(h.read('characterDraft.pools[0].rush.length'),0);h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
    h.nodes.openResults.click();findButton(h.nodes.review,'确认加急未出').click();h.nodes.resultsApply.click();
    const p=h.state().ledger.character.pools[0];assert.equal(p.rush.length,0);assert.equal(p.rushAt,37);assert(p.rushUsed);
    assert.deepEqual(p.events,before.ledger.character.pools[0].events);
  });
  await test('a missing weapon value does not block saving only character edits', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('missing-weapon', [pool()], {N: 60, K6: 2, KU: null, B: null, H80: null})); await tick();
    h.nodes.resultsCancel.click();
    h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 5180);
    h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.pending.length, 1);
    assert.equal(h.state().ledger.character.pools[0].quota, 5180); assert.equal(h.state().ledger.weapon.KU, null);
  });
  await test('character apply commits once and preserves source provenance', async () => {
    const h = await loaded(), before = h.state();
    h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 5180);
    h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.state().ledger.character.pools[0].quota, 5180);
    assert.equal(h.pending.length, 1); assert.equal(h.pending[0].url, '/api/score');
    assert.equal(h.pending[0].body.session.revision, before.revision + 1);
    assert.deepEqual(h.pending[0].body.session.documents, before.documents);
    h.pending[0].resolve(h.pending[0].body.session); await tick();
    assert.equal(h.state().ledger.character.pools[0].quota, 5180);
  });
  await test('weapon button opens a visible numeric correction table without enabling it',async()=>{
    const h=await loaded(),before=h.state();h.nodes.weaponConfigured.click();
    assert(h.nodes.resultsDialog.open);assert.equal(findField(h.nodes.weaponReview,'潜能配置修正').checked,false);
    assert(h.nodes.weaponReview.querySelector('table'));assert(findField(h.nodes.weaponReview,'总专武种类'));
    assert(!h.nodes.weaponReview.textContent.includes('平均专武'));assert(!h.nodes.weaponReview.querySelectorAll('input').some(n=>n.type==='text'));
    h.nodes.resultsCancel.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
  });
  await test('weapon Escape discards edited potential and lost draws',async()=>{
    const h=await loaded(),before=h.state();h.nodes.weaponConfigured.click();
    setField(h.nodes.weaponReview,'总专武种类',1);setField(h.nodes.weaponReview,'亏损抽数',3);
    assert(findField(h.nodes.weaponReview,'潜能配置修正').checked);escape(h.nodes.resultsDialog);
    h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
  });
  await test('empty potential configuration blocks save and a filled zero-potential table saves',async()=>{
    const h=await loaded();openProfileWeapon(h);h.nodes.resultsApply.click();assert(h.nodes.resultsDialog.open);
    setField(h.nodes.weaponReview,'总专武种类',1);h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert(!h.nodes.resultsDialog.open);assert.equal(h.pending.length,1);const w=h.pending[0].body.session.ledger.weapon;
    assert.deepEqual(w.potentialConfig,{totalTypes:1,counts:[0,0,0,0,0],overflowCopies:0});assert.equal(w.profile,null);
  });
  await test('multiple full weapons save only after overflow allocations add up, then reopen exactly',async()=>{
    const h=await loaded();h.ctx.loadSession(record('table-overflow',[pool()],{N:1100,K6:50,KU:14}));
    h.nodes.weaponConfigured.click();const view=h.nodes.weaponReview;
    setField(view,'总专武种类',2);setField(view,'5潜专武数量',2);setField(view,'溢出专武数量',3);
    setField(view,'满潜专武1溢出份数',2);h.nodes.resultsApply.click();assert(h.nodes.resultsDialog.open);
    assert(h.nodes.weaponDialogError.textContent.includes('溢出份数'));
    setField(view,'满潜专武2溢出份数',1);setField(view,'亏损抽数',17);h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert(!h.nodes.resultsDialog.open);const sent=h.pending[h.pending.length-1].body.session;
    assert.deepEqual(sent.ledger.weapon.potentialConfig,{totalTypes:2,counts:[0,0,0,0,2],overflowCopies:3,overflowByType:[2,1]});
    assert.equal(sent.ledger.weapon.lossDraws,17);h.pending[h.pending.length-1].resolve(sent);await tick();h.ctx.loadSession(sent);await tick();
    h.nodes.weaponConfigured.click();assert.equal(findField(view,'满潜专武1溢出份数').value,2);assert.equal(findField(view,'满潜专武2溢出份数').value,1);
  });
  await test('raw weapon corrections do not enable potential mode',async()=>{
    const h=await loaded();h.nodes.weaponConfigured.click();setField(h.nodes.weaponReview,'武器总抽数',70);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert(!h.nodes.resultsDialog.open);
    assert.equal(weaponButtonActive(h),false);assert.equal(h.state().ledger.weapon.N,70);
  });
  await test('old B/H80 and profile survive opening, and disabling clears only the potential selection',async()=>{
    const h=await loaded(),saved=record('legacy',[pool()],{N:60,K6:2,KU:1,B:1,H80:0,profile:'1'});
    h.ctx.loadSession(saved);await tick();h.nodes.weaponConfigured.click();assert.equal(findField(h.nodes.weaponReview,'总专武种类').value,1);
    const toggle=findField(h.nodes.weaponReview,'潜能配置修正');assert(toggle.checked);toggle.checked=false;toggle.onchange();
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.state().ledger.weapon.profile,null);
    assert.equal(h.state().ledger.weapon.H80,0);assert.equal(h.state().ledger.weapon.B,1);assert.equal(weaponButtonActive(h),false);
  });
  await test('optional lost draws reject impossible values and may be used without a potential table',async()=>{
    const h=await loaded(),before=h.state();h.nodes.weaponConfigured.click();setField(h.nodes.weaponReview,'亏损抽数',60);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert(h.nodes.resultsDialog.open);assert.deepEqual(h.state(),before);
    setField(h.nodes.weaponReview,'亏损抽数',11);h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.state().ledger.weapon.lossDraws,11);assert.equal(h.state().ledger.weapon.profile,null);
    assert.equal(weaponButtonActive(h),true);assert.equal(h.pending.length,1);
  });
  await test('weapon results show pool rows and genuine errors in the independent weapon editor',async()=>{
    const h=await loaded(),saved=record('weapon-details',[pool()],{N:60,K6:2,KU:1,profile:'1',
      sections:[{banner:'雷鸣申领',total:20,eventsNewestFirst:[{weapon:'楔子',isUp:false}]}],
      issues:[{code:'source_conflict',severity:'error',message:'武器来源数量冲突'}]});
    h.ctx.loadSession(saved);await tick();assert.equal(h.read('autoReviewQueue[0].type'),'weapon');
    assert(h.nodes.weaponReview.textContent.includes('雷鸣申领'));assert(h.nodes.weaponReview.textContent.includes('楔子'));
    assert(h.nodes.weaponReview.textContent.includes('武器来源数量冲突'));
  });
  await test('planning score displays net loss directly rather than subtracting it from 120', async () => {
    const h = harness(); await tick(); const saved = record();
    saved.result.planning = {pools: [{id: 'p0', banner: '熔火灼痕', status: 'ok', localLoss: 150,
      total: 60, idealStop: 20, actual: {stop: 60}, permanentDelta: 150, waterValueDelta: 0, rewardValueDelta: 0}]};
    h.ctx.loadSession(saved); await tick();
    assert(h.nodes.planningHighlights.textContent.includes('150.00'));
    assert(!h.nodes.planningHighlights.textContent.includes('-30.00'));
    assert(!h.nodes.planningHighlights.textContent.includes('120 −'));
    saved.result.planning.pools.push({id: 'p1', banner: '待确认池', status: 'partial', localLoss: null});
    h.ctx.loadSession(saved); await tick();
    assert(h.nodes.planningHighlights.textContent.includes('已算 1/2 池 · 数据不完整'));
    assert.equal(h.nodes.planningHighlights.querySelectorAll('.rating-title').length, 0,
      'partial loss must not get a complete planning title');
  });
  await test('planning details include the exact saved pool crop without requesting new OCR', async () => {
    const h = harness(); await tick(); const crop = '/data/fixture/planning-pool.png';
    const saved = record('planning-image', [pool({evidence: {crop, sourceImage: '/data/fixture/source.png'}})]);
    saved.result.planning = {pools: [{id: 'p0', banner: '熔火灼痕', status: 'ok', localLoss: 10,
      total: 60, idealStop: 50, actual: {stop: 60}, permanentDelta: 10, waterValueDelta: 0, rewardValueDelta: 0}]};
    h.ctx.loadSession(saved); await tick(); findButton(h.nodes.planningTopPools, '详情').click();
    assert(h.nodes.planningDetailDialog.open);
    const image = h.nodes.planningDetailContent.querySelector('img'); assert(image); assert.equal(image.src, crop);
    assert.equal(h.pending.length, 0); assert.equal(h.requests.filter(r => r.url === '/api/import').length, 0);
  });
  await test('missing or invalid five-star data does not suppress the five-axis title or remove its radar axis', async () => {
    const h = harness(); await tick();
    for (const missing of [undefined, null, {score: null, status: 'invalid'}, {score: 'bad', status: 'invalid'}]) {
      const saved = record('five-star-missing');
      saved.result.axes = scoredAxes({characterSix: 80, up: 20, limited: 80, weaponSix: 80, signature: 50});
      if (missing === undefined) delete saved.result.axes.five; else saved.result.axes.five = missing;
      saved.result.scoredAxes = 5;
      h.ctx.loadSession(saved); await tick();
      assert.equal(h.nodes.luckTitle.textContent, '歪中藏金·百兵来朝');
      assert.equal(radarScore(h.nodes.radar, '角色五星'), '—');
      assert.equal(h.nodes.radar.querySelectorAll('circle').length, 5);
      assert.equal(h.nodes.radar.querySelectorAll('text').filter(n => n.textContent === '角色五星').length, 1);
      assert(h.nodes.luckContent.classList.contains('concealed'));
      h.nodes.revealLuck.click(); assert(!h.nodes.luckContent.classList.contains('concealed'));
      assert.equal(h.nodes.luckTitle.textContent, '歪中藏金·百兵来朝');
    }
    assert.equal(h.pending.length, 0, 'presentation-only title rendering must not score or recognize again');
  });
  await test('changing only the five-star score changes the radar but never the title or other scores', async () => {
    const h = harness(); await tick(); const saved = record('five-star-independent');
    saved.result.axes = scoredAxes({characterSix: 80, up: 20, limited: 20, five: 0, weaponSix: 50, signature: 80});
    const expectedOtherAxes = Object.fromEntries(Object.entries(saved.result.axes).filter(([key]) => key !== 'five'));
    for (const score of [0, 10, 30, 50, 70, 90, 100]) {
      saved.result.axes.five.score = score;
      h.ctx.loadSession(saved); await tick();
      assert.equal(h.nodes.luckTitle.textContent, '常驻收藏家·专武眷顾');
      assert.equal(radarScore(h.nodes.radar, '角色五星'), score.toFixed(1));
      assert.deepEqual(Object.fromEntries(Object.entries(h.state().result.axes).filter(([key]) => key !== 'five')), expectedOtherAxes);
      assert.equal(h.nodes.radar.querySelectorAll('circle').length, 6);
    }
    assert.equal(h.pending.length, 0);
  });
  await test('every participating title axis is required and no missing axis is replaced with a neutral score', async () => {
    const h = harness(); await tick();
    for (const key of ['characterSix', 'up', 'limited', 'weaponSix', 'signature']) {
      for (const mode of ['missing', 'invalid']) {
        const saved = record('required-' + key + '-' + mode); saved.result.axes = scoredAxes();
        if (mode === 'missing') delete saved.result.axes[key];
        else saved.result.axes[key] = {score: null, status: 'invalid'};
        h.ctx.loadSession(saved); await tick();
        assert.equal(h.nodes.luckTitle.textContent, '数据不足', key + ' must participate');
        assert.equal(h.nodes.radar.querySelectorAll('circle').length, 5);
        assert.equal(h.nodes.radar.querySelectorAll('text').filter(n => n.textContent === '—').length, 1);
        assert.equal(radarScore(h.nodes.radar, '角色五星'), '50.0');
      }
    }
    assert.equal(h.pending.length, 0);
  });
  await test('full source renders the selected character and weapon combination rather than the old highest-axis title', async () => {
    const h = harness(); await tick();
    for (const [values, expected] of [
      [[80, 20, 80, 80, 50], '歪中藏金·百兵来朝'],
      [[80, 50, 50, 80, 20], '金光满地·满库寻本命'],
      [[20, 20, 20, 80, 80], '人才凋零·武库鼎盛'],
      [[80, 80, 80, 20, 20], '天命所归·武库荒年'],
      [[20, 50, 80, 20, 80], '沙里淘珍·神兵独秀'],
      [[50, 50, 50, 50, 50], '星途平常·兵运平平'],
    ]) {
      const saved = record('combined-title');
      saved.result.axes = scoredAxes(Object.fromEntries(['characterSix', 'up', 'limited', 'weaponSix', 'signature'].map((key, index) => [key, values[index]])));
      const snapshot = structuredClone(saved.result.axes);
      h.ctx.loadSession(saved); await tick();
      assert.equal(h.nodes.luckTitle.textContent, expected);
      assert(!h.nodes.luckTitle.title, 'luck title should not show a hover tooltip');
      assert.deepEqual(h.state().result.axes, snapshot, 'naming must not rewrite the scored axes');
    }
    assert.equal(h.pending.length, 0);
  });
  await test('extreme character and weapon contrast renders both strengthened halves', async () => {
    const h = harness(); await tick();
    for (const [character, weapon, expected] of [[90, 10, '群星俯首·寸铁难求'], [10, 90, '命途多舛·神兵天授']]) {
      const saved = record('extreme-contrast');
      saved.result.axes = scoredAxes({characterSix: character, up: character, limited: character, weaponSix: weapon, signature: weapon});
      h.ctx.loadSession(saved); await tick();
      assert.equal(h.nodes.luckTitle.textContent, expected);
      assert(h.nodes.luckContent.classList.contains('concealed'));
      h.nodes.revealLuck.click(); assert.equal(h.nodes.luckTitle.textContent, expected);
      assert.equal(h.nodes.exportRadar.disabled, false);
    }
  });
  await test('overall exclusive titles use only the five participating scores', async () => {
    const h = harness(); await tick();
    for (const [value, expected] of [[90, '点石成金至尊欧皇'], [70, '宗师级欧皇'], [30, '非入骨髓'], [10, '面目全非']]) {
      const saved = record('overall-exclusive');
      saved.result.axes = scoredAxes(Object.fromEntries(['characterSix', 'up', 'limited', 'weaponSix', 'signature'].map(key => [key, value])));
      saved.result.axes.five.score = value >= 70 ? 0 : 100;
      h.ctx.loadSession(saved); await tick();
      assert.equal(h.nodes.luckTitle.textContent, expected);
      assert.equal(radarScore(h.nodes.radar, '角色五星'), value >= 70 ? '0.0' : '100.0');
    }
  });
  await test('luck is concealed after every result, reveal unlocks export, recalculation conceals it again', async () => {
    const h = harness(); await tick(); const saved = record('conceal');
    saved.result.axes = Object.fromEntries(['characterSix', 'up', 'limited', 'five', 'weaponSix', 'signature'].map(k => [k, {score: 75}]));
    saved.result.scoredAxes = 6; h.ctx.loadSession(saved); await tick();
    assert.equal(h.nodes.luckTitle.textContent, '宗师级欧皇');
    const concealed = () => {
      assert(h.nodes.luckContent.classList.contains('concealed'));
      assert.equal(h.nodes.luckContent.inert, true); assert.equal(h.nodes.luckContent.getAttribute('aria-hidden'), 'true');
      assert.equal(h.nodes.revealLuck.hidden, false); assert.equal(h.nodes.exportRadar.disabled, true);
    };
    concealed(); h.nodes.revealLuck.click();
    assert(!h.nodes.luckContent.classList.contains('concealed')); assert.equal(h.nodes.luckContent.inert, false);
    assert.notEqual(h.nodes.luckContent.getAttribute('aria-hidden'), 'true');
    assert.equal(h.nodes.revealLuck.hidden, true); assert.equal(h.nodes.exportRadar.disabled, false);
    h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 5180); h.nodes.resultsApply.click();
    h.flushTimers(); await tick(); assert.equal(h.nodes.exportRadar.disabled, true);
    assert.equal(h.pending.length, 1); h.pending[0].resolve(h.pending[0].body.session); await tick(); concealed();
    h.nodes.revealLuck.click(); assert.equal(h.nodes.exportRadar.disabled, false);
    h.ctx.loadSession({...h.state(), id: 'different-record'}); await tick(); concealed();
  });
  await test('switching records discards open character draft', async () => {
    const h = await loaded(); h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 5180);
    h.ctx.loadSession(record('B')); await tick();
    assert(!h.nodes.resultsDialog.open); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert.equal(h.state().id, 'B'); assert.equal(h.state().ledger.character.pools[0].quota, 5000); assert.equal(h.pending.length, 0);
  });
  await test('default migration materializes only absent values, retaining explicit decisions', async () => {
    const h = harness(); await tick();
    const explicit = record('explicit', [pool({ended: false, rushAt: 42})]);
    assert.equal(h.ctx.applyConfirmedDefaults(explicit), false);
    assert.equal(explicit.ledger.character.pools[0].ended, false); assert.equal(explicit.ledger.character.pools[0].rushAt, 42);
    const invalid = record('invalid', [pool({rushAt: ''})]);
    assert.equal(h.ctx.applyConfirmedDefaults(invalid), false); assert.equal(invalid.ledger.character.pools[0].rushAt, '');
    const unused = record('unused', [pool({rushUsed: false, rushAt: null}), pool({id: 'p1', rushUsed: null, rushAt: null})]);
    assert.equal(h.ctx.applyConfirmedDefaults(unused), false); assert.equal(unused.ledger.character.pools[0].rushAt, null);
  });
  await test('default rush timing is never inserted below unlock or for unknown total', async () => {
    const h = harness(); await tick();
    for (const total of [0, 20, 29, 29.5, null, undefined, '60']) {
      const saved = record('invalid-total', [pool({total, rushUsed: true, rushAt: null})]);
      assert.equal(h.ctx.applyConfirmedDefaults(saved), false, 'must not fabricate timing for total=' + total);
      assert.equal(saved.ledger.character.pools[0].rushAt, null);
    }
    const valid = record('unlock', [pool({total: 30, rushUsed: true, rushAt: null})]);
    assert.equal(h.ctx.applyConfirmedDefaults(valid), true);
    assert.equal(valid.ledger.character.pools[0].rushAt, 30);
  });
  await test('a pool lacking its guaranteed UP by 120 is rejected rather than relabelled as forced', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('off120', [pool({total: 120, tail: 0, quota: 6920, events: [
      {at: 50, character: '骏卫', source: 'main'},
      {at: 120, character: '余烬', source: 'main', forced: true},
    ]})]));
    const before = h.state(); h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 7100); h.nodes.resultsApply.click();
    assert(h.nodes.resultsDialog.open); assert.deepEqual(h.state(), before);
    assert(h.nodes.characterDialogError.textContent.includes('第120抽尚未取得主池UP'));
  });
  await test('character review marks first main UP at 120 as forced', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('up120', [pool({total: 120, tail: 0, quota: 6920, events: [
      {at: 50, character: '骏卫', source: 'main'},
      {at: 120, character: '莱万汀', source: 'main', forced: false},
    ]})]));
    h.nodes.openResults.click(); setField(h.nodes.review, '武库配额', 7100); h.nodes.resultsApply.click();
    assert.equal(h.state().ledger.character.pools[0].events[1].forced, true);
  });
  await test('import opens erroneous pools in index order and commits each separately', async () => {
    const h = harness(); await tick();
    const saved = record('queue', [erroneousPool('later', 2), erroneousPool('first', 0), pool({id: 'clean', index: 1,initialPity:10})]);
    h.ctx.loadSession(saved, {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert(h.nodes.review.textContent.includes('测试卡池0'));
    assert(!h.nodes.review.textContent.includes('测试卡池2'), 'one erroneous pool at a time');
    assert.equal(h.pending.length, 0);
    setField(h.nodes.review, '武库配额', 5180); assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); await tick();
    assert(h.nodes.resultsDialog.open); assert(h.nodes.review.textContent.includes('测试卡池2'));
    assert.equal(h.state().ledger.character.pools.find(p => p.id === 'first').quota, 5180);
    h.flushTimers(); await tick(); assert.equal(h.pending.length, 0, 'intermediate confirmations must not start a score');
    assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.pending.filter(p => p.url === '/api/score').length, 1);
    assert.equal(h.state().ledger.character.pools.filter(p => p.issues.some(i => i.severity === 'error')).length, 2,
      'saving must not silence unknown evidence errors without server revalidation');
    for (const item of h.state().ledger.character.pools.filter(p => p.id !== 'clean')) {
      assert.equal(item.issues[0].severity, 'error');
      assert.equal(item.issues[0].resolution, undefined);
      assert.equal(item.eventReviewConfirmed, true);
    }
  });
  await test('import queue refuses structurally invalid data and does not advance', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-invalid', [erroneousPool('first', 0, {quota: null}), erroneousPool('second', 1)]), {reviewImport: true});
    await tick(); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(h.nodes.resultsDialog.open); assert(h.nodes.review.textContent.includes('测试卡池0'));
    assert(h.nodes.characterDialogError.textContent.length > 0); assert.equal(h.pending.length, 0);
  });
  await test('the queued pool review displays the saved original pool crop', async () => {
    const h = harness(); await tick();
    const crop = '/data/fixture/review-pool-0.png';
    h.ctx.loadSession(record('queue-crop', [erroneousPool('first', 0, {
      evidence: {crop, sourceImage: '/data/fixture/source.png', box: [0, 500, 1000, 1600], sourceSize: [1000, 3000]},
    })]), {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.nodes.characterEvidence.hidden, false);
    const image = h.nodes.characterEvidence.querySelector('img'); assert(image); assert.equal(image.src, crop);
    assert.equal(h.nodes.review.querySelectorAll('.pool').length, 1);
  });
  await test('cancelling a later queued pool keeps prior commits and discards the current draft', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-cancel', [erroneousPool('first', 0), erroneousPool('second', 1)]), {reviewImport: true}); await tick();
    setField(h.nodes.review, '武库配额', 5180); assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); await tick();
    setField(h.nodes.review, '武库配额', 5540); escape(h.nodes.resultsDialog); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open);
    assert.equal(h.state().ledger.character.pools[0].quota, 5180); assert.equal(h.state().ledger.character.pools[1].quota, 5000);
    assert.equal(h.pending.filter(p => p.url === '/api/score').length, 1);
    h.pending[0].resolve(h.pending[0].body.session); await tick();
    assert(!h.nodes.resultsDialog.open, 'a recalculation must not reopen a cancelled queue');
    h.nodes.openResults.click(); assert(h.nodes.resultsDialog.open);
    assert(h.nodes.review.textContent.includes('测试卡池0')); assert(h.nodes.review.textContent.includes('测试卡池1'));
  });
  await test('cancelling the first queued pool makes no record edits or score request', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-first-cancel', [erroneousPool('first', 0)]), {reviewImport: true}); await tick();
    const before = h.state(); setField(h.nodes.review, '武库配额', 5180);
    h.nodes.resultsCancel.click(); h.flushTimers(); await tick();
    assert.deepEqual(h.state(), before); assert(!h.nodes.resultsDialog.open); assert.equal(h.pending.length, 0);
  });
  await test('warnings alone do not start the forced import review queue', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('warnings', [pool({issues: [{code: 'fixture_warning', severity: 'warning', message: '提示而非识别错误'}]})]), {reviewImport: true});
    await tick(); assert(!h.nodes.resultsDialog.open); assert.equal(h.pending.length, 0);
  });
  await test('missing required pool data opens import review even without an OCR error flag', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('missing-total', [pool({total: null, rushUsed: false, rushAt: null})]), {reviewImport: true});
    await tick(); assert(h.nodes.resultsDialog.open); assert.equal(h.pending.length, 0);
    h.nodes.resultsApply.click(); assert(h.nodes.resultsDialog.open); assert(h.nodes.characterDialogError.textContent.length > 0);
  });
  await test('default migration waits for the import review queue before recalculation', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-defaults', [erroneousPool('first', 0, {ended: undefined, rushAt: null})]), {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.pending.length, 0);
    assert.equal(h.state().ledger.character.pools[0].rushAt, 30); assert.equal(h.state().ledger.character.pools[0].ended, true);
    assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert.equal(h.pending.filter(p => p.url === '/api/score').length, 1);
  });
  await test('first-step cancellation still scores already-applied default migration exactly once', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-default-cancel', [erroneousPool('first', 0, {ended: undefined, rushAt: null})]), {reviewImport: true}); await tick();
    setField(h.nodes.review, '武库配额', 5180); h.nodes.resultsCancel.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.state().ledger.character.pools[0].quota, 5000);
    assert.equal(h.state().ledger.character.pools[0].rushAt, 30); assert.equal(h.state().ledger.character.pools[0].ended, true);
    assert.equal(h.pending.filter(p => p.url === '/api/score').length, 1);
    assert.equal(h.pending[0].body.session.ledger.character.pools[0].issues[0].severity, 'error');
  });
  await test('cancelling an imported anomaly queue still migrates old planning exactly once', async () => {
    const h = harness({planningVersion}); await tick();
    const saved = record('queue-old-version-cancel', [erroneousPool('first', 0)]);
    saved.result.planning.version = 'planning-local-table-v1.4-early-stop-water';
    h.ctx.loadSession(saved, {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.pending.length, 0, 'migration waits for the anomaly queue');
    setField(h.nodes.review, '武库配额', 5180);
    h.nodes.resultsCancel.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.pending.length, 1);
    const sent = h.pending[0].body.session;
    assert.equal(sent.ledger.character.pools[0].quota, 5000, 'cancelled draft must not be committed');
    assert.equal(sent.ledger.character.pools[0].issues[0].severity, 'error', 'cancellation does not acknowledge input errors');
    assert.equal(h.nodes.planningBreakdown.hidden, true, 'retired cache must not be redisplayed during migration');
    const response = structuredClone(sent); response.result.planning.version = planningVersion;
    h.pending[0].resolve(response); await tick();
    assert.equal(h.state().result.planning.version, planningVersion);
    h.ctx.loadSession(h.state()); h.flushTimers(); await tick();
    assert.equal(h.pending.length, 1, 'cancelled queue migration must converge after its single score response');
  });
  await test('partial history opens without an error queue and old character cache recalculates once',async()=>{
    const version='character-ledger-v1-20261014-partial-window';
    const h=harness({characterVersion:version});await tick();
    const saved=record('partial-cache',[pool({index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',forced:false,source:'main'}]})]);
    saved.ledger.character.completeHistory=false;saved.ledger.character.initialPity=null;saved.ledger.character.initialOwned=null;
    saved.ledger.character.firstPoolHistory={poolId:'p0',isFirstPool:false};
    saved.ledger.character.issues=[{code:'incomplete_history',severity:'error',message:'old blanket error'}];
    saved.result.character={version:'old-version'};
    h.ctx.loadSession(saved,{reviewImport:true});await tick();
    assert(!h.nodes.resultsDialog.open);assert.equal(h.pending.length,1);
    const sent=h.pending[0].body.session;
    assert.equal(sent.ledger.character.issues[0].severity,'warning');
    assert.equal(sent.ledger.character.initialPity,null);
    const response=structuredClone(sent);response.result.character.version=version;
    h.pending[0].resolve(response);await tick();h.ctx.loadSession(h.state());await tick();
    assert.equal(h.pending.length,1,'current character version must converge without repeated scoring');
    assert.equal(h.read('validateEditedPool(session.ledger.character.pools[0])'),'');
  });
  await test('newly confirmed rush use finishes status after score-time default migration', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-new-rush', [erroneousPool('first', 0, {rushUsed: null, rushAt: null})]), {reviewImport: true}); await tick();
    setField(h.nodes.review, '加急使用状态', 'true'); assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert.equal(h.pending.length, 1); assert.equal(h.pending[0].body.session.ledger.character.pools[0].rushAt, 30);
    const response=structuredClone(h.pending[0].body.session);response.ledger.character.pools[0].issues=[];
    h.pending[0].resolve(response); await tick();
    assert(h.nodes.status.textContent.includes('计算完成'), JSON.stringify({
      status: h.nodes.status.textContent, calculatingHidden: h.nodes.calculating.hidden,
      revision: h.state().revision, queue: h.read('JSON.stringify(gatherReviewQueue())'),
    }));
    assert(!h.nodes.status.classList.contains('is-running'));
  });
  await test('global-source issue dialog shows originals and closing never downgrades its errors', async () => {
    const h = harness(); await tick(); const saved = record('global-issues');
    saved.ledger.issues = [{code: 'account_mismatch', severity: 'error', message: '来源账号存在冲突'}];
    saved.ledger.character.issues = [{code: 'incomplete_history', severity: 'error', message: '前史不完整不能推断期初水位'}];
    h.ctx.loadSession(saved, {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.nodes.characterResultsPanel.hidden, false);
    assert(h.nodes.currentGlobalIssues.textContent.includes('来源账号存在冲突'));
    assert(h.nodes.currentGlobalIssues.textContent.includes('前史不完整不能推断期初水位'));
    assert.equal(h.nodes.characterEvidence.querySelector('img').src, '/data/fixture/source.png');
    assertNoManualAcknowledgement(h.nodes.currentGlobalIssues);
    const before = h.state();
    h.nodes.resultsCancel.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.deepEqual(h.state(), before); assert.equal(h.pending.length, 0);
    assert(!h.nodes.status.textContent.includes('核对'));
  });
  await test('weapon anomalies follow pool anomalies and keep precision disabled unless requested', async () => {
    const h = harness(); await tick();
    const saved = record('queue-weapon', [erroneousPool('first', 0)], {N: 60, K6: 2, KU: null, B: null, H80: null,
      issues: [{code: 'fixture_weapon_error', severity: 'error', message: '核对专武数量'}]});
    h.ctx.loadSession(saved, {reviewImport: true}); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.nodes.characterResultsPanel.hidden, false);
    assertNoManualAcknowledgement(h.nodes.review); h.nodes.resultsApply.click(); await tick();
    assert(h.nodes.resultsDialog.open); assert.equal(h.nodes.weaponResultsPanel.hidden, false); assert.equal(h.pending.length, 0);
    setField(h.nodes.weaponReview, '当期专武数', 1); assertNoManualAcknowledgement(h.nodes.weaponReview);
    h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.state().ledger.weapon.KU, 1);
    assert.equal(h.state().ledger.weapon.H80, null); assert.equal(weaponButtonActive(h), false);
    assert.equal(h.pending.filter(p => p.url === '/api/score').length, 1);
  });
  await test('opening another record aborts the old import queue', async () => {
    const h = harness(); await tick();
    h.ctx.loadSession(record('queue-A', [erroneousPool('first', 0), erroneousPool('second', 1)]), {reviewImport: true}); await tick();
    setField(h.nodes.review, '武库配额', 5180);
    h.ctx.loadSession(record('B')); await tick(); h.nodes.resultsApply.click(); h.flushTimers(); await tick();
    assert(!h.nodes.resultsDialog.open); assert.equal(h.state().id, 'B');
    assert.equal(h.state().ledger.character.pools[0].quota, 5000); assert.equal(h.pending.length, 0);
  });
  await test('the import button enters the immediate anomaly-review flow on job completion', async () => {
    const h = harness(); await tick();
    h.replies.set('/api/import', {id: 'fixture-job'});
    h.replies.set('/api/jobs/fixture-job', {status: 'done', message: '完成', session: record('imported', [erroneousPool('first', 0)])});
    h.ctx.selected([{name: 'fixture.png', size: 10, data: 'fake-fixture-bytes'}]);
    await h.nodes.import.click(); await tick();
    assert.equal(h.state().id, 'imported'); assert(h.nodes.resultsDialog.open);
    assert.equal(h.requests.filter(r => r.url === '/api/import').length, 1);
    assert.equal(h.pending.filter(p => p.url === '/api/score').length, 0);
  });
  await test('old asynchronous response cannot replace a newly opened record', async () => {
    const h = harness(); await tick();
    const first = h.ctx.loadSession(record('A', [pool({ended: undefined, rushAt: null})])); await tick();
    assert.equal(h.pending.length, 1); assert.equal(h.pending[0].body.session.revision, 2);
    assert.equal(h.pending[0].body.session.ledger.character.pools[0].ended, true);
    assert.equal(h.pending[0].body.session.ledger.character.pools[0].rushAt, 30);
    const second = h.ctx.loadSession(record('B', [pool({ended: undefined, rushAt: null})])); await tick();
    assert.equal(h.pending.length, 2);
    h.pending[0].resolve(h.pending[0].body.session); await first; await tick(); assert.equal(h.state().id, 'B');
    h.pending[1].resolve(h.pending[1].body.session); await second; await tick(); assert.equal(h.state().id, 'B');
    h.ctx.loadSession(h.state()); await tick(); assert.equal(h.pending.length, 2, 'applied defaults must not loop');
  });
  await test('server planning version invalidates obsolete and unversioned cache exactly once', async () => {
    for (const oldVersion of [undefined, 'planning-local-table-v1.3-direct-loss','planning-local-table-v2.0-dual-metrics-20261015']) {
      const h = harness({planningVersion}); await tick();
      assert.equal(h.read('planningVersion'), planningVersion, 'config must establish the expected planning version');
      const saved = record('versioned');
      if (oldVersion !== undefined) saved.result.planning.version = oldVersion;
      const loading = h.ctx.loadSession(saved); await tick();
      assert.equal(h.pending.length, 1); assert.equal(h.pending[0].url, '/api/score');
      assert.equal(h.nodes.planningBreakdown.hidden, true, 'retired planning must stay hidden while being recalculated');
      const response = structuredClone(h.pending[0].body.session);
      response.result.planning.version = planningVersion;
      h.pending[0].resolve(response); await loading; await tick();
      h.ctx.loadSession(h.state()); h.flushTimers(); await tick();
      assert.equal(h.pending.length, 1, 'newly saved current-version cache must not be repeatedly rescored');
      assert.equal(h.state().result.planning.version, planningVersion);
    }
  });
  await test('recognition validation version rescans edited ledger once without repeating OCR or changing source evidence', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    for(const oldVersion of [undefined,'old-raw-summary-validation']){
      const h=harness({recognitionVersion});await tick();
      assert.equal(h.read('recognitionVersion'),recognitionVersion);
      const saved=record('manually-corrected',[pool({events:[
        {at:20,character:'莱万汀',source:'main'},{at:50,character:'艾尔黛拉',source:'main'}]})]);
      if(oldVersion!==undefined)saved.recognitionVersion=oldVersion;
      saved.documents[0].pools=[{banner:'熔火灼痕',events:[{pulls:30,character:'莱万汀'}]}];
      saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'旧识别只算到0次歪'}];
      const source=structuredClone(saved.documents),loading=h.ctx.loadSession(saved);await tick();
      assert.equal(h.pending.length,1);assert.equal(h.pending[0].url,'/api/score');
      const response=structuredClone(h.pending[0].body.session);
      assert.deepEqual(response.documents,source);
      assert.equal(response.ledger.character.pools[0].events[1].character,'艾尔黛拉');
      assert.equal(h.nodes.resultsDialog.open,false);
      response.ledger.issues=[];response.recognitionVersion=recognitionVersion;
      h.pending[0].resolve(response);await loading;await tick();
      h.ctx.loadSession(h.state());h.flushTimers();await tick();
      assert.equal(h.pending.length,1,'successful validation version must converge');
      assert.equal(h.state().recognitionVersion,recognitionVersion);
      assert.deepEqual(h.state().documents,source);
      assert.equal(h.requests.filter(r=>r.url==='/api/import'||r.url.startsWith('/api/jobs/')).length,0);
      assert.equal(h.requests.filter(r=>r.url==='/api/score').length,1,'only the opened record is updated');
    }
  });
  await test('obsolete recognition errors are revalidated before the import review queue is shown', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    const h=harness({recognitionVersion});await tick();const saved=record('stale-root-error');
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'旧汇总错误'}];
    const loading=h.ctx.loadSession(saved,{reviewImport:true});await tick();
    assert.equal(h.pending.length,1);assert.equal(h.nodes.resultsDialog.open,false);
    assert.equal(h.read('autoReviewQueue.length'),0);
    const response=structuredClone(h.pending[0].body.session);
    response.recognitionVersion=recognitionVersion;response.ledger.issues=[];
    h.pending[0].resolve(response);await loading;await tick();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.read('autoReviewQueue.length'),0);
  });
  await test('real conflicts remaining after recognition migration still enter the import review queue', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    const h=harness({recognitionVersion});await tick();const saved=record('real-root-conflict');
    saved.ledger.issues=[{code:'account_mismatch',severity:'error',message:'不同账号不能合并'}];
    const loading=h.ctx.loadSession(saved,{reviewImport:true});await tick();
    assert.equal(h.nodes.resultsDialog.open,false);
    const response=structuredClone(h.pending[0].body.session);response.recognitionVersion=recognitionVersion;
    h.pending[0].resolve(response);await loading;await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[0].type'),'info');
    assert(h.nodes.characterEvidence.textContent.includes('不同账号不能合并'));
  });
  await test('current recognition validation version does not suppress a new import error or force rescoring', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    const h=harness({recognitionVersion});await tick();const saved=record('current-validation');
    saved.recognitionVersion=recognitionVersion;
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'当前确实不符'}];
    h.ctx.loadSession(saved,{reviewImport:true});await tick();
    assert.equal(h.pending.length,0);assert.equal(h.nodes.resultsDialog.open,true);
    assert(h.nodes.characterEvidence.textContent.includes('当前确实不符'));
  });
  await test('late recognition migration cannot overwrite a different opened record or open its stale review queue', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    const h=harness({recognitionVersion});await tick();const old=record('old-validation-A');
    old.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'记录A的问题'}];
    const loading=h.ctx.loadSession(old,{reviewImport:true});await tick();
    const current=record('current-validation-B');current.recognitionVersion=recognitionVersion;
    h.ctx.loadSession(current);await tick();const before=h.state();
    const response=structuredClone(h.pending[0].body.session);response.recognitionVersion=recognitionVersion;
    h.pending[0].resolve(response);await loading;await tick();
    assert.deepEqual(h.state(),before);assert.equal(h.pending.length,1);
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.read('autoReviewQueue.length'),0);
  });
  await test('failed recognition migration stays stale and does not claim a cleared summary', async () => {
    const recognitionVersion='reviewed-character-summary-v1-20261022';
    const h=harness({recognitionVersion});await tick();const saved=record('failed-validation');
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'尚未重校验'}];
    const loading=h.ctx.loadSession(saved,{reviewImport:true});await tick();
    h.pending[0].reject(Error('测试请求失败'));assert.equal(await loading,false);await tick();
    assert.equal(h.state().recognitionVersion,undefined);assert.equal(h.state().ledger.issues.length,1);
    assert.equal(h.nodes.resultsDialog.open,false);assert(h.nodes.error.textContent.includes('测试请求失败'));
    assert.equal(h.nodes.radarRevealArea.hidden,true);
  });
  await test('weapon route version invalidates cached scores once independently of engine version',async()=>{
    const weaponVersion='weapon-result-profile-average-v1-20261019';
    for(const oldVersion of [undefined,'old-weapon-route']){
      const h=harness({weaponVersion});await tick();const saved=record('old-weapon-cache');
      if(oldVersion!==undefined)saved.result.weaponVersion=oldVersion;
      saved.result.weapon={version:weaponVersion};
      const loading=h.ctx.loadSession(saved);await tick();
      assert.equal(h.pending.length,1);assert.equal(h.nodes.radarRevealArea.hidden,true);
      const response=structuredClone(h.pending[0].body.session);response.result.weaponVersion=weaponVersion;
      response.result.weapon.version='specific-engine-version';h.pending[0].resolve(response);await loading;await tick();
      h.ctx.loadSession(h.state());await tick();assert.equal(h.pending.length,1);
    }
  });
  await test('weapon migration shares pending character and planning changes and ignores late responses',async()=>{
    const weaponVersion='weapon-result-profile-average-v1-20261019',characterVersion='current-character';
    const h=harness({weaponVersion,characterVersion,planningVersion});await tick();
    const first=h.ctx.loadSession(record('old-all-versions',[pool({ended:undefined,rushAt:null})]));await tick();
    assert.equal(h.pending.length,1);const sent=h.pending[0].body.session;
    assert.equal(sent.ledger.character.pools[0].ended,true);assert.equal(sent.ledger.character.pools[0].rushAt,30);
    const current=record('current-weapon-record');current.result.weaponVersion=weaponVersion;
    current.result.character={version:characterVersion};current.result.planning.version=planningVersion;
    h.ctx.loadSession(current);await tick();const before=h.state();
    const response=structuredClone(sent);response.result.weaponVersion=weaponVersion;response.result.character={version:characterVersion};response.result.planning.version=planningVersion;
    h.pending[0].resolve(response);await first;await tick();
    assert.equal(h.pending.length,1);assert.deepEqual(h.state(),before);
  });
  await test('old partial early-stop result is replaced by newly calculable planning without changing axes', async () => {
    const h = harness({planningVersion}); await tick(); const saved = record('partial-cache');
    saved.result.axes = scoredAxes({characterSix: 74, up: 23});
    saved.result.planning = {version: 'planning-local-table-v1.3-direct-loss', pools: [
      {id: 'p0', banner: '熔火灼痕', status: 'partial', localLoss: null, message: '缺少理想停点后的真实记录'},
    ]};
    const loading = h.ctx.loadSession(saved); await tick();
    assert.equal(h.pending.length, 1);
    const response = structuredClone(h.pending[0].body.session);
    response.result.planning = {version: planningVersion, pools: [{id: 'p0', banner: '熔火灼痕',
      status: 'ok', localLoss: 1.25, total: 5, idealStop: 10, actual: {stop: 5, pity: 5},
      reference: {stop: 10, pity: 10, pityIsValuation: true}, missingPity: 5,
      referencePitySource: 'early-stop-water-extension', permanentDelta: 0,
      waterValueDelta: -1.25, rewardValueDelta: 0}]};
    h.pending[0].resolve(response); await loading; await tick();
    assert.equal(h.nodes.planningBreakdown.hidden, false);
    assert(h.nodes.planningHighlights.textContent.includes('1.25'));
    assert(!h.nodes.planningHighlights.querySelectorAll('.planning-score')[0].textContent.includes('数据不完整'));
    assert(h.nodes.planningHighlights.textContent.includes('资源损耗'));
    assert.deepEqual(h.state().result.axes, saved.result.axes, 'planning migration must preserve the server-provided luck axes');
    assert.equal(h.state().result.planning.pools[0].status, 'ok');
  });
  await test('current planning version reopens without recomputing or mutating the saved ledger', async () => {
    const h = harness({planningVersion}); await tick(); const saved = record('current-cache');
    saved.result.planning.version = planningVersion; const before = structuredClone(saved);
    h.ctx.loadSession(saved); h.flushTimers(); await tick();
    assert.equal(h.pending.length, 0); assert.deepEqual(h.state(), before);
  });
  await test('planning version and materialized defaults share one calculation request', async () => {
    const h = harness({planningVersion}); await tick();
    const saved = record('version-and-defaults', [pool({ended: undefined, rushAt: null})]);
    saved.result.planning.version = 'planning-local-table-v1.3-direct-loss';
    const loading = h.ctx.loadSession(saved); await tick(); h.flushTimers(); await tick();
    assert.equal(h.pending.length, 1);
    const sent = h.pending[0].body.session;
    assert.equal(sent.revision, 2); assert.equal(sent.ledger.character.pools[0].ended, true);
    assert.equal(sent.ledger.character.pools[0].rushAt, 30);
    const response = structuredClone(sent); response.result.planning.version = planningVersion;
    h.pending[0].resolve(response); await loading; await tick();
    h.ctx.loadSession(h.state()); h.flushTimers(); await tick();
    assert.equal(h.pending.length, 1, 'version and default migration must converge without a second request');
  });
  await test('late version-migration response cannot replace a newly opened current record', async () => {
    const h = harness({planningVersion}); await tick();
    const first = h.ctx.loadSession(record('old-version-A')); await tick();
    assert.equal(h.pending.length, 1);
    const newest = record('current-version-B'); newest.result.planning.version = planningVersion;
    newest.result.axes = scoredAxes({up: 91});
    h.ctx.loadSession(newest); await tick();
    assert.equal(h.pending.length, 1, 'current record B must not need a migration');
    const before = h.state(), response = structuredClone(h.pending[0].body.session);
    response.result.planning.version = planningVersion;
    h.pending[0].resolve(response); await first; await tick();
    assert.equal(h.state().id, 'current-version-B'); assert.deepEqual(h.state(), before);
    assert.equal(h.nodes.planningBreakdown.hidden, false);
  });
  await test('aggregate quota stays global while imported pool records remain editable',async()=>{
    const h=harness();await tick();const saved=record('aggregate-quota',[pool({quota:null})]);
    saved.ledger.character.quotaSummary={scope:'all-pools',Q:5000,N:60,R:1,K6:1};
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();
    assert(h.nodes.review.textContent.includes('全记录武库配额产出'));
    setField(h.nodes.review,'全记录武库配额产出',-1);h.nodes.resultsApply.click();await tick();
    assert.equal(h.pending.length,0);assert(h.nodes.characterDialogError.textContent.includes('非负整数'));
    setField(h.nodes.review,'全记录武库配额产出',5180);
    setField(h.nodes.review,'用加急时主池进度',31);h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.pending.filter(p=>p.url==='/api/score').length,1);
    assert.equal(h.state().ledger.character.pools[0].quota,null);
    assert.equal(h.state().ledger.character.quotaSummary.Q,5180);
  });
  await test('a nonlaunch opening asks about account history before editing pool rows',async()=>{
    const h=harness();await tick();
    const saved=record('opening-question',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[0].type'),'history');
    assert.equal(h.nodes.resultsDialogTitle.textContent,'限定池识别结果');
    assert(!h.nodes.initialHistory.hidden);assert(h.nodes.characterResultsPanel.hidden);
    assert.equal(findField(h.nodes.initialHistory,'这是账号首次抽限定池吗？').value,'');
    h.nodes.resultsApply.click();await tick();
    assert(h.nodes.characterDialogError.textContent.includes('请选择首池'));
    assert.equal(h.pending.length,0);assert.equal(h.state().ledger.character.initialOwned,null);
  });
  await test('cancelling opening history discards choice collection and water edits',async()=>{
    const h=harness();await tick();
    const saved=record('opening-cancel',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();const before=h.state();
    setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','false');
    setField(h.nodes.initialHistory,'此前图鉴','known');
    const label=h.nodes.initialHistory.querySelectorAll('label').find(n=>n.textContent==='卡缪');
    assert(label);label.querySelector('input').checked=true;label.querySelector('input').onchange();
    setField(h.nodes.initialHistory,'首池期初水位',12);setField(h.nodes.initialHistory,'首池免费额度','20');
    h.nodes.resultsCancel.click();h.flushTimers();await tick();
    assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);assert.equal(h.nodes.resultsDialog.open,false);
  });
  await test('confirmed account first pool saves zero opening and free ten without changing weapon or draws',async()=>{
    const h=harness();await tick();
    const saved=record('opening-first',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();const oldWeapon=structuredClone(saved.ledger.weapon),oldDocs=structuredClone(saved.documents);
    setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','true');h.nodes.resultsApply.click();await tick();
    assert.equal(h.pending.length,1);const sent=h.pending[0].body.session,c=sent.ledger.character;
    assert.deepEqual(c.firstPoolHistory,{poolId:'p8',isFirstPool:true});
    assert.equal(c.initialPity,0);assert.equal(c.pools[0].initialPity,0);assert.deepEqual(c.initialOwned,[]);
    assert.equal(c.pools[0].freeAllowance,10);assert.equal(c.pools[0].total,60);assert.equal(c.pools[0].events.length,1);
    assert.deepEqual(sent.ledger.weapon,oldWeapon);assert.deepEqual(sent.documents,oldDocs);
    h.pending[0].resolve(structuredClone(sent));await tick();
    const persisted=h.state();h.ctx.loadSession(persisted);h.flushTimers();await tick();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.pending.length,1,'saved choice must not ask or rescore again');
    h.nodes.openResults.click();assert.equal(findField(h.nodes.initialHistory,'这是账号首次抽限定池吗？').value,'true');
  });
  await test('earlier collection choices survive save and reopening without invented preceding events',async()=>{
    const h=harness();await tick();
    const saved=record('opening-earlier',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();const oldWeapon=structuredClone(saved.ledger.weapon);
    setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','false');
    setField(h.nodes.initialHistory,'此前图鉴','known');
    for(const name of ['卡缪','艾尔黛拉']){
      const label=h.nodes.initialHistory.querySelectorAll('label').find(n=>n.textContent===name);assert(label);
      const input=label.querySelector('input');input.checked=true;input.onchange();
    }
    setField(h.nodes.initialHistory,'首池期初水位',23);setField(h.nodes.initialHistory,'首池免费额度','20');
    h.nodes.resultsApply.click();await tick();assert.equal(h.pending.length,1);
    const sent=h.pending[0].body.session,c=sent.ledger.character;
    assert.deepEqual(c.firstPoolHistory,{poolId:'p8',isFirstPool:false});assert.equal(c.completeHistory,false);
    assert.deepEqual(c.initialOwned,['卡缪','艾尔黛拉']);assert.equal(c.initialPity,23);assert.equal(c.pools[0].initialPity,23);
    assert.equal(c.pools[0].freeAllowance,20);assert.equal(c.pools.length,1);assert.equal(c.pools[0].events.length,1);
    assert.equal(c.pools[0].total,60);assert.deepEqual(sent.ledger.weapon,oldWeapon);
    h.pending[0].resolve(structuredClone(sent));await tick();h.ctx.loadSession(h.state());await tick();
    assert.equal(h.nodes.resultsDialog.open,false);h.nodes.openResults.click();
    const checked=h.nodes.initialHistory.querySelectorAll('label').filter(n=>n.querySelector('input')?.checked).map(n=>n.textContent);
    assert.deepEqual(checked,['卡缪','艾尔黛拉']);
  });
  await test('unknown earlier collection and water remain null instead of becoming empty history',async()=>{
    const h=harness();await tick();
    const saved=record('opening-unknown',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();
    setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','false');
    assert.equal(h.read('characterDraft.initialOwned'),null,'choosing earlier history must not claim an empty known collection');
    setField(h.nodes.initialHistory,'此前图鉴','unknown');setField(h.nodes.initialHistory,'首池期初水位','');
    setField(h.nodes.initialHistory,'首池免费额度','10');h.nodes.resultsApply.click();await tick();
    assert.equal(h.pending.length,1);const c=h.pending[0].body.session.ledger.character;
    assert.equal(c.initialOwned,null);assert.equal(c.initialPity,null);assert.equal(c.pools[0].initialPity,null);
    assert.equal(c.completeHistory,false);assert.equal(c.pools[0].total,60);assert.equal(c.pools[0].events.length,1);
  });
  await test('account first confirmation does not declare missing middle banners complete',async()=>{
    const h=harness();await tick();
    const saved=record('opening-gap',[
      pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,events:[{at:50,character:'诀',source:'main'}]}),
      pool({id:'p10',index:10,banner:'冬猎',up:'提弗洛斯',initialPity:null,events:[{at:50,character:'提弗洛斯',source:'main'}]}),
    ]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','true');
    h.nodes.resultsApply.click();await tick();assert.equal(h.pending.length,1);
    const c=h.pending[0].body.session.ledger.character;assert.equal(c.completeHistory,false);
    assert.equal(c.initialPity,0);assert.equal(c.pools[1].initialPity,null);assert.equal(c.pools.length,2);
  });
  await test('history step preserves unresolved OCR row errors for the following pool prompt',async()=>{
    const h=harness();await tick();
    const saved=record('opening-and-error',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',initialPity:null,
      events:[{at:50,character:'诀',source:'main'}],issues:[{code:'fixture_ocr_error',severity:'error',message:'本池仍有识别错误'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','true');
    h.nodes.resultsApply.click();await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'pool');
    assert.equal(h.state().ledger.character.pools[0].issues[0].severity,'error');assert.equal(h.pending.length,0);
    assert.equal(h.nodes.review.querySelectorAll('.pool').length,1);
  });
  await test('initial confirmation belongs to the earliest pool identity and cannot leak to an earlier import',async()=>{
    const h=harness();await tick();
    const saved=record('opening-changed',[pool({id:'p7',index:7,banner:'逐罪者',up:'卡缪',
      events:[{at:50,character:'卡缪',source:'main'}]})]);
    saved.ledger.character.firstPoolHistory={poolId:'p8',isFirstPool:true};
    h.ctx.loadSession(saved);await tick();assert.equal(h.nodes.resultsDialog.open,true);
    assert.equal(findField(h.nodes.initialHistory,'这是账号首次抽限定池吗？').value,'');
    assert.equal(h.read('autoReviewQueue[0].type'),'history');
  });
  await test('summary override edits only scoped confirmation and leaves original evidence and weapon intact',async()=>{
    const h=harness();await tick();const saved=record('summary-manual');
    saved.documents[0].overview={character:{N:60,K6:1,off:0}};
    h.ctx.loadSession(saved);await tick();const before=h.state();h.nodes.openResults.click();
    setField(h.nodes.summaryReview,'顶部汇总依据','override');
    setField(h.nodes.summaryReview,'主池总抽数',61);setField(h.nodes.summaryReview,'主池六星数',2);setField(h.nodes.summaryReview,'歪出次数',1);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const sent=h.pending[0].body.session,override=sent.ledger.character.summaryOverrides[0];
    assert.deepEqual(override,{source_sha256:'abc',file:'fixture.png',mode:'override',N:61,K6:2,off:1});
    assert.deepEqual(sent.documents,before.documents);assert.deepEqual(sent.ledger.weapon,before.ledger.weapon);
    assert.deepEqual(sent.ledger.character.pools,before.ledger.character.pools);
    h.pending[0].resolve(structuredClone(sent));await tick();h.nodes.openResults.click();
    assert.equal(findField(h.nodes.summaryReview,'顶部汇总依据').value,'override');
    assert.equal(Number(findField(h.nodes.summaryReview,'主池总抽数').value),61);
  });
  await test('summary details-only selection is explicit reversible and does not clear source conflicts in browser',async()=>{
    const h=harness();await tick();const saved=record('summary-details');
    saved.documents[0].overview={character:{N:60,K6:1,off:0}};
    saved.ledger.issues=[{code:'account_mismatch',severity:'error',message:'不同账号'}];
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();
    setField(h.nodes.summaryReview,'顶部汇总依据','details');h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.pending.length,1);let sent=h.pending[0].body.session;
    assert.equal(sent.ledger.character.summaryOverrides[0].mode,'details');
    assert.deepEqual(sent.ledger.issues,saved.ledger.issues);assert.deepEqual(sent.documents,saved.documents);
    h.pending[0].resolve(structuredClone(sent));await tick();h.nodes.openResults.click();
    assert.equal(findField(h.nodes.summaryReview,'顶部汇总依据').value,'details');
    setField(h.nodes.summaryReview,'顶部汇总依据','original');h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.pending.length,2);sent=h.pending[1].body.session;
    assert.deepEqual(sent.ledger.character.summaryOverrides,[]);assert.deepEqual(sent.documents,saved.documents);
    assert.deepEqual(sent.ledger.weapon,saved.ledger.weapon);
  });
  await test('summary invalid counts block saving and cancelling preserves the previous basis',async()=>{
    const h=harness();await tick();const saved=record('summary-invalid');
    saved.documents[0].overview={character:{N:60,K6:1,off:0}};
    h.ctx.loadSession(saved);await tick();const before=h.state();h.nodes.openResults.click();
    setField(h.nodes.summaryReview,'顶部汇总依据','override');setField(h.nodes.summaryReview,'主池总抽数',-1);
    h.nodes.resultsApply.click();await tick();assert(h.nodes.characterDialogError.textContent.includes('非负整数'));assert.equal(h.pending.length,0);
    setField(h.nodes.summaryReview,'主池总抽数',1);setField(h.nodes.summaryReview,'主池六星数',2);
    h.nodes.resultsApply.click();assert(h.nodes.characterDialogError.textContent.includes('六星数不能大于'));
    setField(h.nodes.summaryReview,'主池总抽数',60);setField(h.nodes.summaryReview,'歪出次数',3);
    h.nodes.resultsApply.click();assert(h.nodes.characterDialogError.textContent.includes('歪出次数不能大于'));
    h.nodes.resultsCancel.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
  });
  await test('blank summary fields stay unknown rather than becoming zero overrides',async()=>{
    const h=harness();await tick();const saved=record('summary-unknown');
    saved.documents[0].overview={character:{N:60,K6:1,off:0}};
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();setField(h.nodes.summaryReview,'顶部汇总依据','override');
    for(const label of ['主池总抽数','主池六星数','歪出次数'])setField(h.nodes.summaryReview,label,'');
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const override=h.pending[0].body.session.ledger.character.summaryOverrides[0];
    assert.equal(override.N,null);assert.equal(override.K6,null);assert.equal(override.off,null);
  });
  await test('newly supplied opening pity that makes a wait impossible enters pool repair instead of finishing',async()=>{
    const h=harness();await tick();
    const saved=record('opening-exposes-impossible-wait',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',
      total:30,initialPity:null,tail:10,events:[{at:20,character:'诀',source:'main'}]})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false});
    h.ctx.loadSession(saved);await tick();setField(h.nodes.initialHistory,'这是账号首次抽限定池吗？','false');
    setField(h.nodes.initialHistory,'首池期初水位',70);setField(h.nodes.initialHistory,'首池免费额度','10');
    h.nodes.resultsApply.click();await tick();
    assert.equal(h.pending.length,0);assert.equal(h.nodes.resultsDialog.open,true);
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'pool');
    assert.equal(h.state().ledger.character.initialPity,70);
    h.nodes.resultsApply.click();await tick();assert.equal(h.pending.length,0);
    assert(h.nodes.characterDialogError.textContent.includes('超过80抽'));
    setField(h.nodes.review,'期初水位',0);h.nodes.resultsApply.click();await tick();
    assert.equal(h.pending.length,1);assert.equal(h.pending[0].body.session.ledger.character.initialPity,0);
  });
  await test('turning rush off permits a corrected sub30 total without retaining an invalid old rush time',async()=>{
    const h=harness();await tick();
    const saved=record('rush-off-lower-total',[pool({total:30,tail:10,events:[{at:20,character:'莱万汀',source:'main'}]})]);
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();
    setField(h.nodes.review,'加急使用状态','false');setField(h.nodes.review,'主池总抽数',25);
    setField(h.nodes.review,'武库配额',2480);h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.pending.length,1);const p=h.pending[0].body.session.ledger.character.pools[0];
    assert.equal(p.total,25);assert.equal(p.tail,5);assert.equal(p.localTail,5);
    assert.equal(p.rushUsed,false);assert.equal(p.rushAt,null);assert.equal(p.events.length,1);
    assert.deepEqual(p.rush,[]);assert.equal(h.nodes.characterDialogError.textContent,'');
  });
  await test('editing total across240 immediately displays and saves added then removed milestone tokens',async()=>{
    const h=harness();await tick();
    const events=[50,100,150,200].map(at=>({at,character:'莱万汀',source:'main',forced:false}));
    h.ctx.loadSession(record('live-token-nodes',[pool({total:239,tail:39,events,quota:20000})]));await tick();
    h.nodes.openResults.click();assert(!h.nodes.review.textContent.includes('信物节点：240'));
    setField(h.nodes.review,'主池总抽数',240);assert(h.nodes.review.textContent.includes('信物节点：240'));
    assert.equal(h.read('characterDraft.pools[0].tokens[0].at'),240);
    assert.equal(h.state().ledger.character.pools[0].tokens.length,0,'the saved record must wait for commit');
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const first=h.pending[0].body.session;assert.equal(first.ledger.character.pools[0].tokens[0].at,240);
    assert.equal(first.ledger.character.pools[0].events.length,4);
    h.pending[0].resolve(structuredClone(first));await tick();h.nodes.openResults.click();
    setField(h.nodes.review,'主池总抽数',239);assert(!h.nodes.review.textContent.includes('信物节点：240'));
    assert.equal(h.read('characterDraft.pools[0].tokens.length'),0);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,2);
    assert.equal(h.pending[1].body.session.ledger.character.pools[0].tokens.length,0);
    assert.equal(h.pending[1].body.session.ledger.character.pools[0].events.length,4);
  });
  await test('editing total across480 retains earlier token evidence while adding and removing only the second node',async()=>{
    const h=harness();await tick();
    const events=[50,100,150,200,250,300,350,400,450].map(at=>({at,character:'莱万汀',source:'main',forced:false}));
    const token={at:240,source:'token',evidence:{crop:'original-token.png'}};
    h.ctx.loadSession(record('live-second-token',[pool({total:470,tail:20,events,quota:40000,tokens:[token]})]));await tick();
    const before=h.state();h.nodes.openResults.click();setField(h.nodes.review,'主池总抽数',480);
    assert(h.nodes.review.textContent.includes('信物节点：240、480'));
    assert.deepEqual(JSON.parse(h.read('JSON.stringify(characterDraft.pools[0].tokens[0])')),token);
    setField(h.nodes.review,'主池总抽数',479);assert(h.nodes.review.textContent.includes('信物节点：240'));assert(!h.nodes.review.textContent.includes('240、480'));
    assert.equal(h.read('characterDraft.pools[0].tokens.length'),1);
    h.nodes.resultsCancel.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
  });
  await test('manual ending pity infers unknown no-hit opening and synchronizes initial history without invented hits',async()=>{
    const h=harness();await tick();
    const saved=record('tail-reveals-opening',[pool({id:'p8',index:8,banner:'临渊望北',up:'诀',total:10,
      initialPity:null,tail:null,quota:200,events:[],rushUsed:false,rushAt:null,freeAllowance:10})]);
    Object.assign(saved.ledger.character,{initialPity:null,initialOwned:null,completeHistory:false,
      firstPoolHistory:{poolId:'p8',isFirstPool:false}});
    h.ctx.loadSession(saved);await tick();h.nodes.openResults.click();setField(h.nodes.review,'期末水位',17);
    assert.equal(Number(findField(h.nodes.review,'期初水位').value),7);
    assert.equal(Number(findField(h.nodes.initialHistory,'首池期初水位').value),7);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const c=h.pending[0].body.session.ledger.character;
    assert.equal(c.initialPity,7);assert.equal(c.pools[0].initialPity,7);assert.equal(c.pools[0].tail,17);
    assert.equal(c.pools[0].total,10);assert.deepEqual(c.pools[0].events,[]);assert.equal(c.initialOwned,null);
  });
  await test('missing240 token with warning only enters import queue and saving confirms its fixed node',async()=>{
    const h=harness();await tick();
    const events=[50,100,150,200].map(at=>({at,character:'莱万汀',source:'main',forced:false}));
    const saved=record('missing-token-warning',[pool({total:240,tail:40,events,tokens:[],quota:20000,
      issues:[{code:'token_count_mismatch',severity:'warning',message:'信物节点数量不符'}]})]);
    h.ctx.loadSession(saved,{reviewImport:true});await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[0].type'),'pool');
    assert.equal(h.state().ledger.character.pools[0].tokens.length,0);
    h.nodes.resultsApply.click();await tick();assert.equal(h.pending.length,1);
    const p=h.pending[0].body.session.ledger.character.pools[0];
    assert.equal(p.total,240);assert.deepEqual(p.tokens.map(t=>t.at),[240]);assert.equal(p.events.length,4);
  });
  await test('ordinary recognition editor can explicitly rebuild token nodes without changing total',async()=>{
    const h=harness();await tick();
    const events=[50,100,150,200].map(at=>({at,character:'莱万汀',source:'main',forced:false}));
    h.ctx.loadSession(record('manual-token-repair',[pool({total:240,tail:40,events,tokens:[],quota:20000})]));await tick();
    assert.equal(h.nodes.resultsDialog.open,true);h.nodes.resultsCancel.click();
    h.nodes.openResults.click();assert.equal(h.read('autoReviewQueue.length'),0);
    findButton(h.nodes.review,'按总抽数补全信物节点').click();
    assert(h.nodes.review.textContent.includes('信物节点：240'));assert.equal(h.state().ledger.character.pools[0].tokens.length,0);
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const p=h.pending[0].body.session.ledger.character.pools[0];
    assert.equal(p.total,240);assert.deepEqual(p.tokens.map(t=>t.at),[240]);assert.equal(p.events.length,4);
  });
  await test('marking previously incomplete pool complete commits only on save and cancels cleanly',async()=>{
    const h=harness();await tick();h.ctx.loadSession(record('mark-complete',[pool({complete:false})]));await tick();
    const before=h.state();h.nodes.openResults.click();
    let label=h.nodes.review.querySelectorAll('label').find(n=>n.textContent.includes('缺失明细已补全'));
    assert(label);let check=label.querySelector('input');check.checked=true;check.onchange();
    assert.equal(h.read('characterDraft.pools[0].complete'),true);assert.equal(h.state().ledger.character.pools[0].complete,false);
    h.nodes.resultsCancel.click();h.flushTimers();await tick();assert.deepEqual(h.state(),before);assert.equal(h.pending.length,0);
    h.nodes.openResults.click();label=h.nodes.review.querySelectorAll('label').find(n=>n.textContent.includes('缺失明细已补全'));
    assert(label);check=label.querySelector('input');assert.equal(check.checked,false);check.checked=true;check.onchange();
    h.nodes.resultsApply.click();h.flushTimers();await tick();assert.equal(h.pending.length,1);
    const p=h.pending[0].body.session.ledger.character.pools[0];assert.equal(p.complete,true);
    assert.equal(p.total,before.ledger.character.pools[0].total);assert.equal(p.events.length,1);
  });
  await test('a link mismatch already resolved by the queued pool edit is skipped instead of reopening an empty prompt',async()=>{
    const h=harness();await tick();
    const first=pool({issues:[{code:'fixture_ocr_error',severity:'error',message:'总抽数待更正'}]});
    const second=pool({id:'p1',index:1,banner:'轻飘飘的信使',up:'洁尔佩塔',initialPity:20,tail:20,
      events:[{at:40,character:'洁尔佩塔',source:'main',forced:false}]});
    h.ctx.loadSession(record('resolved-link',[first,second]),{reviewImport:true});await tick();
    assert.equal(h.read('autoReviewQueue[0].type'),'pool');assert.equal(h.read('autoReviewQueue[1].type'),'links');
    setField(h.nodes.review,'主池总抽数',70);h.nodes.resultsApply.click();await tick();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.read('autoReviewQueue.length'),0);
    assert.equal(h.pending.length,1);const pools=h.pending[0].body.session.ledger.character.pools;
    assert.equal(pools[0].tail,20);assert.equal(pools[1].initialPity,20);
  });
  await test('ordinary saved history opens a remaining pool issue after one migration without importing images',async()=>{
    const recognitionVersion='avatar-review-migration-v3-20261023',h=harness({recognitionVersion});await tick();
    const saved=record('old-pool');saved.ledger.character.pools[0].issues=[{code:'event_needs_review',severity:'error',message:'熔火灼痕第50抽头像不明'}];
    const opening=h.ctx.loadSession(saved);await tick();assert.equal(h.nodes.resultsDialog.open,false);
    const response=structuredClone(h.pending[0].body.session);response.recognitionVersion=recognitionVersion;
    h.pending[0].resolve(response);await opening;await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[0].type'),'pool');
    assert(h.nodes.review.textContent.includes('第50抽头像不明'));
    assert.equal(h.requests.filter(r=>r.url==='/api/score').length,1);
    assert.equal(h.requests.filter(r=>r.url==='/api/import').length,0);
  });
  await test('migration clears obsolete pool and displayed summary errors while preserving edited identities',async()=>{
    const recognitionVersion='avatar-review-migration-v3-20261023',h=harness({recognitionVersion});await tick();
    const saved=record('corrected-pool');saved.ledger.character.pools[0].events[0].character='艾尔黛拉';
    saved.ledger.character.pools[0].issues=[{code:'event_needs_review',severity:'error',message:'旧头像错误'}];
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'旧汇总不符'}];
    const opening=h.ctx.loadSession(saved);await tick();const response=structuredClone(h.pending[0].body.session);
    response.recognitionVersion=recognitionVersion;response.ledger.issues=[];response.ledger.character.pools[0].issues=[];
    h.pending[0].resolve(response);await opening;await tick();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.nodes.currentGlobalIssues.textContent,'');
    assert.equal(h.state().ledger.character.pools[0].events[0].character,'艾尔黛拉');
    assert.equal(h.nodes.calculating.hidden,true);
  });
  await test('current-version history with real errors still opens the appropriate pool',async()=>{
    const recognitionVersion='current-input',h=harness({recognitionVersion});await tick();const saved=record('current-errors');
    saved.recognitionVersion=recognitionVersion;saved.ledger.character.pools[0].issues=[{code:'event_needs_review',severity:'error',message:'头像待确认'}];
    h.ctx.loadSession(saved);await tick();assert.equal(h.pending.length,0);
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('characterReviewPoolId'),'p0');
  });
  await test('explicitly selecting an identity records manual precedence without changing source evidence',async()=>{
    const h=await loaded(),original=h.state().documents;h.nodes.openResults.click();
    const picker=mainRows(h)[0].children[2].querySelector('select');picker.value='莱万汀';picker.onchange();
    assert.equal(h.read('characterDraft.pools[0].events[0].identitySource'),'manual');
    assert.equal(h.state().ledger.character.pools[0].events[0].identitySource,undefined);
    h.nodes.resultsApply.click();h.flushTimers();await tick();
    assert.equal(h.pending[0].body.session.ledger.character.pools[0].events[0].identitySource,'manual');
    assert.deepEqual(h.pending[0].body.session.documents,original);
  });
  await test('multi-person import preserves independent records and failures with navigation through history',async()=>{
    const h=harness();await tick();const a=record('person-a'),b=record('person-b');
    a.documents[0].file='甲.png';b.documents[0].file='乙.png';b.ledger.weapon={N:100,K6:4,KU:2};
    const items=[{index:0,name:'甲.png',status:'done',sessionId:a.id},{index:1,name:'坏图.png',status:'error',error:'图片不完整'},
      {index:2,name:'乙.png',status:'done',sessionId:b.id}];
    h.replies.set('/api/import',{id:'batch'});h.replies.set('/api/jobs/batch',{status:'done',sessions:[a,b],session:a,items,failed:1,message:'完成'});
    h.replies.set('/api/sessions',[{id:a.id,name:'甲.png',updatedAt:1000},{id:b.id,name:'乙.png',updatedAt:1001}]);
    h.ctx.selected([{name:'甲.png',size:10},{name:'坏图.png',size:10},{name:'乙.png',size:10}]);await h.nodes.import.click();await tick();
    assert.equal(h.state().id,a.id);assert.equal(h.nodes.batchRecords,undefined);assert.equal(h.nodes.batchResults,undefined);
    assert(h.nodes.error.textContent.includes('坏图.png：图片不完整'));assert(h.nodes.status.textContent.includes('2 份独立记录，1 张失败'));
    assert.equal(h.nodes.recordTitle.textContent,'甲.png');
    const latest=structuredClone(b);latest.revision=3;latest.ledger.weapon.N=110;
    h.replies.set('/api/sessions/person-b',latest);h.nodes.openHistory.click();await tick();
    await h.nodes.history.querySelectorAll('button').find(n=>n.textContent.startsWith('乙.png')).click();await tick();
    assert.equal(h.state().id,b.id);assert.equal(h.state().revision,3);assert.equal(h.state().ledger.weapon.N,110);
    assert.equal(h.nodes.recordTitle.textContent,'乙.png');
    assert.equal(h.state().documents.length,1);assert.equal(a.ledger.weapon.N,60);
  });
  await test('all-failed batch keeps per-image reasons and never replaces the already opened record',async()=>{
    const h=await loaded(),before=h.state();h.replies.set('/api/import',{id:'failed-batch'});
    h.replies.set('/api/jobs/failed-batch',{status:'error',message:'全部失败',items:[
      {index:0,name:'甲.png',status:'error',error:'不是支持的截图'},{index:1,name:'乙.png',status:'error',error:'文件无法读取'}]});
    h.ctx.selected([{name:'甲.png',size:1},{name:'乙.png',size:1}]);await h.nodes.import.click();await tick();
    assert.deepEqual(h.state(),before);assert(h.nodes.error.textContent.includes('甲.png：不是支持的截图'));
    assert(h.nodes.error.textContent.includes('乙.png：文件无法读取'));assert.equal(h.nodes.batchRecords,undefined);
    assert(h.nodes.status.textContent.includes('0 份独立记录，2 张失败'));
    assert.equal(h.nodes.import.disabled,false);assert(h.nodes.error.textContent.includes('全部失败'));
  });
  await test('home picker and dropzone accept TXT and JSON and use the text adapter',async()=>{
    const accept=html.match(/id="images"[^>]*accept="([^"]+)"/)[1].split(',');
    assert(accept.includes('.txt')&&accept.includes('.json')&&accept.includes('.png'));
    for(const name of ['from-picker.TXT','from-drop.json']){
      const h=await loaded(),before=h.state(),file={name,size:100,text:async()=>'\uFEFF{"synthetic":true}'};
      if(name.endsWith('.json'))h.nodes.dropzone.ondrop({preventDefault(){},dataTransfer:{files:[file]}});
      else h.nodes.images.onchange({target:{files:[file]}});
      assert.equal(h.nodes.selection.textContent,name);assert(!h.nodes.import.disabled);
      const importing=h.nodes.import.click();await tick();
      assert(h.read('busy'));assert(h.nodes.images.disabled);assert.deepEqual(h.state(),before);
      assert.equal(h.requests.filter(r=>r.url==='/api/import').length,0);
      const request=h.pending.find(r=>r.url==='/api/records/import');assert(request);
      assert.equal(request.body.name,name);assert.equal(request.body.text,'{"synthetic":true}');
      request.resolve(record('home-'+name));await importing;await tick();
      assert.equal(h.state().id,'home-'+name);assert(!h.read('busy'));assert(!h.nodes.images.disabled);
    }
  });
  await test('home import restores saved session JSON through the restore endpoint',async()=>{
    const h=await loaded(),saved=record('saved-home');
    h.ctx.selected([{name:'saved.json',size:100,text:async()=>JSON.stringify(saved)}]);
    const importing=h.nodes.import.click();await tick();
    assert.equal(h.requests.filter(r=>r.url==='/api/import'||r.url==='/api/records/import').length,0);
    const request=h.pending.find(r=>r.url==='/api/restore');assert(request);assert.deepEqual(request.body,saved);
    request.resolve({...saved,id:'restored-home'});await importing;
    assert.equal(h.state().id,'restored-home');
  });
  await test('mixed image and record files stay independent and a failed text import does not discard success',async()=>{
    const h=await loaded(),image=record('image-person'),text=record('text-person');
    h.replies.set('/api/import',{id:'mixed-batch'});
    h.replies.set('/api/jobs/mixed-batch',{status:'done',sessions:[image],failed:0,items:[],message:'完成'});
    h.ctx.selected([{name:'image.png',size:10},{name:'bad.txt',size:10,text:async()=>'bad'},
                    {name:'good.json',size:10,text:async()=>'{}'}]);
    const importing=h.nodes.import.click();await tick();
    const imageRequest=h.requests.find(r=>r.url==='/api/import');assert.equal(imageRequest.body.files.length,1);
    const failed=h.pending.find(r=>r.url==='/api/records/import');assert.equal(failed.body.name,'bad.txt');
    failed.reject(Error('无法识别此记录'));await tick();
    const good=h.pending.filter(r=>r.url==='/api/records/import').at(-1);assert.equal(good.body.name,'good.json');
    good.resolve(text);await importing;await tick();
    assert.equal(h.state().id,image.id);assert(h.nodes.status.textContent.includes('2 份独立记录，1 项失败'));
    assert(h.nodes.historyDeleteFeedback.textContent.includes('bad.txt'));assert(h.nodes.error.textContent.includes('无法识别此记录'));
    assert(!h.nodes.import.disabled);
  });
  await test('unsupported home selections fail before submitting any files',async()=>{
    const h=await loaded(),before=h.state();h.ctx.selected([{name:'not-a-record.exe',size:10}]);
    await h.nodes.import.click();assert(h.nodes.error.textContent.includes('不支持的文件'));
    assert.deepEqual(h.state(),before);assert.equal(h.requests.filter(r=>r.url==='/api/import'||r.url==='/api/records/import').length,0);
  });
  await test('unrecognized format opens a persistent author-contact dialog from the home entry',async()=>{
    const h=await loaded(),before=h.state();h.ctx.selected([{name:'future.json',size:10,text:async()=>'{}'}]);
    const importing=h.nodes.import.click();await tick();
    h.pending.find(r=>r.url==='/api/records/import').resolve({error:'暂不支持此记录格式，请联系作者协助适配。',code:'record_format_unrecognized'},false);
    await importing;assert(h.nodes.recordFormatDialog.open);assert(h.nodes.recordFormatFiles.textContent.includes('future.json'));
    assert(html.includes('暂不支持此记录格式，请联系作者协助适配。'));assert.deepEqual(h.state(),before);
    h.advanceTimers(4000);assert(h.nodes.recordFormatDialog.open);
    h.staticNodes.find(n=>n.dataset.closeDialog==='recordFormatDialog').click();assert(!h.nodes.recordFormatDialog.open);
  });
  await test('a format popup survives successful files later in the same batch',async()=>{
    const h=await loaded();h.ctx.selected([{name:'future.txt',size:10,text:async()=>'unknown'},
                                         {name:'valid.json',size:10,text:async()=>'{}'}]);
    const importing=h.nodes.import.click();await tick();
    h.pending.find(r=>r.url==='/api/records/import').resolve({error:'暂不支持此记录格式，请联系作者协助适配。',code:'record_format_unrecognized'},false);
    await tick();h.pending.filter(r=>r.url==='/api/records/import').at(-1).resolve(record('valid-after-failure'));
    await importing;assert.equal(h.state().id,'valid-after-failure');assert(h.nodes.recordFormatDialog.open);
    assert(h.nodes.recordFormatFiles.textContent.includes('future.txt'));assert(h.nodes.status.textContent.includes('1 份独立记录，1 项失败'));
  });
  await test('rapid person switches ignore an older history response',async()=>{
    const h=await loaded(),first=h.ctx.openSavedSession('slow-a'),second=h.ctx.openSavedSession('fast-b');await tick();
    const ra=h.pending.find(r=>r.url==='/api/sessions/slow-a'),rb=h.pending.find(r=>r.url==='/api/sessions/fast-b');
    rb.resolve(record('fast-b'));await second;await tick();const current=h.state();
    ra.resolve(record('slow-a'));assert.equal(await first,false);await tick();assert.deepEqual(h.state(),current);
  });
  await test('a failed migration on history open does not report successful opening',async()=>{
    const h=harness({recognitionVersion:'current'});await tick();h.replies.set('/api/sessions/old',record('old'));
    const opening=h.ctx.openSavedSession('old');await tick();h.pending.find(r=>r.url==='/api/score').reject(Error('迁移暂时失败'));
    assert.equal(await opening,false);await tick();assert(h.nodes.error.textContent.includes('迁移暂时失败'));
    assert(!h.nodes.status.textContent.includes('已打开本机记录'));
  });
  await test('version-only migration preserves saved confirmation and reviews newly discovered errors',async()=>{
    const h=harness({recognitionVersion:'current-review'});await tick();const saved=record('reviewed-legacy');
    assert.equal(saved.reviewed,true);const opening=h.ctx.loadSession(saved);await tick();
    const response=structuredClone(h.pending[0].body.session);assert.equal(response.reviewed,true);
    response.recognitionVersion='current-review';response.ledger.character.pools[0].issues=[{code:'event_needs_review',severity:'error',message:'新发现的真实头像冲突'}];
    h.pending[0].resolve(response);await opening;await tick();
    assert.equal(h.nodes.resultsDialog.open,true);assert.equal(h.read('autoReviewQueue[0].type'),'pool');
    assert(h.nodes.review.textContent.includes('新发现的真实头像冲突'));
  });
  for(const field of ['ended','rushAt'])for(const currentRecognition of [false,true]){
    await test(`automatic ${field} default preserves confirmed identities with ${currentRecognition?'current':'old'} recognition version`,async()=>{
      const recognitionVersion='current-review',h=harness({recognitionVersion});await tick();
      const saved=record('confirmed-default-'+field+'-'+currentRecognition),evidence=structuredClone(saved.documents);
      saved.recognitionVersion=currentRecognition?recognitionVersion:'old-review';
      delete saved.ledger.character.pools[0][field];
      assert.equal(saved.reviewed,true);
      const opening=h.ctx.loadSession(saved);await tick();
      const requests=h.requests.filter(r=>r.url==='/api/score');assert.equal(requests.length,1);
      const submitted=h.pending[0].body.session;
      assert.equal(submitted.reviewed,true);assert.equal(submitted.revision,2);
      assert.equal(submitted.ledger.character.pools[0][field],field==='ended'?true:30);
      assert.deepEqual(submitted.documents,evidence);
      const response=structuredClone(submitted);response.recognitionVersion=recognitionVersion;
      h.pending[0].resolve(response);await opening;await tick();assert.equal(h.state().reviewed,true);
      h.ctx.loadSession(h.state());await tick();assert.equal(h.requests.filter(r=>r.url==='/api/score').length,1);
      // An actual subsequent edit still invalidates the old confirmation.
      h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5180);
      h.nodes.resultsApply.click();h.flushTimers();await tick();
      assert.equal(h.pending[1].body.session.reviewed,false);
    });
  }
  await test('saving a queued pool explicitly confirms only its visible event identities',async()=>{
    const h=harness();await tick();const saved=record('confirm-pool',[pool({issues:[{code:'event_needs_review',severity:'error',message:'头像低置信待确认'}]})]);
    h.ctx.loadSession(saved);await tick();assert(h.nodes.resultsSaveHint.textContent.includes('确认本池'));
    h.nodes.resultsApply.click();await tick();const p=h.pending[0].body.session.ledger.character.pools[0];
    assert.equal(p.eventReviewConfirmed,true);assert.equal(p.events[0].identityReviewed,true);
  });
  await test('editing an ordinary numeric field does not claim all identities are manually confirmed',async()=>{
    const h=await loaded();h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5180);
    h.nodes.resultsApply.click();h.flushTimers();await tick();const p=h.pending[0].body.session.ledger.character.pools[0];
    assert.equal(p.eventReviewConfirmed,undefined);assert.equal(p.events[0].identityReviewed,undefined);
  });
  const validationHarness=async(saved=record('live'))=>{
    const h=harness({manualValidation:true});await tick();h.ctx.loadSession(saved);await tick();
    if(!h.nodes.resultsDialog.open)h.nodes.openResults.click();return h;
  };
  const validationRequest=async h=>{
    h.flushTimers();await tick();const request=h.pending.filter(r=>r.url==='/api/validate').at(-1);assert(request);return request;
  };
  const clearValidation=request=>{
    const ledger=structuredClone(request.body.session.ledger);ledger.issues=[];ledger.character.issues=[];
    for(const p of ledger.character.pools)p.issues=[];if(ledger.weapon)ledger.weapon.issues=[];return ledger;
  };
  await test('live correction removes only resolved diagnostics and never changes the saved record',async()=>{
    const saved=record('live-issues',[pool({quota:null,issues:[{code:'event_needs_review',severity:'error',message:'旧头像冲突'},
      {code:'quota_missing',severity:'error',message:'仍然缺少配额'}]})]);
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'顶部汇总不一致'}];
    const h=await validationHarness(saved),before=h.state();
    h.nodes.resultsApply.click();assert(!h.nodes.characterDialogError.hidden);
    const row=mainRows(h)[0];chooseCharacter(row,'艾尔黛拉');
    assert(h.nodes.characterDialogError.hidden,'old save rejection clears on current input');
    assert(h.nodes.draftValidationSummary.textContent.includes('正在校验'));
    const first=await validationRequest(h),ledger=clearValidation(first);
    assert.equal(first.body.session.ledger.character.pools[0].events[0].identityReviewed,undefined);
    assert.equal(first.body.session.ledger.character.pools[0].eventReviewConfirmed,undefined);
    assert.equal(first.body.session.ledger.character.pools[0].events[0].identitySource,'manual');
    ledger.character.pools[0].issues=[{code:'quota_missing',severity:'error',message:'仍然缺少配额'}];
    first.resolve({ledger});await tick();
    assert(!h.nodes.review.textContent.includes('旧头像冲突'));assert(!h.nodes.currentGlobalIssues.textContent.includes('顶部汇总不一致'));
    assert(h.nodes.review.textContent.includes('仍然缺少配额'));assert(h.nodes.draftValidationSummary.textContent.includes('仍有'));
    assert.deepEqual(h.state(),before);assert.deepEqual(first.body.session.documents,before.documents);
    const input=findField(h.nodes.review,'武库配额');input.value='2560';input.oninput({target:input});
    const second=await validationRequest(h),clear=clearValidation(second);clear.character.pools[0].quota=99999;
    second.resolve({ledger:clear});await tick();
    assert(h.nodes.draftValidationSummary.textContent.includes('当前修改已通过校验，保存后生效'));
    assert(!h.nodes.review.textContent.includes('仍然缺少配额'));assert(h.nodes.review.textContent.includes('本池当前校验通过'));
    assert.equal(findField(h.nodes.review,'武库配额'),input,'server validation must retain the active input node');
    assert.equal(input.value,'2560');assert.equal(h.read('characterDraft.pools[0].quota'),2560);
    assert.deepEqual(h.state(),before);assert.equal(h.requests.filter(r=>r.url==='/api/score').length,0);
  });
  await test('numeric input immediately exposes new errors and debounces without duplicate change requests',async()=>{
    const h=await validationHarness(),input=findField(h.nodes.review,'武库配额');
    input.value='-1';input.oninput({target:input});assert(h.nodes.review.textContent.includes('非负整数'));
    assert(h.nodes.draftValidationSummary.textContent.includes('正在校验'));assert.equal(h.requests.filter(r=>r.url==='/api/validate').length,0);
    const first=await validationRequest(h);assert.equal(first.body.session.ledger.character.pools[0].quota,-1);
    input.onchange({target:input});h.flushTimers();await tick();assert.equal(h.requests.filter(r=>r.url==='/api/validate').length,1);
    first.resolve({ledger:clearValidation(first)});await tick();assert(!h.nodes.draftValidationSummary.textContent.includes('已通过'));
    input.value='5000';input.oninput({target:input});assert(!h.nodes.review.textContent.includes('非负整数'));
    assert(!h.nodes.draftValidationSummary.textContent.includes('已通过'),'passing requires the latest server response');
    const next=await validationRequest(h);next.resolve({ledger:clearValidation(next)});await tick();assert(h.nodes.draftValidationSummary.textContent.includes('已通过'));
  });
  await test('out of order validation cannot restore errors from an older edit',async()=>{
    const h=await validationHarness(),old=await validationRequest(h);
    setField(h.nodes.review,'武库配额',5180);const latest=await validationRequest(h);
    latest.resolve({ledger:clearValidation(latest)});await tick();const status=h.nodes.draftValidationSummary.textContent;
    const obsolete=clearValidation(old);obsolete.issues=[{severity:'error',message:'过期错误不应出现'}];old.resolve({ledger:obsolete});await tick();
    assert.equal(h.nodes.draftValidationSummary.textContent,status);assert(!h.nodes.currentGlobalIssues.textContent.includes('过期错误'));
    assert.equal(h.read('characterDraft.pools[0].quota'),5180);
  });
  await test('cancel restores saved issues and a late validation cannot change a reopened draft',async()=>{
    const saved=record('cancel-live');saved.ledger.issues=[{code:'source_conflict',severity:'error',message:'原有来源冲突'}];
    const h=await validationHarness(saved),before=h.state(),old=await validationRequest(h);
    h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);assert(h.nodes.currentGlobalIssues.textContent.includes('原有来源冲突'));
    h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5540);
    old.resolve({ledger:clearValidation(old)});await tick();
    assert(h.nodes.draftValidationSummary.textContent.includes('正在校验'));assert(h.nodes.currentGlobalIssues.textContent.includes('原有来源冲突'));
    assert.equal(h.read('characterDraft.pools[0].quota'),5540);assert.deepEqual(h.state(),before);
  });
  for(const sameId of [false,true])await test('late validation ignores '+(sameId?'a newer revision of the same record':'a different record'),async()=>{
    const h=await validationHarness(),old=await validationRequest(h),next=record(sameId?'live':'next');next.revision=2;
    h.ctx.loadSession(next);await tick();const before=h.state();h.nodes.openResults.click();
    const obsolete=clearValidation(old);obsolete.issues=[{severity:'error',message:'旧请求'}];old.resolve({ledger:obsolete});await tick();
    assert.deepEqual(h.state(),before);assert(!h.nodes.currentGlobalIssues.textContent.includes('旧请求'));
    assert(h.nodes.draftValidationSummary.textContent.includes('正在校验'));
  });
  for(const invalidReply of ['reject','missing-ledger'])await test('validation '+invalidReply+' never reports a false pass',async()=>{
    const h=await validationHarness(),request=await validationRequest(h);
    if(invalidReply==='reject')request.reject(Error('测试校验失败'));else request.resolve({});await tick();
    assert(h.nodes.draftValidationSummary.textContent.includes('校验未完成'));assert(!h.nodes.draftValidationSummary.textContent.includes('已通过'));
  });
  await test('server warnings remain visible while real errors retain blocking status',async()=>{
    const h=await validationHarness(),request=await validationRequest(h),ledger=clearValidation(request);
    ledger.character.pools[0].issues=[{severity:'warning',message:'需要保留的来源提示'}];
    ledger.weapon.issues=[{severity:'error',message:'武器来源冲突'}];request.resolve({ledger});await tick();
    assert(h.nodes.review.textContent.includes('需要保留的来源提示'));assert(h.nodes.weaponResultsPanel.hidden);
    assert(!h.nodes.draftValidationSummary.textContent.includes('仍有1项问题'));
  });
  await test('weapon inputs update the correction preview without replacing a focused table field',async()=>{
    const h=await validationHarness();h.nodes.resultsCancel.click();h.nodes.weaponConfigured.click();
    const input=findField(h.nodes.weaponReview,'当期专武数');input.value='3';input.oninput({target:input});
    assert(h.nodes.weaponReview.textContent.includes('当期专武数量不能超过六星武器数量'));
    input.value='1';input.oninput({target:input});const total=findField(h.nodes.weaponReview,'总专武种类');
    total.value='1';total.oninput({target:total});const request=await validationRequest(h);
    assert.equal(request.body.session.ledger.weapon.potentialConfig.totalTypes,1);
    request.resolve({ledger:clearValidation(request)});await tick();assert.equal(findField(h.nodes.weaponReview,'总专武种类'),total);
  });
  await test('each queue save refreshes committed issues and removes resolved future pages',async()=>{
    const saved=record('save-live',[erroneousPool('first',0),erroneousPool('second',1)]);
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'旧全局报错'}];
    const h=await validationHarness(saved);setField(h.nodes.review,'武库配额',5180);h.nodes.resultsApply.click();await tick();
    const request=h.pending.find(r=>r.url==='/api/validate');assert(request);const ledger=clearValidation(request);
    ledger.character.pools[1].issues=[{severity:'error',message:'第二池真实错误'}];request.resolve({ledger});await tick();
    assert.equal(h.state().ledger.issues.length,0);assert.equal(h.state().ledger.character.pools[0].issues.length,0);
    assert.equal(h.state().ledger.character.pools[1].issues[0].severity,'error');
    assert.equal(h.read('autoReviewQueue.some(item=>item.type==="info")'),false);
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].id'),'second');
    assert(!h.nodes.currentGlobalIssues.textContent.includes('旧全局报错'));assert.equal(h.requests.filter(r=>r.url==='/api/score').length,0);
  });
  for(const editedNext of [false,true])await test('a resolved current queue page is '+(editedNext?'retained when edited':'skipped when untouched'),async()=>{
    const saved=record('skip-live',[erroneousPool('first',0)]);saved.ledger.issues=[{severity:'error',message:'修复池数据即可消除'}];
    const h=await validationHarness(saved);h.nodes.resultsApply.click();await tick();
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'info');
    const request=h.pending.find(r=>r.url==='/api/validate');assert(request);
    if(editedNext)setField(h.nodes.review,'武库配额',5540);
    request.resolve({ledger:clearValidation(request)});await tick();
    assert.equal(h.nodes.resultsDialog.open,editedNext);
    assert.equal(h.requests.filter(r=>r.url==='/api/score').length,editedNext?0:1);
    if(editedNext){assert.equal(h.read('characterDraft.pools[0].quota'),5540);assert.equal(h.state().ledger.character.pools[0].quota,5000);}
  });
  await test('unknown pool and weapon evidence is never downgraded by saving corrections',async()=>{
    const saved=record('keep-evidence',[erroneousPool('first',0)],{N:60,K6:2,KU:1,B:1,issues:[{code:'unknown_source',severity:'error',message:'武器来源仍不明'}]});
    const h=await validationHarness(saved);setField(h.nodes.review,'武库配额',5180);h.nodes.resultsApply.click();await tick();
    assert.equal(h.state().ledger.character.pools[0].issues[0].severity,'error');
    setField(h.nodes.weaponReview,'当期专武数',2);h.nodes.resultsApply.click();await tick();
    assert.equal(h.state().ledger.weapon.issues[0].severity,'error');
  });
  await test('legacy placeholder is unconfirmed during preview and explicitly confirmed only by its pool save',async()=>{
    const saved=record('placeholder-live',[pool({issues:[{code:'placeholder_needs_review',severity:'error',message:'导入占位记录需确认'}]})]);
    const h=await validationHarness(saved),request=await validationRequest(h),p=request.body.session.ledger.character.pools[0];
    assert.equal(p.eventReviewConfirmed,undefined);assert.equal(p.events[0].identityReviewed,undefined);
    request.resolve({ledger:structuredClone(request.body.session.ledger)});await tick();
    assert(h.nodes.review.textContent.includes('导入占位记录需确认'));
    h.nodes.resultsApply.click();await tick();const score=h.pending.find(r=>r.url==='/api/score');assert(score);
    const submitted=score.body.session.ledger.character.pools[0];
    assert.equal(submitted.eventReviewConfirmed,true);assert.equal(submitted.events[0].identityReviewed,true);
    assert.equal(submitted.issues[0].severity,'error');assert.equal(submitted.issues[0].resolution,undefined);
    const response=structuredClone(score.body.session);response.ledger.character.pools[0].issues=[];score.resolve(response);await tick();
    h.nodes.openResults.click();assert(!h.nodes.review.textContent.includes('导入占位记录需确认'));
  });
  await test('saved current revalidation removes old global and pool errors when reopening',async()=>{
    const saved=record('reopen-live',[pool({issues:[{code:'event_needs_review',severity:'error',message:'待修正头像'}]})]);
    saved.ledger.issues=[{code:'character_summary_mismatch',severity:'error',message:'待修正顶部汇总'}];
    const h=await validationHarness(saved);chooseCharacter(mainRows(h)[0],'艾尔黛拉');
    const preview=await validationRequest(h);preview.resolve({ledger:clearValidation(preview)});await tick();
    h.nodes.resultsApply.click();await tick();const committed=h.pending.filter(r=>r.url==='/api/validate').at(-1);
    committed.resolve({ledger:clearValidation(committed)});await tick();
    const score=h.pending.find(r=>r.url==='/api/score');assert(score);const response=structuredClone(score.body.session);
    response.ledger=clearValidation(score);score.resolve(response);await tick();
    assert(!h.nodes.currentGlobalIssues.textContent.includes('待修正'));h.nodes.openResults.click();
    assert(!h.nodes.review.textContent.includes('待修正头像'));assert(!h.nodes.currentGlobalIssues.textContent.includes('待修正顶部汇总'));
    assert.equal(h.read('characterDraft.pools[0].events[0].character'),'艾尔黛拉');
  });
  const historyRow=(id,name=id)=>({id,name,updatedAt:1000});
  const historyHarness=async(rows=[historyRow('A'),historyRow('B')])=>{
    const h=await loaded();h.replies.set('/api/sessions',rows);h.nodes.openHistory.click();await tick();return h;
  };
  const chooseHistory=(h,id,checked=true)=>{
    const check=h.nodes.history.querySelectorAll('input').find(node=>node.dataset.sessionId===id);assert(check,'missing history checkbox '+id);
    check.checked=checked;check.onchange({target:check});return check;
  };
  const startDelete=async h=>{
    h.nodes.historyDelete.click();assert.equal(h.nodes.historyDeleteConfirmation.hidden,false);
    const finishing=h.nodes.historyDeleteConfirm.click();await tick();
    const request=h.pending.filter(item=>item.url==='/api/sessions/delete').at(-1);assert(request);return {request,finishing};
  };
  const restoreFile=(h,value,size=1024)=>{
    const target={files:[{size,text:async()=>JSON.stringify(value)}],value:'selected.json'};
    return {target,finishing:h.nodes.restoreFile.onchange({target})};
  };
  const importText=(h,text,name='export.txt',size=1024)=>{
    const target={files:[{name,size,text:async()=>text}],value:name};
    return {target,finishing:h.nodes.restoreFile.onchange({target})};
  };
  await test('TXT and foreign JSON use the record adapter without being mistaken for saved sessions',async()=>{
    for(const [name,text]of [['export.txt','角色：演示\n卡池：熔火灼痕'],['export.json','\uFEFF{"info":{"uid":"demo"},"list":[]}']]){
      const h=await historyHarness(),before=h.state(),{target,finishing}=importText(h,text,name);await tick();
      assert(h.nodes.restore.disabled);assert(h.nodes.import.disabled);assert(h.nodes.images.disabled);assert.deepEqual(h.state(),before);
      const request=h.pending.find(item=>item.url==='/api/records/import');assert(request);assert.equal(request.body.name,name);assert.equal(request.body.text,text.replace(/^\uFEFF/,''));
      assert.equal(h.requests.filter(item=>item.url==='/api/restore').length,0);
      const imported=record('imported-'+name);imported.documents=[{file:name,source_sha256:'synthetic-export'}];imported.importSummary={message:'已读取 60 抽。',warnings:['前期图鉴待确认。']};
      request.resolve(imported);await finishing;assert.equal(h.state().id,imported.id);assert.equal(target.value,'');assert(!h.nodes.restore.disabled);
      assert(h.nodes.historyDeleteFeedback.textContent.includes('已读取 60 抽'));assert(h.nodes.historyDeleteFeedback.textContent.includes('前期图鉴待确认'));
      assert(h.nodes.status.textContent.includes('已导入本机'));assert(!h.nodes.error.textContent.includes('不是有效的评分记录'));
    }
    assert(html.includes('accept=".txt,.json,text/plain,application/json"'));assert(html.includes('导入 TXT / JSON'));
  });
  await test('saved session JSON with a UTF-8 BOM still uses the original restore endpoint',async()=>{
    const h=await loaded(),saved=record('bom-session'),{finishing}=importText(h,'\uFEFF'+JSON.stringify(saved),'saved.json');await tick();
    const request=h.pending.find(item=>item.url==='/api/restore');assert(request);assert.deepEqual(request.body,saved);assert.equal(h.requests.filter(item=>item.url==='/api/records/import').length,0);
    request.resolve({...saved,id:'restored-bom'});await finishing;assert.equal(h.state().id,'restored-bom');
  });
  await test('unsupported third-party imports leave the current record intact and show a persistent error',async()=>{
    const h=await historyHarness(),before=h.state(),{finishing}=importText(h,'unsupported export');await tick();
    h.pending.find(item=>item.url==='/api/records/import').reject(Error('不支持此记录格式，请导出单抽明细。'));await finishing;h.advanceTimers(3500);
    assert.deepEqual(h.state(),before);assert(!h.nodes.historyDeleteFeedback.hidden);assert(h.nodes.historyDeleteFeedback.textContent.includes('不支持此记录格式'));
    assert(h.nodes.historyDeleteFeedback.classList.contains('has-error'));assert(!h.nodes.restore.disabled);
  });
  await test('history import opens the same author-contact popup for unknown formats',async()=>{
    const h=await historyHarness(),before=h.state(),{finishing}=importText(h,'{}','new-format.json');await tick();
    h.pending.find(r=>r.url==='/api/records/import').resolve({error:'暂不支持此记录格式，请联系作者协助适配。',code:'record_format_unrecognized'},false);
    await finishing;assert(h.nodes.recordFormatDialog.open);assert(h.nodes.historyDialog.open);
    assert(h.nodes.recordFormatFiles.textContent.includes('new-format.json'));assert.deepEqual(h.state(),before);
  });
  await test('damaged input and network errors do not trigger the unsupported-format popup',async()=>{
    for(const message of ['JSON 内容无效，请检查导出文件。','Failed to fetch']){
      const h=await loaded(),{finishing}=importText(h,'{broken','broken.json');await tick();
      h.pending.find(r=>r.url==='/api/records/import').reject(Error(message));await finishing;
      assert(!h.nodes.recordFormatDialog.open);assert(h.nodes.historyDeleteFeedback.textContent.includes(message));
    }
  });
  await test('oversized individual imports fail before sending record text',async()=>{
    const h=await loaded(),before=h.state(),{finishing}=importText(h,'{}','oversized.json',8*1024*1024+1);await finishing;
    assert.equal(h.requests.filter(item=>item.url==='/api/records/import'||item.url==='/api/restore').length,0);assert.deepEqual(h.state(),before);
    assert(h.nodes.historyDeleteFeedback.textContent.includes('超过8 MB'));
  });
  await test('collection import restores independent sessions with corrections intact and locks conflicting actions',async()=>{
    const h=await historyHarness(),records=['甲','乙','丙'].map((name,i)=>{
      const saved=record('source-'+i,[pool({quota:5000+i*180})]);saved.displayName=name;
      saved.ledger.weapon.profile='1';saved.ledger.character.pools[0].planningExempt=i===1;return saved;
    });
    const {target,finishing}=restoreFile(h,{schemaVersion:'gacha-rating-collection-v1',sessions:records});await tick();
    assert(h.read('restoring'));assert(h.nodes.import.disabled);assert(h.nodes.images.disabled);assert(h.nodes.restore.disabled);
    assert(h.nodes.openResults.disabled);assert(h.nodes.weaponConfigured.disabled);assert(h.nodes.historyDelete.disabled);
    assert(h.nodes.history.querySelectorAll('button').every(n=>n.disabled));
    const requestCount=h.requests.length;assert.equal(await h.ctx.openSavedSession('B'),false);h.nodes.import.click();
    assert.equal(h.requests.length,requestCount);escape(h.nodes.historyDialog);assert(h.nodes.historyDialog.open);
    for(let i=0;i<3;i++){
      const request=h.pending.filter(item=>item.url==='/api/restore')[i];assert(request);
      assert.deepEqual(request.body,records[i],'a collection must submit each complete record separately');
      assert.equal(h.pending.filter(item=>item.url==='/api/restore').length,i+1,'restores run sequentially');
      request.resolve({...structuredClone(records[i]),id:'restored-'+i});await tick();
    }
    await finishing;assert.equal(h.state().id,'restored-0');assert.equal(h.state().ledger.weapon.profile,'1');
    assert(h.nodes.status.textContent.includes('已恢复 3/3 份独立记录，0 份失败'));
    assert.equal(h.read('restoring'),false);assert.equal(target.value,'');assert(!h.nodes.restore.disabled);
    assert(h.requests.filter(item=>item.url==='/api/sessions').length>=3,'refresh includes newly saved records');
  });
  await test('collection preflight rejects a malformed later entry before saving any earlier record',async()=>{
    for(const sessions of [[record('valid'),{schemaVersion:'gacha-rating-session-v1',displayName:'坏记录',documents:[]}],[],Array.from({length:13},(_,i)=>record('source-'+i))]){
      const h=await loaded(),before=h.state();const {finishing}=restoreFile(h,{schemaVersion:'gacha-rating-collection-v1',sessions});
      await finishing;assert.equal(h.requests.filter(item=>item.url==='/api/restore').length,0);assert.deepEqual(h.state(),before);
      assert(!h.nodes.error.hidden);assert.equal(h.read('restoring'),false);assert(!h.nodes.restore.disabled);
      if(sessions.length===2)assert(h.nodes.error.textContent.includes('坏记录'));
    }
  });
  await test('collection partial failure continues later records and retains a persistent named failure report',async()=>{
    const h=await historyHarness(),records=['甲','乙','丙'].map((displayName,i)=>({...record('source-'+i),displayName}));
    const {finishing}=restoreFile(h,{schemaVersion:'gacha-rating-collection-v1',sessions:records});await tick();
    h.pending[0].resolve({...structuredClone(records[0]),id:'restored-0'});await tick();
    h.pending[1].reject(Error('源记录校验失败'));await tick();
    assert.equal(h.pending[2].body.displayName,'丙');h.pending[2].resolve({...structuredClone(records[2]),id:'restored-2'});
    await finishing;assert.equal(h.state().id,'restored-0');assert(h.nodes.status.textContent.includes('已恢复 2/3 份独立记录，1 份失败'));
    assert(h.nodes.error.textContent.includes('乙：源记录校验失败'));h.advanceTimers(3500);
    assert.equal(h.nodes.historyDeleteFeedback.hidden,false);assert(h.nodes.historyDeleteFeedback.textContent.includes('乙：源记录校验失败'));
    assert(h.nodes.historyDeleteFeedback.textContent.includes('成功记录已保留'));assert(h.nodes.historyDeleteFeedback.textContent.includes('只导入失败的记录'));
    assert.equal(h.requests.filter(item=>item.url==='/api/restore').length,3);
  });
  await test('single-session JSON remains compatible and failed collections leave the open record unchanged',async()=>{
    const h=await loaded(),saved=record('legacy-single');saved.ledger.weapon.profile='1';
    const single=restoreFile(h,saved);await tick();assert.deepEqual(h.pending[0].body,saved);
    h.pending[0].resolve({...structuredClone(saved),id:'restored-single'});await single.finishing;
    assert.equal(h.state().id,'restored-single');assert.equal(h.state().ledger.weapon.profile,'1');
    assert(h.nodes.status.textContent.includes('记录已恢复并按当前算法重算'));const before=h.state();
    const allFailed=restoreFile(h,{schemaVersion:'gacha-rating-collection-v1',sessions:[record('failed')]});await tick();
    h.pending[1].reject(Error('无法恢复'));await allFailed.finishing;assert.deepEqual(h.state(),before);
    assert(h.nodes.status.textContent.includes('已恢复 0/1 份独立记录，1 份失败'));assert(!h.nodes.restore.disabled);
  });
  await test('history shows every record and supports checkbox selection and select all without opening records',async()=>{
    const rows=Array.from({length:18},(_,i)=>historyRow('saved-'+i,'记录'+i)),h=await historyHarness(rows);
    assert.equal(h.nodes.history.querySelectorAll('input').length,18);assert(h.nodes.historySelectionCount.textContent.includes('共18份，已选0份'));
    assert(h.nodes.historyDelete.disabled);chooseHistory(h,'saved-17');assert(!h.nodes.historyDelete.disabled);
    assert(h.nodes.historySelectAll.indeterminate);assert.equal(h.state().id,'A');assert.equal(h.pending.length,0);
    h.nodes.historySelectAll.checked=true;h.nodes.historySelectAll.onchange();
    assert.equal(h.read('historySelected.size'),18);assert.equal(h.nodes.historySelectAllText.textContent,'取消全选');
    h.nodes.historySelectAll.checked=false;h.nodes.historySelectAll.onchange();assert.equal(h.read('historySelected.size'),0);assert(h.nodes.historyDelete.disabled);
  });
  await test('history deletion confirmation lists exact names and cancellation sends no request',async()=>{
    const h=await historyHarness([historyRow('A','甲记录'),historyRow('B','乙记录')]),before=h.state();chooseHistory(h,'A');chooseHistory(h,'B');h.nodes.historyDelete.click();
    assert(h.nodes.historyDeleteTitle.textContent.includes('2份'));assert.equal(h.nodes.historyDeleteNames.textContent,'甲记录乙记录');
    assert(html.includes('原图、裁片，无法恢复'));assert(html.includes('与其他记录共用的图片会保留'));
    assert(h.nodes.history.querySelectorAll('button').every(button=>button.disabled));h.nodes.historyDeleteCancel.click();
    assert(h.nodes.historyDeleteConfirmation.hidden);assert.equal(h.read('historySelected.size'),2);assert.deepEqual(h.state(),before);
    assert.equal(h.requests.filter(item=>item.url==='/api/sessions/delete').length,0);
    h.nodes.historyDelete.click();escape(h.nodes.historyDialog);assert(!h.nodes.historyDialog.open);assert(h.nodes.historyDeleteConfirmation.hidden);
    assert.equal(h.requests.filter(item=>item.url==='/api/sessions/delete').length,0);
  });
  await test('partial deletion removes successes and missing records while failed choices remain for retry',async()=>{
    const h=await historyHarness([historyRow('B','成功项'),historyRow('C','已不存在项'),historyRow('D','失败项')]);
    h.nodes.historySelectAll.checked=true;h.nodes.historySelectAll.onchange();const {request,finishing}=await startDelete(h);
    assert.deepEqual(request.body.ids,['B','C','D']);assert(h.nodes.historyDeleteConfirm.disabled);assert(h.nodes.historyDeleteCancel.disabled);
    request.resolve({deleted:['B'],missing:['C'],failed:[{id:'D',error:'文件正在使用'}]});await finishing;await tick();
    assert.equal(h.nodes.history.querySelectorAll('input').length,1);assert.equal(h.read('historySelected.has("D")'),true);
    assert(h.nodes.historyDeleteFeedback.textContent.includes('已删除1份'));assert(h.nodes.historyDeleteFeedback.textContent.includes('已不存在1份'));
    assert(h.nodes.historyDeleteFeedback.textContent.includes('失败项：文件正在使用'));assert(h.nodes.historySelectionCount.textContent.includes('共1份，已选1份'));
    assert.equal(h.state().id,'A');const retry=await startDelete(h);assert.deepEqual(retry.request.body.ids,['D']);
    retry.request.resolve({deleted:['D'],missing:[],failed:[]});await retry.finishing;await tick();
    assert.equal(h.read('historySelected.size'),0);assert(h.nodes.historyDelete.disabled);assert(h.nodes.history.textContent.includes('暂无本机记录'));
  });
  await test('deleting the current record clears drafts timers results and cannot be revived by late scoring or validation',async()=>{
    const h=await historyHarness();h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5180);
    h.ctx.calculate(false);await tick();const scoring=h.pending.find(item=>item.url==='/api/score');assert(scoring);
    h.flushTimers();await tick();h.nodes.openHistory.click();await tick();chooseHistory(h,'A');
    const {request,finishing}=await startDelete(h);request.resolve({deleted:['A'],missing:[],failed:[]});await finishing;await tick();
    assert.equal(h.state(),null);assert(h.nodes.workspace.hidden);assert.equal(h.read('characterDraft'),null);assert.equal(h.read('autoReviewQueue.length'),0);
    assert.equal(h.read('timer'),null);assert.equal(h.read('draftValidationTimer'),null);assert(h.nodes.save.disabled);assert(h.nodes.exportRadar.disabled);
    assert.equal(h.nodes.radar.textContent,'');assert(!h.nodes.sourceFiles);
    scoring.resolve(scoring.body.session);await tick();assert.equal(h.state(),null);assert(h.nodes.workspace.hidden);
    assert.equal(await h.ctx.openSavedSession('A'),false);assert.equal(h.ctx.loadSession(record('A')),false);assert.equal(h.state(),null);
  });
  await test('late history navigation cannot reopen a record deleted while the response was pending',async()=>{
    const h=await historyHarness(),opening=h.ctx.openSavedSession('B');await tick();const old=h.pending.find(item=>item.url==='/api/sessions/B');
    chooseHistory(h,'B');const {request,finishing}=await startDelete(h);request.resolve({deleted:['B'],missing:[],failed:[]});await finishing;
    old.resolve(record('B'));assert.equal(await opening,false);assert.equal(h.state().id,'A');assert(!h.nodes.history.textContent.includes('B'));
  });
  await test('older history list responses cannot reintroduce deleted rows',async()=>{
    const h=await historyHarness();h.replies.delete('/api/sessions');const oldRefresh=h.ctx.refreshHistory();await tick();
    const old=h.pending.find(item=>item.url==='/api/sessions');chooseHistory(h,'B');const {request,finishing}=await startDelete(h);
    request.resolve({deleted:['B'],missing:[],failed:[]});await tick();const current=h.pending.filter(item=>item.url==='/api/sessions').at(-1);assert.notEqual(current,old);
    current.resolve([historyRow('A')]);await finishing;old.resolve([historyRow('A'),historyRow('B')]);await oldRefresh;await tick();
    assert.equal(h.nodes.history.querySelectorAll('input').length,1);assert.equal(h.read('historyRows[0].id'),'A');
  });
  await test('a failed deletion preserves selected rows and the active record for retry',async()=>{
    const h=await historyHarness(),before=h.state();chooseHistory(h,'B');const {request,finishing}=await startDelete(h);
    request.reject(Error('服务暂时断开'));await finishing;assert.deepEqual(h.state(),before);assert.equal(h.read('historySelected.has("B")'),true);
    assert(h.nodes.historyDeleteFeedback.textContent.includes('服务暂时断开'));assert(!h.nodes.historyDelete.disabled);assert.equal(h.nodes.history.querySelectorAll('input').length,2);
  });
  await test('import and history deletion are mutually exclusive even for direct event invocation',async()=>{
    const h=await historyHarness();h.ctx.selected([{name:'new.png',size:1}]);const importing=h.nodes.import.click();await tick();
    const importRequest=h.pending.find(item=>item.url==='/api/import');assert(importRequest);chooseHistory(h,'B');assert(h.nodes.historyDelete.disabled);
    h.nodes.historyDelete.onclick();assert(h.nodes.historyDeleteConfirmation.hidden);assert.equal(h.requests.filter(item=>item.url==='/api/sessions/delete').length,0);
    h.replies.set('/api/jobs/job',{status:'error',message:'测试停止',items:[]});importRequest.resolve({id:'job'});await importing;
    const {request,finishing}=await startDelete(h);assert(h.nodes.import.disabled);assert(h.nodes.restore.disabled);assert(h.nodes.openResults.disabled);
    await h.nodes.import.onclick();assert.equal(h.requests.filter(item=>item.url==='/api/import').length,1);
    assert.equal(await h.ctx.openSavedSession('B'),false);escape(h.nodes.historyDialog);assert(h.nodes.historyDialog.open);
    request.resolve({deleted:['B'],missing:[],failed:[]});await finishing;assert(!h.nodes.import.disabled);assert(!h.nodes.restore.disabled);
  });
  await test('delete limit explains how to split an oversized selection without making a request',async()=>{
    const rows=Array.from({length:1001},(_,i)=>historyRow('many-'+i)),h=await historyHarness(rows);
    h.nodes.historySelectAll.checked=true;h.nodes.historySelectAll.onchange();h.nodes.historyDelete.click();
    assert(h.nodes.historyDeleteConfirmation.hidden);assert(h.nodes.historyDeleteFeedback.textContent.includes('一次最多删除1000份记录'));
    assert.equal(h.requests.filter(item=>item.url==='/api/sessions/delete').length,0);assert.equal(h.read('historySelected.size'),1001);
  });
  const addManual=(h,index)=>{
    setField(h.nodes.manualPoolTools,'漏识别的卡池',index);findButton(h.nodes.manualPoolTools,'补充漏识别卡池').click();
    const added=JSON.parse(h.read('JSON.stringify(characterDraft.pools.find(p=>p.index==='+index+'))'));assert(added);return added;
  };
  const poolElement=(h,id)=>h.nodes.review.querySelectorAll('details').find(node=>node.dataset.poolId===id);
  await test('manual pool picker excludes existing banners and opens a blank editable pool without saving',async()=>{
    const h=await loaded(),before=h.state();h.nodes.openResults.click();
    const options=findField(h.nodes.manualPoolTools,'漏识别的卡池').querySelectorAll('option');
    assert(!options.some(option=>option.value==='0'));assert.equal(options.length,h.read('edit.BANNERS.length'));
    assert(options.some(option=>option.textContent.includes('烟火邀星河')));
    const added=addManual(h,1),block=poolElement(h,added.id);assert(block.open);assert(findField(block,'主池总抽数').focused);
    assert.equal(added.total,null);assert.equal(added.quota,null);assert.equal(added.tail,null);assert.equal(added.rushUsed,null);assert.equal(added.initialPity,10);
    assert.equal(added.evidence.manual,true);assert.equal(added.events.length,0);assert(block.textContent.includes('补充出货记录'));
    assert(block.textContent.includes('移除手动补充池'));assert(!poolElement(h,'p0').textContent.includes('移除手动补充池'));
    assert.deepEqual(h.state(),before);h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
  });
  await test('manual pool with no six star hits remains editable and is sorted into the saved ledger',async()=>{
    const h=await loaded();h.nodes.openResults.click();const added=addManual(h,1);let block=poolElement(h,added.id);
    setField(block,'主池总抽数',20);setField(block,'武库配额',800);setField(block,'加急使用状态','false');block=poolElement(h,added.id);
    assert.equal(findField(block,'期末水位').value,30);assert(block.textContent.includes('补充出货记录'));
    h.nodes.resultsApply.click();h.flushTimers();await tick();const request=h.pending.find(item=>item.url==='/api/score');assert(request);
    const pools=request.body.session.ledger.character.pools;assert.deepEqual(pools.map(item=>item.index),[0,1]);assert.equal(pools[1].events.length,0);
    assert.equal(pools[1].total,20);assert.equal(pools[1].evidence.manual,true);assert.equal(pools[1].initialPity,10);
  });
  await test('supplementing the first pool from the history question immediately opens its editable fields',async()=>{
    const h=harness();await tick();const saved=record('history-add',[pool({id:'later',index:1,banner:'轻飘飘的信使',up:'洁尔佩塔',initialPity:null})]);
    saved.ledger.character.completeHistory=false;saved.ledger.character.initialPity=null;saved.ledger.character.initialOwned=null;
    h.ctx.loadSession(saved);await tick();assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'history');
    const before=h.state(),added=addManual(h,0);let block=poolElement(h,added.id);assert(block);assert(block.open);
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'pool');assert.equal(h.read('autoReviewQueue[autoReviewIndex].id'),added.id);
    setField(block,'主池总抽数',5);setField(block,'武库配额',100);setField(block,'加急使用状态','false');block=poolElement(h,added.id);
    assert(block);assert(block.open);assert.equal(findField(block,'主池总抽数').value,5);assert.equal(findField(block,'期末水位').value,5);
    findButton(block,'移除手动补充池').click();assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'history');
    assert.equal(h.read('characterDraft.pools.some(p=>p.index===0)'),false);
    h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
  });
  await test('manual pool removal updates available banners and does not delete an OCR pool',async()=>{
    const h=await loaded();h.nodes.openResults.click();const added=addManual(h,2);
    findButton(poolElement(h,added.id),'移除手动补充池').click();assert.equal(h.read('characterDraft.pools.length'),1);
    assert(findField(h.nodes.manualPoolTools,'漏识别的卡池').querySelectorAll('option').some(option=>option.value==='2'));
    assert(!h.nodes.review.querySelectorAll('button').some(button=>button.textContent==='移除手动补充池'));
    assert.equal(h.read('edit.removeManualPool(characterDraft,"p0")'),false);
  });
  await test('new main and rush rows in manually supplemented pools carry manual identity evidence',async()=>{
    const h=await loaded();h.nodes.openResults.click();const added=addManual(h,1);let block=poolElement(h,added.id);
    setField(block,'主池总抽数',40);findButton(block,'补充出货记录').click();block=poolElement(h,added.id);
    const row=block.querySelectorAll('tr').find(row=>row.children[0]?.textContent==='主池');setField(row,'累计抽数',25);chooseCharacter(row,'洁尔佩塔');
    findButton(block,'补充加急出货').click();
    const p=JSON.parse(h.read('JSON.stringify(characterDraft.pools.find(p=>p.index===1))'));
    assert.equal(p.events[0].identitySource,'manual');assert.equal(p.events[0].character,'洁尔佩塔');assert.equal(p.rush[0].identitySource,'manual');
    assert.equal(p.events[0].identityReviewed,undefined);assert.equal(p.eventReviewConfirmed,undefined);
  });
  await test('only the true latest pool detail offers hypothesis settings even when its zero loss is outside top five',async()=>{
    const h=await loaded(),saved=record('hyp-last',[pool({id:'later',index:2,initialPity:10,banner:'末池'}),pool()]);
    saved.result.planning={pools:[{id:'p0',banner:'首池',status:'ok',localLoss:100},{id:'later',banner:'末池',status:'ok',localLoss:0}]};
    h.ctx.loadSession(saved);assert(h.nodes.scoringScenario.hidden);assert(!h.nodes.scoringScenario.querySelector('input'));
    findButton(h.nodes.planningTopPools,'详情').click();assert(h.nodes.scoringScenario.hidden);escape(h.nodes.planningDetailDialog);
    h.nodes.openAllPlanning.click();const lastRow=h.nodes.planning.querySelectorAll('tr').find(row=>row.children[0]?.textContent==='末池');findButton(lastRow,'详情').click();
    assert(!h.nodes.scoringScenario.hidden);assert(h.nodes.scoringScenario.querySelector('input'));assert(h.nodes.planningDetailTitle.textContent.includes('末池'));
    escape(h.nodes.planningDetailDialog);h.ctx.openPlanningDetail(saved.result.planning.pools[0]);assert(h.nodes.scoringScenario.hidden);assert(!h.nodes.scoringScenario.querySelector('input'));
    h.ctx.openPlanningDetail(saved.result.planning.pools[1]);assert(!h.nodes.scoringScenario.hidden);assert(!h.nodes.scoringScenario.querySelector('input').checked);
    h.nodes.openResults.click();assert(!h.nodes.review.querySelectorAll('button').some(button=>button.textContent==='假设补到保底'));
  });
  const hypothesisPlan=(extra={})=>({hypothesis:true,poolId:'p0',mode:'first-up-120',fromTotal:60,toTotal:120,addedDraws:60,additionalFiveMax:58,
    events:[{at:80,character:null,forced:false,requiredChoice:true,allowedCharacters:['骏卫','余烬']},
      {at:120,character:'莱万汀',forced:true,requiredChoice:false,allowedCharacters:['莱万汀']}],...extra});
  const hypothesisScore=(score=50,loss=20)=>({axes:scoredAxes({characterSix:score,up:score+1,limited:score+2,five:score+3}),planning:{pools:[{id:'p0',status:'ok',localLoss:loss,opportunity:{status:'ok',value:5}}]}});
  const hypothesisHarness=async()=>{
    const h=await loaded();h.ctx.loadSession(record('hyp-live',[pool({events:[{at:50,character:'骏卫',source:'main'}]})]));h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5180);
    const saved=h.state(),draft=h.read('JSON.stringify(characterDraft)');h.ctx.openLatestPlanningDetail();findButton(h.nodes.scoringScenario,'配置假设条件').click();await tick();
    const plan=h.pending.filter(item=>item.url==='/api/hypothesis/plan').at(-1);assert(plan);return {h,plan,saved,draft};
  };
  const readyHypothesis=async()=>{
    const fixture=await hypothesisHarness();fixture.plan.resolve({plan:hypothesisPlan(),notices:['第80抽需假设一次歪出。']});await tick();return fixture;
  };
  await test('hypothesis plans use the saved real record and never submit unrelated draft edits',async()=>{
    const {h,plan,saved,draft}=await hypothesisHarness();assert(h.nodes.hypothesisDialog.open);
    assert.equal(plan.body.session.ledger.character.pools[0].quota,5000);assert.equal(saved.ledger.character.pools[0].quota,5000);
    assert.equal(plan.body.mode,'first-up-120');assert.equal(h.requests.filter(item=>item.url==='/api/score').length,0);
    plan.resolve({plan:hypothesisPlan(),notices:[]});await tick();assert(h.nodes.hypothesisPlan.textContent.includes('新增 60 抽'));
    assert(h.nodes.hypothesisChoices.textContent.includes('第120抽：莱万汀'));
    assert(h.nodes.hypothesisChoices.children[0].textContent.includes('第80抽'));assert(h.nodes.hypothesisChoices.children[1].textContent.includes('第120抽'));
    assert.equal(h.read('JSON.stringify(characterDraft)'),draft);assert.deepEqual(h.state(),saved);
    escape(h.nodes.hypothesisDialog);assert(!h.nodes.hypothesisDialog.open);assert(h.nodes.resultsDialog.open);assert.deepEqual(h.state(),saved);assert.equal(h.read('JSON.stringify(characterDraft)'),draft);
  });
  await test('hypothesis requires allowed intermediate identities and omits five star scoring by default',async()=>{
    const {h,saved,draft}=await readyHypothesis();h.nodes.hypothesisPreview.click();assert(h.nodes.hypothesisError.textContent.includes('请选择第80抽'));
    assert.equal(h.requests.filter(item=>item.url==='/api/hypothesis/preview').length,0);
    const picker=findField(h.nodes.hypothesisChoices,'第80抽');assert(!picker.querySelectorAll('option').some(option=>option.value==='莱万汀'));
    picker.value='骏卫';picker.onchange();const previewing=h.nodes.hypothesisPreview.click();await tick();const request=h.pending.find(item=>item.url==='/api/hypothesis/preview');
    assert.deepEqual(request.body.choices,{'80':'骏卫'});assert.equal(request.body.additionalFive,null);
    request.resolve({before:hypothesisScore(),after:{...hypothesisScore(60,25),hypothesis:true},notices:[]});await previewing;
    const text=h.nodes.hypothesisComparison.textContent;assert(text.includes('角色六星'));assert(text.includes('当期UP'));assert(text.includes('限定'));assert(text.includes('资源损耗'));assert(text.includes('机会估值'));
    const rows=h.nodes.hypothesisComparison.querySelectorAll('tr');assert(!rows.some(row=>row.children[0]?.textContent==='角色五星'));assert(text.includes('本次不比较角色五星评分'));
    assert.deepEqual(h.state(),saved);assert.equal(h.read('JSON.stringify(characterDraft)'),draft);assert.equal(h.requests.filter(item=>item.url==='/api/score').length,0);
  });
  await test('optional five star input survives a pending plan and enables only an explicit five star comparison',async()=>{
    const {h,plan}=await hypothesisHarness(),input=findField(h.nodes.hypothesisControls,'新增五星数');
    input.value='0';input.oninput();plan.resolve({plan:hypothesisPlan({events:[]}),notices:[]});await tick();assert(!h.nodes.hypothesisPreview.disabled);
    const previewing=h.nodes.hypothesisPreview.click();await tick();const request=h.pending.find(item=>item.url==='/api/hypothesis/preview');assert.equal(request.body.additionalFive,0);
    request.resolve({before:hypothesisScore(),after:hypothesisScore(55),notices:[]});await previewing;
    assert(h.nodes.hypothesisComparison.querySelectorAll('tr').some(row=>row.children[0]?.textContent==='角色五星'));
    assert.equal(findField(h.nodes.hypothesisControls,'新增五星数'),input);assert.equal(input.value,'0');
  });
  await test('hypothesis input invalidates pending previews so obsolete results do not appear',async()=>{
    const {h}=await readyHypothesis();setField(h.nodes.hypothesisChoices,'第80抽','骏卫');const previewing=h.nodes.hypothesisPreview.click();await tick();
    const request=h.pending.find(item=>item.url==='/api/hypothesis/preview');setField(h.nodes.hypothesisControls,'新增五星数',2);
    request.resolve({before:hypothesisScore(),after:hypothesisScore(99),notices:[]});await previewing;
    assert.equal(h.nodes.hypothesisComparison.textContent,'');assert(h.nodes.hypothesisStatus.textContent.includes('条件已更新'));assert(!h.nodes.hypothesisPreview.disabled);
  });
  await test('hypothesis mode changes ignore an older plan and do not allow stale choices through',async()=>{
    const {h,plan}=await hypothesisHarness();setField(h.nodes.hypothesisControls,'假设目标','next-six-80');await tick();const latest=h.pending.filter(item=>item.url==='/api/hypothesis/plan').at(-1);
    latest.resolve({plan:hypothesisPlan({mode:'next-six-80',toTotal:80,addedDraws:20,events:[{at:80,requiredChoice:true,allowedCharacters:['莱万汀','骏卫']}]}),notices:[]});await tick();
    plan.resolve({plan:hypothesisPlan(),notices:['过期计划不可显示']});await tick();assert(h.nodes.hypothesisPlan.textContent.includes('新增 20 抽'));
    assert(!h.nodes.hypothesisNotices.textContent.includes('过期计划'));assert(findField(h.nodes.hypothesisChoices,'第80抽').querySelectorAll('option').some(option=>option.value==='莱万汀'));
  });
  for(const action of ['close','switch-record'])await test('late hypothesis response is discarded after '+action,async()=>{
    const {h,plan}=await hypothesisHarness();if(action==='close')escape(h.nodes.hypothesisDialog);else h.ctx.loadSession(record('new-hyp-record'));
    const before=h.state();plan.resolve({plan:hypothesisPlan(),notices:['迟到计划']});await tick();
    assert(!h.nodes.hypothesisDialog.open);assert.equal(h.read('hypothesis'),null);assert.deepEqual(h.state(),before);assert(!h.nodes.hypothesisNotices.textContent.includes('迟到计划'));
  });
  await test('hypothesis errors are specific and invalid optional counts never call preview',async()=>{
    const {h,plan}=await hypothesisHarness();plan.reject(Error('当前水位未知，请先填写期末水位。'));await tick();
    assert(h.nodes.hypothesisError.textContent.includes('当前水位未知'));assert(h.nodes.hypothesisPreview.disabled);
    setField(h.nodes.hypothesisControls,'假设目标','next-six-80');await tick();const next=h.pending.filter(item=>item.url==='/api/hypothesis/plan').at(-1);
    next.resolve({plan:hypothesisPlan({events:[],additionalFiveMax:20}),notices:[]});await tick();
    for(const value of [-1,1.5,21]){setField(h.nodes.hypothesisControls,'新增五星数',value);h.nodes.hypothesisPreview.click();assert(!h.nodes.hypothesisError.hidden);}
    assert.equal(h.requests.filter(item=>item.url==='/api/hypothesis/preview').length,0);
  });
  await test('a pool with an existing main UP starts with the next six star mode',async()=>{
    const h=await loaded();h.ctx.openLatestPlanningDetail();findButton(h.nodes.scoringScenario,'配置假设条件').click();await tick();
    assert.equal(h.pending.find(item=>item.url==='/api/hypothesis/plan').body.mode,'next-six-80');
  });
  await test('optional five star count respects plan bounds while leaving it empty remains allowed',async()=>{
    const {h,plan}=await hypothesisHarness();plan.resolve({plan:hypothesisPlan({events:[],additionalFiveMin:5,additionalFiveMax:58}),notices:[]});await tick();
    const input=findField(h.nodes.hypothesisControls,'新增五星数');assert.equal(input.min,5);assert.equal(input.max,58);assert(h.nodes.hypothesisPlan.textContent.includes('5—58'));
    input.value='0';input.oninput();h.nodes.hypothesisPreview.click();assert(h.nodes.hypothesisError.textContent.includes('至少需要5个'));
    assert.equal(h.requests.filter(item=>item.url==='/api/hypothesis/preview').length,0);
    input.value='';input.oninput();const previewing=h.nodes.hypothesisPreview.click();await tick();const preview=h.pending.find(item=>item.url==='/api/hypothesis/preview');
    assert.equal(preview.body.additionalFive,null);preview.reject(Error('测试后端错误'));await previewing;
    assert(h.nodes.hypothesisError.textContent.includes('测试后端错误'));assert.equal(h.nodes.hypothesisComparison.textContent,'');
  });
  const unknownCard=()=>({id:'abc:card-bottom',cardId:'card-bottom',bannerRaw:'熔业约痘',source_sha256:'abc',file:'fixture.png',
    total:122,tail:2,quota:10200,initialPity:null,rushUsed:true,rushAt:30,rush:[],tokens:[],
    events:[{at:71,character:'伊冯',source:'main',forced:false,identitySource:'avatar',evidence:{cardEventId:'bottom-1',raw:'71抽歪限定',interval:71,crop:'/data/fixture/off.png'}},
      {at:120,character:'莱万汀',source:'main',forced:false,identitySource:'avatar',evidence:{cardEventId:'bottom-2',raw:'49抽',interval:49,crop:'/data/fixture/up.png'}}],
    evidence:{crop:'/data/fixture/unknown-card.png',sourceImage:'/data/fixture/source.png'}});
  const unknownHarness=async(config={})=>{
    const h=harness(config);await tick();const saved=record('unknown-card',[pool({id:'light',index:1,banner:'轻飘飘的信使',up:'洁尔佩塔',total:76,initialPity:2,tail:4,quota:5500,
      events:[{at:72,character:'洁尔佩塔',source:'main'}]})]);
    saved.ledger.character.completeHistory=false;saved.ledger.character.initialPity=2;saved.ledger.character.initialOwned=null;
    saved.ledger.unresolvedCards=[unknownCard()];saved.ledger.issues=[{code:'unrecognized_pool_card',severity:'error',message:'卡片名称尚未确认',cardId:'abc:card-bottom'}];
    h.ctx.loadSession(saved);await tick();return h;
  };
  const assignUnknown=h=>{
    setField(h.nodes.unresolvedPoolCards,'这张卡片对应的卡池',0);findButton(h.nodes.unresolvedPoolCards,'使用所选卡池并检查明细').click();
    return JSON.parse(h.read('JSON.stringify(characterDraft.pools.find(p=>p.index===0))'));
  };
  await test('unrecognized cards display their separate cumulative rows and allow only unoccupied banners',async()=>{
    const h=await unknownHarness();assert(!h.nodes.unresolvedPoolCards.hidden);assert(h.nodes.unresolvedPoolCards.textContent.includes('熔业约痘'));
    assert(h.nodes.unresolvedPoolCards.textContent.includes('122'));assert(h.nodes.unresolvedPoolCards.textContent.includes('10200'));
    const rows=h.nodes.unresolvedPoolCards.querySelectorAll('tr');assert.equal(rows[1].children[1].textContent,'71');assert.equal(rows[2].children[1].textContent,'120');
    assert.equal(h.nodes.unresolvedPoolCards.querySelector('img').src,'/data/fixture/unknown-card.png');
    const options=findField(h.nodes.unresolvedPoolCards,'这张卡片对应的卡池').querySelectorAll('option');assert(!options.some(option=>option.value==='1'));assert(options.some(option=>option.value==='0'));
    assert(findButton(h.nodes.unresolvedPoolCards,'使用所选卡池并检查明细').disabled);
  });
  await test('assigning an isolated card moves complete evidence into the draft without guessing identities or saving',async()=>{
    const h=await unknownHarness(),before=h.state(),added=assignUnknown(h);
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'pool');assert.equal(h.read('autoReviewQueue[autoReviewIndex].id'),added.id);
    assert(poolElement(h,added.id).open);assert(h.nodes.unresolvedPoolCards.hidden);assert(h.nodes.resultsSaveHint.textContent.includes('确认本池'));
    assert.equal(added.total,122);assert.equal(added.tail,2);assert.equal(added.quota,10200);assert.equal(added.initialPity,0);assert.equal(added.rushUsed,true);
    assert.equal(added.evidence.manual,true);assert.equal(added.evidence.unresolvedCardId,'abc:card-bottom');assert.equal(added.evidence.source_sha256,'abc');
    assert.deepEqual(added.events,unknownCard().events);assert.equal(added.events[0].identityReviewed,undefined);assert.equal(added.eventReviewConfirmed,undefined);
    assert.deepEqual(h.state(),before);assert.equal(h.requests.filter(request=>request.url==='/api/score').length,0);
    h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);assert.equal(h.read('characterDraft'),null);
  });
  await test('removing an incorrectly assigned pool restores the original unknown card for another selection',async()=>{
    const h=await unknownHarness(),before=h.state(),added=assignUnknown(h);
    findButton(poolElement(h,added.id),'移除手动补充池').click();assert(!h.nodes.unresolvedPoolCards.hidden);
    assert(h.nodes.unresolvedPoolCards.textContent.includes('71抽歪限定'));assert.equal(h.read('characterDraft.pools.length'),1);
    assert.equal(h.read('autoReviewQueue[autoReviewIndex].type'),'history');assert.deepEqual(h.state(),before);
  });
  await test('saving a bound card confirms its visible rows and current validation removes the unknown-card prompt',async()=>{
    const h=await unknownHarness({manualValidation:true}),added=assignUnknown(h);h.nodes.resultsApply.click();await tick();
    const validation=h.pending.find(request=>request.url==='/api/validate');assert(validation);
    const submitted=validation.body.session.ledger.character.pools.find(pool=>pool.id===added.id);
    assert.equal(submitted.events[0].identityReviewed,true);assert.equal(submitted.eventReviewConfirmed,true);assert.equal(submitted.events[1].forced,true);
    assert.equal(submitted.events[0].evidence.cardEventId,'bottom-1');assert.equal(submitted.events[1].evidence.interval,49);
    const ledger=clearValidation(validation);validation.resolve({ledger});await tick();
    assert(!h.nodes.resultsDialog.open);const score=h.pending.find(request=>request.url==='/api/score');assert(score);
    const response=structuredClone(score.body.session);response.ledger=ledger;score.resolve(response);await tick();
    h.nodes.openResults.click();assert(h.nodes.unresolvedPoolCards.hidden);assert.equal(h.state().ledger.unresolvedCards.length,1);
    findButton(poolElement(h,added.id),'移除手动补充池').click();assert(!h.nodes.unresolvedPoolCards.hidden);
    assert.equal(h.state().ledger.character.pools.length,2,'unbinding is still only a draft edit');
  });
  await test('a bound card with an unidentified row cannot be silently confirmed by choosing a pool',async()=>{
    const h=await unknownHarness();h.read('session.ledger.unresolvedCards[0].events[0].character=null');h.ctx.renderCharacterReview();const before=h.state(),added=assignUnknown(h);
    assert.equal(added.events[0].character,null);assert.equal(added.events[0].identityReviewed,undefined);
    h.nodes.resultsApply.click();assert(h.nodes.resultsDialog.open);assert(!h.nodes.characterDialogError.hidden);assert.deepEqual(h.state(),before);
    assert.equal(h.requests.filter(request=>request.url==='/api/score').length,0);
  });
  await test('unknown cards remain actionable even without a cached root diagnostic',async()=>{
    const h=await loaded(),saved=record('unknown-no-issue');saved.ledger.unresolvedCards=[{...unknownCard(),id:'abc:other'}];saved.ledger.issues=[];
    h.ctx.loadSession(saved);await tick();assert(h.nodes.resultsDialog.open);assert(!h.nodes.unresolvedPoolCards.hidden);assert.equal(h.read('autoReviewQueue.at(-1).type'),'info');
  });
  await test('unknown cards never offer to overwrite or merge into an already occupied full banner list',async()=>{
    const h=await loaded(),pools=h.read('edit.BANNERS.map((banner,index)=>({id:"all-"+index,index,banner,up:edit.LIMITED[index],total:60,initialPity:index?10:0,tail:10,quota:5000,events:[{at:50,character:edit.LIMITED[index],source:"main"}],rushUsed:true,rushAt:30,rush:[],tokens:[],ended:true,issues:[]}))');
    const saved=record('all-banners',JSON.parse(JSON.stringify(pools)));saved.ledger.unresolvedCards=[unknownCard()];h.ctx.loadSession(saved);await tick();
    assert(h.nodes.unresolvedPoolCards.textContent.includes('支持的卡池均已有记录'));assert.equal(h.nodes.unresolvedPoolCards.querySelectorAll('select').length,0);
    assert.equal(h.state().ledger.character.pools.length,h.read('edit.BANNERS.length'));
  });
  const exemptionHarness=async(extra={})=>{
    const h=await loaded(),saved=record('exemption');saved.result.axes=scoredAxes();saved.result.scoredAxes=6;
    saved.result.planning={pools:[{id:'p0',banner:'熔火灼痕',status:'ok',localLoss:170.56,countedLoss:170.56,planningExempt:false,exemptedLoss:0,
      permanentDelta:180,waterValueDelta:9.44,rewardValueDelta:0,opportunity:{status:'ok',value:12},...extra}]};
    if(extra.planningExempt)saved.ledger.character.pools[0].planningExempt=true;
    h.ctx.loadSession(saved);h.nodes.revealLuck.click();h.ctx.openPlanningDetail(h.state().result.planning.pools[0]);return h;
  };
  const exemptionChoice=h=>findField(h.nodes.planningExemption,'豁免此项亏损');
  const toggleExemption=(h,checked)=>{const input=exemptionChoice(h);input.checked=checked;return input.onchange();};
  const finishExemption=async(h)=>{
    const request=h.pending.filter(p=>p.url==='/api/score').at(-1),updated=structuredClone(request.body.session);
    for(const row of updated.result.planning.pools){row.planningExempt=updated.ledger.character.pools.find(p=>p.id===row.id).planningExempt;
      row.countedLoss=row.status==='ok'?(row.planningExempt&&row.localLoss>0?0:row.localLoss):null;
      row.exemptedLoss=row.status==='ok'&&row.planningExempt&&row.localLoss>0?row.localLoss:0;}
    request.resolve(updated);await tick();return updated;
  };
  await test('loss exemption auto saves only the flag and immediately refreshes total title and top five',async()=>{
    const h=await exemptionHarness(),before=h.state();assert.equal(h.requests.filter(p=>p.url==='/api/score').length,0);
    assert(h.nodes.planningHighlights.textContent.includes('170.56'));assert(!exemptionChoice(h).checked);
    const saving=toggleExemption(h,true);await tick();assert(exemptionChoice(h).disabled);assert(exemptionChoice(h).checked);assert(h.nodes.planningDetailContent.textContent.includes('正在保存'));
    assert.deepEqual(h.state(),before,'formal result is unchanged until the save succeeds');
    const request=h.pending.find(p=>p.url==='/api/score');assert.equal(request.body.session.reviewed,true);assert.equal(request.body.session.revision,2);
    assert.equal(request.body.session.ledger.character.pools[0].planningExempt,true);
    await finishExemption(h);await saving;
    assert(h.nodes.planningHighlights.textContent.includes('自律狂人'));assert(h.nodes.planningHighlights.textContent.includes('0.00'));
    assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length,0);assert(h.nodes.planning.textContent.includes('已豁免'));
    assert(h.nodes.planningDetailTitle.textContent.includes('资源损耗 0.00 抽'));assert(!exemptionChoice(h).disabled);
    assert(h.nodes.planningDetailDialog.open);assert.equal(h.read('luckRevealed'),true);assert.deepEqual(h.state().result.axes,before.result.axes);
    assert.equal(h.state().result.planning.pools[0].opportunity.value,12);assert.equal(h.state().reviewed,true);
  });
  await test('an exempted pool remains available in the full list and can be restored repeatedly',async()=>{
    const h=await exemptionHarness();toggleExemption(h,true);await tick();await finishExemption(h);escape(h.nodes.planningDetailDialog);
    h.nodes.openAllPlanning.click();findButton(h.nodes.planning,'详情').click();assert(exemptionChoice(h).checked);
    toggleExemption(h,false);await tick();await finishExemption(h);
    assert.equal(h.state().revision,3);assert.equal(h.state().ledger.character.pools[0].planningExempt,false);
    assert(h.nodes.planningHighlights.textContent.includes('上头豪客'));assert.equal(h.nodes.planningTopPools.querySelectorAll('button').length,1);
    assert(!h.nodes.planning.textContent.includes('已豁免'));assert(!exemptionChoice(h).checked);
  });
  await test('failed exemption restores the checkbox and saved result and allows retry without double posting',async()=>{
    const h=await exemptionHarness(),before=h.state(),saving=toggleExemption(h,true);await tick();
    h.ctx.setPlanningExemption('p0',false);assert.equal(h.requests.filter(p=>p.url==='/api/score').length,1);
    assert(h.nodes.save.disabled);assert(h.nodes.resultsApply.disabled);assert(h.nodes.restore.disabled);assert(h.nodes.weaponConfigured.disabled);
    h.pending.find(p=>p.url==='/api/score').reject(Error('测试写入失败'));await saving;
    assert.deepEqual(h.state(),before);assert(!exemptionChoice(h).checked);assert(!exemptionChoice(h).disabled);
    assert(h.nodes.planningDetailContent.textContent.includes('测试写入失败'));assert(h.nodes.planningHighlights.textContent.includes('170.56'));
    assert.equal(h.read('luckRevealed'),true);assert(!h.nodes.save.disabled);assert(!h.nodes.resultsApply.disabled);
    toggleExemption(h,true);await tick();assert.equal(h.requests.filter(p=>p.url==='/api/score').length,2);await finishExemption(h);
  });
  for(const sameId of [false,true])await test('late exemption response does not replace '+(sameId?'reopened same':'another')+' record',async()=>{
    const h=await exemptionHarness(),saving=toggleExemption(h,true);await tick();h.ctx.loadSession(record(sameId?'exemption':'new-exemption'));
    const before=h.state();await finishExemption(h);await saving;assert.deepEqual(h.state(),before);assert(!h.nodes.planningDetailDialog.open);
    assert.equal(h.read('planningExemptionRequest'),null);assert(!h.nodes.restore.disabled);
  });
  await test('exemption save preserves unrelated draft input and keeps the editor current for its next save',async()=>{
    const h=await exemptionHarness();h.nodes.openResults.click();setField(h.nodes.review,'武库配额',5010);
    toggleExemption(h,true);await tick();await finishExemption(h);
    assert.equal(h.state().ledger.character.pools[0].quota,5000);assert.equal(h.read('characterDraft.pools[0].quota'),5010);
    assert.equal(h.read('characterDraft.pools[0].planningExempt'),true);assert.equal(h.read('dialogIsCurrent()'),true);
    assert.equal(h.read('JSON.parse(draftOpeningSignature)[0].pools[0].quota'),5000);assert.equal(h.read('JSON.parse(draftOpeningSignature)[0].pools[0].planningExempt'),true);
    h.nodes.resultsApply.click();assert.equal(h.state().ledger.character.pools[0].quota,5010);assert.equal(h.state().ledger.character.pools[0].planningExempt,true);
  });
  for(const extra of [{status:'partial',localLoss:null,countedLoss:null},{status:'provisional',countedLoss:null},{localLoss:-3,countedLoss:-3},{localLoss:0,countedLoss:0}]){
    await test('only completed positive losses can be newly exempted: '+JSON.stringify(extra),async()=>{
      const h=await exemptionHarness(extra);assert(exemptionChoice(h).disabled);assert(!h.nodes.planningDetailContent.textContent.includes('仅已完成计算的正亏损'));
      const marked=await exemptionHarness({...extra,planningExempt:true});assert(exemptionChoice(marked).checked);assert(!exemptionChoice(marked).disabled);
      toggleExemption(marked,false);await tick();await finishExemption(marked);assert.equal(marked.state().ledger.character.pools[0].planningExempt,false);
      if(extra.status)assert(marked.nodes.planningHighlights.textContent.includes('数据不足'));
    });
  }
  await test('closing loss details during save never reopens them when the response completes',async()=>{
    const h=await exemptionHarness();toggleExemption(h,true);await tick();escape(h.nodes.planningDetailDialog);await finishExemption(h);
    assert(!h.nodes.planningDetailDialog.open);assert(h.nodes.planningHighlights.textContent.includes('自律狂人'));
  });
  await test('loss exemption is a compact title-right checkbox without the old explanatory panel',async()=>{
    const h=await exemptionHarness();assert.equal(h.nodes.planningExemption.textContent,'豁免此项亏损');assert.equal(h.nodes.planningExemption.querySelectorAll('input').length,1);
    assert(!h.nodes.planningDetailContent.textContent.includes('豁免后'));assert(!h.nodes.planningDetailContent.textContent.includes('原亏损'));
    assert(/<div class="dialog-header"><h2 id="planningDetailTitle">[^<]*<\/h2><div id="planningExemption"/.test(html));
  });
  await test('loss details without a screenshot show current main rush and token records',async()=>{
    const h=await exemptionHarness(),saved=h.state();saved.documents=[{file:'synthetic.txt',source_sha256:'text-source'}];
    Object.assign(saved.ledger.character.pools[0],{total:245,tail:5,initialPity:8,events:[{at:22,character:'余烬',source:'main'},{at:120,character:'莱万汀',source:'main',forced:true}],rushUsed:true,rushAt:30,rush:[{at:4,character:'莱万汀'}],tokens:[{at:240,character:'莱万汀'}]});
    h.ctx.loadSession(saved);h.ctx.openPlanningDetail(saved.result.planning.pools[0]);const block=h.nodes.planningDetailContent.querySelector('.planning-record');assert(block);
    assert(block.textContent.includes('主池总抽数 245 抽'));assert(block.textContent.includes('期初水位 8 抽'));assert(block.textContent.includes('期末水位 5 抽'));
    const rows=block.querySelectorAll('tr').map(row=>row.textContent);assert(rows.some(text=>text.includes('主池六星第 22 抽余烬歪')));
    assert(rows.some(text=>text.includes('主池六星第 120 抽莱万汀120 保底')));assert(rows.some(text=>text.includes('加急六星第 4 抽莱万汀UP')));
    assert(rows.some(text=>text.includes('赠送信物第 240 抽莱万汀不计六星')));assert(block.textContent.includes('主池第 30 抽时使用'));
    assert(!h.nodes.planningDetailContent.textContent.includes('此记录的原图当前不可用'));assert.equal(h.nodes.planningDetailContent.querySelectorAll('img').length,0);
  });
  await test('no-hit text records distinguish confirmed unused rush from unknown rush and water',async()=>{
    for(const rushUsed of [true,false,null]){
      const h=await exemptionHarness(),saved=h.state();saved.documents=[{file:'synthetic.json'}];Object.assign(saved.ledger.character.pools[0],{events:[],rush:[],rushUsed,initialPity:null,tail:null});
      h.ctx.loadSession(saved);h.ctx.openPlanningDetail(saved.result.planning.pools[0]);const text=h.nodes.planningDetailContent.querySelector('.planning-record').textContent;
      assert(text.includes('未记录六星出货'));assert(text.includes('期初水位 未知'));assert(text.includes('期末水位 未知'));
      assert(text.includes(rushUsed===true?'未出六星':rushUsed===false?'未使用':'使用情况未知'));
    }
  });
  await test('a missing original screenshot falls back to the saved text records after image load failure',async()=>{
    const h=await exemptionHarness();h.read('session.ledger.character.pools[0].evidence={sourceImage:"/data/missing/source.png"}');h.ctx.openPlanningDetail(h.state().result.planning.pools[0]);
    const image=h.nodes.planningDetailContent.querySelector('img');assert(image);assert.equal(image.src,'/data/missing/source.png');assert(!h.nodes.planningDetailContent.querySelector('.planning-record'));
    image.onerror();assert(h.nodes.planningDetailContent.querySelector('.planning-record').textContent.includes('第 50 抽莱万汀UP'));
    assert.equal(h.nodes.planningDetailContent.querySelectorAll('img').length,0);
  });
  const enableScenario=h=>{h.nodes.hypothesisEnabled.checked=true;return h.nodes.hypothesisEnabled.onchange();};
  const finishScenario=async(h)=>{
    const request=h.pending.filter(p=>p.url==='/api/score').at(-1),updated=structuredClone(request.body.session),active=updated.scoringScenario.enabled;
    updated.result={...hypothesisScore(active?72:41,active?77:19),scoredAxes:active&&updated.scoringScenario.additionalFive==null?5:6,warnings:[],elapsedSeconds:.01};
    updated.result.scoringScenario={enabled:active,version:'hypothetical-final-score-v1-20261024'};
    if(active){const plan=hypothesisPlan({mode:updated.scoringScenario.mode});updated.result.hypothesis={...plan};updated.result.scoringScenario.plan=plan;updated.result.scoringScenario.notices=['假设新增出货'];
      if(updated.scoringScenario.additionalFive==null)updated.result.axes.five={status:'unscored',score:null,reason:'假设新增五星数未知'};}
    request.resolve(updated);await tick();return updated;
  };
  const activeScenarioHarness=async()=>{
    const {h}=await readyHypothesis();setField(h.nodes.hypothesisChoices,'第80抽','骏卫');enableScenario(h);await tick();await finishScenario(h);return h;
  };
  await test('enabling hypothesis requires choices then saves only settings and updates every homepage score',async()=>{
    const {h,saved,draft}=await readyHypothesis();h.nodes.revealLuck.click();const revealed=h.read('luckRevealed');
    enableScenario(h);assert(h.nodes.hypothesisError.textContent.includes('请选择第80抽'));assert(!h.nodes.hypothesisEnabled.checked);assert.equal(h.requests.filter(p=>p.url==='/api/score').length,0);
    setField(h.nodes.hypothesisChoices,'第80抽','骏卫');const saving=enableScenario(h);await tick();assert(h.nodes.hypothesisEnabled.disabled);assert(h.nodes.resultsApply.disabled);
    const request=h.pending.find(p=>p.url==='/api/score');assert.equal(request.body.session.ledger.character.pools[0].quota,5000);assert.equal(request.body.session.revision,2);assert.equal(request.body.session.reviewed,true);
    assert.deepEqual(request.body.session.scoringScenario,{enabled:true,poolId:'p0',mode:'first-up-120',choices:{'80':'骏卫'},additionalFive:null});
    assert.deepEqual(h.state(),saved);await finishScenario(h);await saving;
    assert.deepEqual(h.state().ledger,saved.ledger);assert.equal(h.read('JSON.stringify(characterDraft)'),draft);assert.equal(h.read('dialogIsCurrent()'),true);
    assert.equal(h.state().result.axes.characterSix.score,72);assert.equal(radarScore(h.nodes.radar,'角色六星'),'72.0');assert.equal(radarScore(h.nodes.radar,'角色五星'),'—');
    assert(h.nodes.planningHighlights.textContent.includes('77.00'));assert(h.nodes.scoringScenario.textContent.includes('当前显示：假设评分'));
    assert(h.nodes.scoringScenario.textContent.includes('新增五星未填写'));assert(h.nodes.radar.textContent.includes('假设补到保底 · 非实际抽卡结果'));
    assert(!h.nodes.resultDetails);assert(h.state().result.scoringScenario.enabled);assert.equal(h.read('luckRevealed'),revealed);
    assert(h.nodes.hypothesisEnabled.checked);assert(!h.nodes.hypothesisEnabled.disabled);assert(h.nodes.hypothesisDialog.open);
  });
  await test('last pool detail cancellation restores actual scores and clears the SVG label without changing actual ledger',async()=>{
    const h=await activeScenarioHarness(),before=h.state().ledger;escape(h.nodes.hypothesisDialog);assert(h.nodes.scoringScenario.querySelector('input').checked);
    const check=h.nodes.scoringScenario.querySelector('input');check.checked=false;const saving=check.onchange();await tick();
    assert.deepEqual(h.pending.filter(p=>p.url==='/api/score').at(-1).body.session.scoringScenario,{enabled:false});await finishScenario(h);await saving;
    assert.deepEqual(h.state().ledger,before);assert.equal(h.state().result.axes.characterSix.score,41);assert(h.nodes.planningHighlights.textContent.includes('19.00'));
    assert(!h.nodes.radar.textContent.includes('非实际抽卡结果'));assert(!h.nodes.hypothesisDialog.open);assert(!h.nodes.scoringScenario.querySelector('input').checked);
    assert(h.nodes.scoringScenario.textContent.includes('当前按实际记录评分'));assert.equal(h.read('characterDraft.pools[0].quota'),5180);
  });
  await test('saved scenario settings reopen and explicit changed configuration updates the active homepage scenario',async()=>{
    const h=await activeScenarioHarness();escape(h.nodes.hypothesisDialog);findButton(h.nodes.scoringScenario,'修改假设设置').click();await tick();
    const request=h.pending.filter(p=>p.url==='/api/hypothesis/plan').at(-1);assert.equal(request.body.session.ledger.character.pools[0].total,60);
    assert.equal(request.body.session.ledger.character.pools[0].quota,5000);request.resolve({plan:hypothesisPlan(),notices:[]});await tick();
    assert(h.nodes.hypothesisEnabled.checked);assert.equal(findField(h.nodes.hypothesisChoices,'第80抽').value,'骏卫');assert(h.nodes.hypothesisApply.hidden);
    setField(h.nodes.hypothesisControls,'新增五星数',6);assert(!h.nodes.hypothesisApply.hidden);assert(h.nodes.hypothesisApplyHint.textContent.includes('上次已保存'));
    h.nodes.hypothesisApply.click();await tick();assert.equal(h.pending.filter(p=>p.url==='/api/score').at(-1).body.session.scoringScenario.additionalFive,6);await finishScenario(h);
    assert.equal(h.state().scoringScenario.additionalFive,6);assert.equal(radarScore(h.nodes.radar,'角色五星'),'75.0');assert(h.nodes.hypothesisApply.hidden);
  });
  await test('failed hypothesis setting save rolls back checkbox and retains the original result and draft',async()=>{
    const {h,saved,draft}=await readyHypothesis();setField(h.nodes.hypothesisChoices,'第80抽','骏卫');const saving=enableScenario(h);await tick();
    h.nodes.hypothesisEnabled.checked=false;h.nodes.hypothesisEnabled.onchange();assert.equal(h.requests.filter(p=>p.url==='/api/score').length,1);
    h.pending.find(p=>p.url==='/api/score').reject(Error('测试场景写入失败'));await saving;
    assert.deepEqual(h.state(),saved);assert.equal(h.read('JSON.stringify(characterDraft)'),draft);assert(!h.nodes.hypothesisEnabled.checked);assert(!h.nodes.hypothesisEnabled.disabled);
    assert(h.nodes.hypothesisError.textContent.includes('测试场景写入失败'));assert(!h.nodes.save.disabled);assert(!h.nodes.resultsApply.disabled);
  });
  for(const sameId of [false,true])await test('late saved hypothesis response cannot replace '+(sameId?'reopened same':'another')+' record',async()=>{
    const {h}=await readyHypothesis();setField(h.nodes.hypothesisChoices,'第80抽','骏卫');const saving=enableScenario(h);await tick();
    h.ctx.loadSession(record(sameId?'hyp-live':'another-scenario'));const before=h.state();await finishScenario(h);await saving;
    assert.deepEqual(h.state(),before);assert(!h.nodes.hypothesisDialog.open);assert.equal(h.read('scoringScenarioRequest'),null);assert(!h.nodes.restore.disabled);
  });
  await test('closing the hypothesis window during an explicit save leaves its applied homepage result visible',async()=>{
    const {h}=await readyHypothesis();setField(h.nodes.hypothesisChoices,'第80抽','骏卫');enableScenario(h);await tick();escape(h.nodes.hypothesisDialog);await finishScenario(h);
    assert(!h.nodes.hypothesisDialog.open);assert(h.nodes.scoringScenario.querySelector('input').checked);assert.equal(h.state().scoringScenario.enabled,true);
  });
  await test('an invalid old scenario can be disabled after real record scoring has failed',async()=>{
    const h=await activeScenarioHarness();escape(h.nodes.hypothesisDialog);h.read('markStale("计算未完成，原假设已不适用")');
    const check=h.nodes.scoringScenario.querySelector('input');assert(!check.disabled);assert(check.checked);check.checked=false;check.onchange();await tick();
    await finishScenario(h);assert(h.nodes.calculating.hidden);assert.equal(h.state().scoringScenario.enabled,false);assert(h.nodes.planningHighlights.textContent.includes('19.00'));
  });
  await test('an enabled legacy scenario without cached results still reaches last pool details and can be disabled',async()=>{
    const h=await loaded(),saved=record('scenario-no-cache');saved.result=null;
    saved.scoringScenario={enabled:true,poolId:'p0',mode:'first-up-120',choices:{},additionalFive:null};h.ctx.loadSession(saved);await tick();
    h.pending.find(request=>request.url==='/api/score').reject(Error('旧假设不再适用'));await tick();
    findButton(h.nodes.planningHighlights,'查看末池详情').click();assert(h.nodes.planningDetailDialog.open);assert(!h.nodes.scoringScenario.hidden);
    const check=h.nodes.scoringScenario.querySelector('input');assert(check.checked);assert(!check.disabled);check.checked=false;check.onchange();await tick();await finishScenario(h);
    assert.equal(h.state().scoringScenario.enabled,false);assert(h.nodes.calculating.hidden);assert(h.nodes.planningDetailDialog.open);
  });
  await test('turning off an active scenario while its plan is loading restarts the plan for the new revision',async()=>{
    const h=await activeScenarioHarness();escape(h.nodes.hypothesisDialog);findButton(h.nodes.scoringScenario,'修改假设设置').click();await tick();
    const oldPlan=h.pending.filter(p=>p.url==='/api/hypothesis/plan').at(-1);assert(!h.nodes.hypothesisEnabled.disabled);
    h.nodes.hypothesisEnabled.checked=false;h.nodes.hypothesisEnabled.onchange();await tick();await finishScenario(h);
    const fresh=h.pending.filter(p=>p.url==='/api/hypothesis/plan').at(-1);assert.notEqual(fresh,oldPlan);
    oldPlan.resolve({plan:hypothesisPlan({addedDraws:999}),notices:[]});fresh.resolve({plan:hypothesisPlan(),notices:[]});await tick();
    assert(!h.nodes.hypothesisEnabled.checked);assert(!h.nodes.hypothesisEnabled.disabled);assert(h.nodes.hypothesisPlan.textContent.includes('新增 60 抽'));assert(!h.nodes.hypothesisPlan.textContent.includes('999'));
  });
  await test('hypothetical planning details clearly separate actual evidence from assumed new events',async()=>{
    const h=await activeScenarioHarness();h.ctx.openPlanningDetail(h.state().result.planning.pools[0]);const text=h.nodes.planningDetailContent.textContent;
    assert(text.includes('实际主池出货：第50抽 骏卫'));assert(text.includes('假设新增 60 抽'));assert(text.includes('第80抽 骏卫'));assert(text.includes('第120抽 莱万汀'));
    assert(text.includes('资源损耗按假设补抽后的结果计算'));
    toggleExemption(h,true);await tick();assert.equal(h.pending.filter(p=>p.url==='/api/score').at(-1).body.session.scoringScenario.enabled,true);
    await finishExemption(h);assert.equal(h.state().scoringScenario.enabled,true);assert.equal(h.state().ledger.character.pools[0].total,60);
  });
  await test('last pool detail checkbox opens settings without a hidden implicit save',async()=>{
    const h=await loaded(),before=h.state();assert(h.nodes.scoringScenario.hidden);h.ctx.openLatestPlanningDetail();const input=h.nodes.scoringScenario.querySelector('input');input.checked=true;input.onchange();await tick();
    assert(h.nodes.hypothesisDialog.open);assert(!input.checked);assert(!h.nodes.resultsDialog.open);assert.deepEqual(h.state(),before);
    assert.equal(h.requests.filter(p=>p.url==='/api/score').length,0);assert(h.pending.some(p=>p.url==='/api/hypothesis/plan'));
  });
  for(const kind of ['marker','version','pool'])await test('enabled legacy hypothesis with stale '+kind+' is rescored from actual ledger',async()=>{
    const h=harness({scoringScenarioVersion:'hypothetical-final-score-v1-20261024'});await tick();const saved=record('scenario-stale');
    saved.scoringScenario={enabled:true,poolId:'p0',mode:'next-six-80',choices:{'130':'骏卫'},additionalFive:null};
    if(kind!=='marker'){saved.result.hypothesis={};saved.result.scoringScenario={enabled:true,version:kind==='version'?'old':'hypothetical-final-score-v1-20261024',plan:{poolId:kind==='pool'?'wrong':'p0'}};}
    h.ctx.loadSession(saved);await tick();const request=h.pending.find(p=>p.url==='/api/score');assert(request);assert.equal(request.body.session.ledger.character.pools[0].total,60);
    assert(request.body.session.scoringScenario.enabled);findButton(h.nodes.planningHighlights,'查看末池详情').click();assert(h.nodes.scoringScenario.querySelector('input').checked);assert(!h.nodes.scoringScenario.querySelector('input').disabled);
  });
  await test('reopening the weapon form displays each old overflow distribution and discards cancelled edits',async()=>{
    const h=await loaded(),saved=record('weapon-navigation',[pool()],{N:1800,K6:50,KU:15,B:1,profile:'3 7 5 1'});
    h.ctx.loadSession(saved);await tick();const before=h.state();h.nodes.weaponConfigured.click();
    const view=h.nodes.weaponReview;assert.equal(findField(view,'5潜专武数量').value,2);
    assert.equal(findField(view,'满潜专武1溢出份数').value,2);setField(view,'亏损抽数',25);setField(view,'总专武种类',4);
    h.nodes.resultsCancel.click();h.nodes.weaponConfigured.click();assert.equal(findField(view,'总专武种类').value,3);
    assert.equal(findField(view,'亏损抽数').value,'');escape(h.nodes.resultsDialog);assert.deepEqual(h.state(),before);
  });
  await test('weapon navigation guards unavailable data and in-flight writes even when invoked directly',async()=>{
    const h=await loaded();h.read('historyDeleting=true');h.nodes.weaponConfigured.onclick();assert(!h.nodes.resultsDialog.open);
    h.read('historyDeleting=false;planningExemptionRequest={id:session.id}');h.nodes.weaponConfigured.onclick();assert(!h.nodes.resultsDialog.open);
    h.read('planningExemptionRequest=null');h.ctx.loadSession(record('without-weapon',[pool()],null));h.nodes.weaponConfigured.onclick();
    assert(h.nodes.weaponConfigured.disabled);assert(!h.nodes.resultsDialog.open);assert.equal(h.requests.filter(request=>request.url==='/api/score').length,0);
  });
  await test('completed global notices remain visible for three seconds then fade and hide',async()=>{
    const h=await loaded(),before=h.state();h.ctx.status('已打开本机记录。');
    assert(!h.nodes.status.hidden);assert.equal(h.nodes.status.querySelector('.notice-message').textContent,'已打开本机记录。');
    assert.equal(h.nodes.status.getAttribute('role'),'status');assert.equal(h.nodes.status.querySelector('button').getAttribute('aria-label'),'关闭通知');
    h.advanceTimers(2999);assert(!h.nodes.status.classList.contains('is-leaving'));h.advanceTimers(1);assert(h.nodes.status.classList.contains('is-leaving'));assert(!h.nodes.status.hidden);
    h.advanceTimers(249);assert(!h.nodes.status.hidden);h.advanceTimers(1);assert(h.nodes.status.hidden);assert.deepEqual(h.state(),before);
  });
  await test('new global messages cancel old expiry and old fade callbacks cannot hide their replacements',async()=>{
    const h=await loaded();h.ctx.status('旧提示');const oldExpiry=[...h.timers.values()].find(job=>job.ms===3000).fn;
    h.advanceTimers(2000);h.ctx.status('新提示');oldExpiry();h.advanceTimers(1000);
    assert(!h.nodes.status.hidden);assert(!h.nodes.status.classList.contains('is-leaving'));assert(h.nodes.status.textContent.includes('新提示'));
    h.advanceTimers(2000);assert(h.nodes.status.classList.contains('is-leaving'));const oldFade=[...h.timers.values()].find(job=>job.ms===250).fn;
    h.ctx.status('淡出时的新提示');oldFade();h.advanceTimers(250);assert(!h.nodes.status.hidden);assert(!h.nodes.status.classList.contains('is-leaving'));
    assert(h.nodes.status.textContent.includes('淡出时的新提示'));h.advanceTimers(3000);assert(h.nodes.status.hidden);
  });
  await test('manual close does not cancel running work and completion starts a fresh three second timeout',async()=>{
    const h=await loaded();h.read('busy=true');h.ctx.status('正在识别…',true);h.advanceTimers(10000);
    assert(!h.nodes.status.hidden);assert(h.nodes.status.classList.contains('is-running'));h.nodes.status.querySelector('button').click();h.advanceTimers(250);
    assert(h.nodes.status.hidden);assert.equal(h.read('busy'),true);assert.equal(h.requests.filter(request=>request.url==='/api/score').length,0);
    h.ctx.status('仍在识别…',true);assert(!h.nodes.status.hidden);h.ctx.status('识别完成');assert(!h.nodes.status.classList.contains('is-running'));
    h.advanceTimers(2999);assert(!h.nodes.status.hidden);h.advanceTimers(251);assert(h.nodes.status.hidden);
  });
  await test('error notices auto dismiss independently and can be closed immediately by the user',async()=>{
    const h=await loaded();h.ctx.error('读取失败');h.ctx.status('已打开记录');h.advanceTimers(1000);h.ctx.status('新状态');h.advanceTimers(2000);
    assert(h.nodes.error.classList.contains('is-error'));assert(h.nodes.error.classList.contains('is-leaving'));assert(!h.nodes.status.classList.contains('is-leaving'));
    assert.equal(h.nodes.error.getAttribute('role'),'alert');h.advanceTimers(250);assert(h.nodes.error.hidden);assert(!h.nodes.status.hidden);
    h.ctx.error('新的错误');h.nodes.error.querySelector('button').click();h.advanceTimers(250);assert(h.nodes.error.hidden);assert(!h.nodes.status.hidden);
    h.ctx.error('清除前');h.ctx.error('');assert(h.nodes.error.hidden);assert.equal(h.nodes.error.textContent,'');
  });
  await test('notices follow the actual modal stack without restarting their expiry or taking focus',async()=>{
    const h=await loaded();h.ctx.status('正在查看结果');h.advanceTimers(1000);h.nodes.openAllPlanning.click();
    assert.equal(h.nodes.notifications.parentNode,h.nodes.planningAllDialog);h.ctx.openLatestPlanningDetail();
    assert.equal(h.nodes.notifications.parentNode,h.nodes.planningDetailDialog,'detail is above the all-pools dialog despite earlier DOM order');
    h.advanceTimers(1000);h.ctx.openHypothesis('p0');assert.equal(h.nodes.notifications.parentNode,h.nodes.hypothesisDialog);
    escape(h.nodes.hypothesisDialog);assert.equal(h.nodes.notifications.parentNode,h.nodes.planningDetailDialog);
    h.advanceTimers(999);assert(!h.nodes.status.classList.contains('is-leaving'));h.advanceTimers(1);assert(h.nodes.status.classList.contains('is-leaving'));
    escape(h.nodes.planningDetailDialog);assert.equal(h.nodes.notifications.parentNode,h.nodes.planningAllDialog);h.advanceTimers(250);assert(h.nodes.status.hidden);
    h.ctx.openLatestPlanningDetail();h.ctx.error('第一条错误');h.ctx.document.activeElement=h.nodes.error.querySelector('button');h.ctx.error('更新错误');
    assert.equal(h.nodes.notifications.parentNode,h.nodes.planningDetailDialog);assert(!h.nodes.notifications.focused);
    h.nodes.error.querySelector('button').click();h.advanceTimers(250);assert(h.nodes.error.hidden);
  });
  await test('save result sits beside review and captures a fixed landscape result without changing JSON save',async()=>{
    const header=html.slice(html.indexOf('class="section-head record-meta"'),html.indexOf('<div class="result-grid"'));
    assert(header.includes('id="openResults"'));assert(header.includes('id="exportRadar"'));assert(header.includes('>保存结果</button>'));
    assert(!html.includes('>导出雷达图</button>'));assert.equal((html.match(/id="exportRadar"/g)||[]).length,1);
    assert(html.includes('id="resultCapture"'));assert(header.includes('>保存记录JSON</button>'));
    const css=fs.readFileSync(path.join(staticDir,'style.css'),'utf8');
    assert.match(css,/\.result-grid\.result-snapshot-layout\{width:1440px;grid-template-columns:minmax\(340px,\.78fr\) minmax\(0,1\.22fr\)/);
  });
  const clipboardHarness=async()=>{
    const h=await loaded(),writes=[];h.nodes.revealLuck.click();
    h.ctx.navigator={clipboard:{write:async items=>{writes.push(items);await items[0].values['image/png'];}}};
    h.ctx.ClipboardItem=class{constructor(values){this.values=values;}};
    h.ctx.resultSnapshot=()=>({width:1440,height:800});
    h.ctx.resultSnapshotPNG=async(capture,stillCurrent)=>{assert.equal(capture.width,1440);assert(stillCurrent());return new Blob(['png'],{type:'image/png'});};
    return {h,writes};
  };
  await test('result copy writes PNG during the click and reports success only after completion',async()=>{
    const {h,writes}=await clipboardHarness(),before=h.state();let finish;
    h.ctx.resultSnapshotPNG=()=>new Promise(resolve=>{finish=resolve;});
    const action=h.nodes.exportRadar.click();
    assert.equal(writes.length,1,'clipboard.write must run before awaiting rasterization');
    assert(h.nodes.exportRadar.disabled);assert.equal(h.nodes.exportRadar.textContent,'正在复制…');
    assert(!h.nodes.status.textContent.includes('已复制'));h.nodes.exportRadar.click();assert.equal(writes.length,1);
    finish(new Blob(['png'],{type:'image/png'}));await action;
    assert(h.nodes.status.textContent.includes('结果图片已复制到剪贴板'));assert.equal(h.nodes.exportRadar.textContent,'保存结果');
    assert(!h.nodes.exportRadar.disabled);assert.deepEqual(h.state(),before);
  });
  await test('concealed scores and pending edits cannot copy a result',async()=>{
    const {h,writes}=await clipboardHarness();h.ctx.setLuckRevealed(false);await h.nodes.exportRadar.onclick();assert.equal(writes.length,0);
    h.ctx.setLuckRevealed(true);h.read('planningExemptionRequest={};');await h.nodes.exportRadar.onclick();assert.equal(writes.length,0);
  });
  await test('clipboard rejection displays an error and restores the result button',async()=>{
    const {h}=await clipboardHarness();h.ctx.navigator.clipboard.write=async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});};
    await h.nodes.exportRadar.click();assert(h.nodes.error.textContent.includes('允许浏览器访问剪贴板'));assert(!h.nodes.exportRadar.disabled);
    assert(!h.nodes.status.textContent.includes('结果图片已复制'));
  });
  await test('a changed record cancels the pending PNG instead of copying stale scores',async()=>{
    const {h}=await clipboardHarness();let finish;
    h.ctx.resultSnapshotPNG=(capture,stillCurrent)=>new Promise((resolve,reject)=>{finish=()=>stillCurrent()?resolve(new Blob(['png'])):reject(Error('评分结果已变化，请重新点击保存结果。'));});
    const action=h.nodes.exportRadar.click();h.ctx.loadSession(record('different-record'));finish();await action;
    assert(h.nodes.error.textContent.includes('评分结果已变化'));assert(h.nodes.exportRadar.disabled);
  });
  const interruptedRecord=()=>record('interrupted',[
    pool({total:30,tail:30,events:[],rushUsed:false,rushAt:null,quota:600}),
    pool({id:'p2',index:2,banner:'热烈色彩',up:'伊冯',initialPity:30,total:70,tail:0,
      events:[{at:70,character:'伊冯',source:'main'}],quota:3580})]);
  const toggleInterruption=(h,index,on=true)=>{
    const input=h.nodes.interruptionReview.querySelectorAll('input').find(n=>n.dataset.bannerIndex===String(index));
    assert(input,'interruption banner missing');input.checked=on;input.onchange();
  };
  await test('interruption draft lists missing banners and restores raw facts on cancel',async()=>{
    const h=await loaded();h.ctx.loadSession(interruptedRecord());h.nodes.openResults.click();const before=h.state();
    assert.equal(h.nodes.interruptionReview.querySelectorAll('input').length,h.read('edit.BANNERS.length'));
    assert(h.nodes.interruptionReview.textContent.includes('烟火邀星河 · 明河'));
    assert(h.nodes.interruptionReview.textContent.includes('轻飘飘的信使 · 洁尔佩塔（未导入）'));
    toggleInterruption(h,1);setField(h.nodes.interruptionReview,'热烈色彩免费抽',20);
    assert.equal(h.read('characterDraft.pools[1].initialPity'),30);
    assert.equal(h.read('effectiveCharacter(characterDraft).pools[1].initialPity'),0);
    assert.equal(h.read('effectiveCharacter(characterDraft).pools[1].freeAllowance'),20);
    assert.deepEqual(h.state(),before);h.nodes.resultsCancel.click();assert.deepEqual(h.state(),before);
  });
  await test('interruption clears a false over80 error and saves settings without overwriting water',async()=>{
    const h=await loaded();h.ctx.loadSession(interruptedRecord());h.nodes.openResults.click();
    assert(h.nodes.review.textContent.includes('100抽'));
    toggleInterruption(h,1);setField(h.nodes.interruptionReview,'热烈色彩免费抽',0);h.flushTimers();await tick();
    assert(!h.nodes.review.textContent.includes('100抽'));assert(h.nodes.draftValidationSummary.textContent.includes('当前修改已通过校验'));
    const p2=h.nodes.review.querySelectorAll('details').find(n=>n.dataset.poolId==='p2');
    assert.equal(Number(findField(p2,'期初水位').value),0);assert.equal(findField(p2,'期初水位').disabled,true);
    assert(p2.textContent.includes('原始水位 30 → 0 继续保留'));
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.deepEqual(h.state().ledger.character.interruptionCorrection,{excludedIndices:[1],freeAllowances:{2:0}});
    assert.equal(h.state().ledger.character.pools[1].initialPity,30);
    h.flushTimers();await tick();const score=h.pending.find(p=>p.url==='/api/score');assert(score);
    assert.equal(score.body.session.ledger.character.pools[1].initialPity,30);
  });
  await test('interruption catalog and pity save independently, survive toggles, and preserve observed hits',async()=>{
    const h=await loaded(),value=interruptedRecord();
    value.ledger.character.pools[1].events[0].at=50;
    value.ledger.character.pools[1].tail=20;
    h.ctx.loadSession(value);h.nodes.openResults.click();toggleInterruption(h,1);
    setField(h.nodes.interruptionReview,'热烈色彩起始水位（仅欧非）',15);
    const owned=h.nodes.interruptionReview.querySelectorAll('input').find(n=>n.dataset.character==='莱万汀');
    owned.checked=true;owned.onchange();
    const complete=h.nodes.interruptionReview.querySelectorAll('input').find(n=>n.dataset.catalogIndex==='2');
    complete.checked=true;complete.onchange();
    assert.equal(h.read('effectiveCharacter(characterDraft).pools[1].initialPity'),15);
    assert.equal(h.read('characterDraft.pools[1].initialPity'),30);
    toggleInterruption(h,1,false);toggleInterruption(h,1,true);
    assert.equal(Number(findField(h.nodes.interruptionReview,'热烈色彩起始水位（仅欧非）').value),15);
    assert.equal(h.nodes.interruptionReview.querySelectorAll('input').find(n=>n.dataset.character==='莱万汀').checked,true);
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.deepEqual(h.state().ledger.character.interruptionCorrection.resumeInfo,{
      2:{initialPity:15,ownedSixStars:['莱万汀'],catalogComplete:true}});
    assert.deepEqual(h.state().ledger.character.pools,value.ledger.character.pools);
    h.nodes.openResults.click();assert.equal(h.nodes.interruptionReview.querySelectorAll('input').find(n=>n.dataset.catalogIndex==='2').checked,true);
    h.nodes.resultsCancel.click();
  });
  await test('excluded malformed pool leaves review queue and can be restored by clearing the option',async()=>{
    const h=await loaded(),value=record('excluded-invalid',[pool(),pool({id:'bad',index:1,banner:'轻飘飘的信使',up:'洁尔佩塔',total:null,initialPity:10,events:[{at:null,character:null}],issues:[{severity:'error',message:'记录已丢失'}]})]);
    h.ctx.loadSession(value);h.nodes.openResults.click();toggleInterruption(h,1);h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.state().ledger.character.pools.length,2);
    assert.equal(h.read('gatherReviewQueue().some(item=>item.id==="bad")'),false);
    h.nodes.openResults.click();findButton(h.nodes.interruptionReview,'清除中断修正').click();h.nodes.resultsApply.click();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.state().ledger.character.interruptionCorrection,undefined);
    assert.equal(h.read('gatherReviewQueue().some(item=>item.id==="bad")'),true);
  });
  await test('excluding the active hypothesis target closes its setting while retaining actual records',async()=>{
    const h=await loaded();h.ctx.loadSession(interruptedRecord());h.read('session.scoringScenario={enabled:true,poolId:"p2",mode:"first-up-120",choices:{},additionalFive:null};');
    h.nodes.openResults.click();toggleInterruption(h,2);
    assert(h.nodes.interruptionReview.textContent.includes('保存时将关闭该假设'));
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.deepEqual(h.state().scoringScenario,{enabled:false});assert.equal(h.state().ledger.character.pools.length,2);
    assert(h.nodes.status.textContent.includes('已关闭该假设'));assert.equal(h.read('latestSavedPool().id'),'p0');
  });
  await test('saved interruption with an outdated result revalidates before opening stale error queue',async()=>{
    const h=harness({interruptionVersion:'history-interruption-v1-20261030'});await tick();
    const value=interruptedRecord();value.ledger.character.interruptionCorrection={excludedIndices:[1],freeAllowances:{}};
    h.ctx.loadSession(value);await tick();
    assert.equal(h.nodes.resultsDialog.open,false);assert.equal(h.pending.filter(p=>p.url==='/api/score').length,1);
  });
  await test('changed ending water closes an old hypothesis even when its last pool is retained',async()=>{
    const h=await loaded(),value=interruptedRecord();
    Object.assign(value.ledger.character.pools[1],{total:20,tail:50,events:[],rushUsed:false,rushAt:null,quota:400});
    h.ctx.loadSession(value);h.read('session.scoringScenario={enabled:true,poolId:"p2",mode:"next-six-80",choices:{50:"伊冯"},additionalFive:null};');
    h.nodes.openResults.click();toggleInterruption(h,1);
    assert(h.nodes.interruptionReview.textContent.includes('改变了原假设的补抽位置'));
    h.nodes.resultsApply.click();assert.equal(h.nodes.resultsDialog.open,false);
    assert.deepEqual(h.state().scoringScenario,{enabled:false});assert.equal(h.state().ledger.character.pools[1].tail,50);
    assert.equal(h.read('latestSavedPool().tail'),20);
  });
  await test('free allowance or future-only changes retain a valid saved hypothesis',async()=>{
    const h=await loaded(),value=interruptedRecord();
    value.ledger.character.interruptionCorrection={excludedIndices:[1],freeAllowances:{2:10}};
    h.ctx.loadSession(value);h.read('session.scoringScenario={enabled:true,poolId:"p2",mode:"next-six-80",choices:{150:"伊冯"},additionalFive:null};');
    h.nodes.openResults.click();setField(h.nodes.interruptionReview,'热烈色彩免费抽',20);h.nodes.resultsApply.click();
    assert.equal(h.state().scoringScenario.enabled,true);
    h.nodes.openResults.click();toggleInterruption(h,11);h.nodes.resultsApply.click();
    assert.equal(h.state().scoringScenario.enabled,true);assert.equal(h.state().scoringScenario.poolId,'p2');
  });
  console.log(`${results.length} full-source UI dialog and async regression cases passed`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});
