(() => {
  'use strict';

  // ==========================
  // Level Data (JSON)
  // ==========================
  const LEVELS = [
    {
      id: 1, rows: 8, cols: 8, types: 5, moves: 25,
      targetScore: 2500,
      goals: [{ type: 'score', target: 2500 }],
      grid: null // auto
    },
    {
      id: 2, rows: 8, cols: 8, types: 6, moves: 30,
      targetScore: 4000,
      goals: [{ type: 'jelly', target: 16 }],
      // Layer jelly in a 4x4 square in the middle
      jelly: Array.from({length:8}, (_,r)=>Array.from({length:8}, (_,c)=> (r>1 && r<6 && c>1 && c<6) ? 1 : 0))
    },
    {
      id: 3, rows: 9, cols: 9, types: 6, moves: 35,
      targetScore: 6000,
      goals: [{ type: 'blocker', target: 8, name: 'Frosting' }],
      // Some ice/frosting blockers
      blockers: [
        { r: 4, c: 4, type: 'frosting', hp: 2 },
        { r: 4, c: 3, type: 'frosting', hp: 1 },
        { r: 4, c: 5, type: 'frosting', hp: 1 },
        { r: 3, c: 4, type: 'frosting', hp: 1 },
        { r: 5, c: 4, type: 'frosting', hp: 1 },
      ],
      portals: [
        { from: {r:8, c:0}, to: {r:0, c:8} },
        { from: {r:8, c:8}, to: {r:0, c:0} }
      ]
    },
    {
      id: 4, rows: 8, cols: 8, types: 6, moves: 20,
      targetScore: 5000,
      goals: [{ type: 'collect', color: 0, target: 20 }], // collect red
      chocolate: [{r:0, c:0}, {r:7, c:7}]
    }
  ];

  // ==========================
  // Constants / Tuning
  // ==========================
  const BASE_SCORE_PER_CANDY = 60;
  const SPECIAL_BONUS = {
    striped: 120,
    wrapped: 180,
    bomb: 300
  };

  const ANIM_SWAP_MS = 240;
  const ANIM_CLEAR_MS = 240;
  const ANIM_FALL_MS = 260;
  const ANIM_SPAWN_MS = 260;
  const ANIM_PULSE_MS = 180;

  const POINTER_DEADZONE_PX = 10;
  const SWIPE_MIN_PX = 18;

  // ==========================
  // DOM
  // ==========================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const uiLevel = document.getElementById('uiLevel');
  const uiMoves = document.getElementById('uiMoves');
  const uiTarget = document.getElementById('uiTarget');
  const uiScore = document.getElementById('uiScore');
  const uiGoal = document.getElementById('uiGoal');
  const goalList = document.getElementById('goalList');

  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayMsg = document.getElementById('overlayMsg');
  const btnRetry = document.getElementById('btnRetry');
  const btnNext = document.getElementById('btnNext');

  const btnRestart = document.getElementById('btnRestart');
  const btnSound = document.getElementById('btnSound');

  const boostHammer = document.getElementById('boostHammer');
  const boostShuffle = document.getElementById('boostShuffle');
  const boostSwap = document.getElementById('boostSwap');

  // ==========================
  // Audio Manager
  // ==========================
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  class AudioManager {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.sounds = {};
    }
    init() {
      if (this.ctx) return;
      this.ctx = new AudioCtx();
    }
    toggle() { this.enabled = !this.enabled; return this.enabled; }
    play(freq, type = 'sine', duration = 0.1, vol = 0.1) {
      if (!this.enabled || !this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    }
    playMatch() { this.play(440, 'triangle', 0.15); }
    playSwap() { this.play(220, 'sine', 0.1); }
    playError() { this.play(110, 'sawtooth', 0.2); }
    playWin() {
      this.play(523, 'sine', 0.5);
      setTimeout(() => this.play(659, 'sine', 0.5), 100);
      setTimeout(() => this.play(783, 'sine', 0.5), 200);
    }
    playSpecial() { this.play(880, 'square', 0.3, 0.05); }
  }
  const audio = new AudioManager();

  // ==========================
  // Utilities
  // ==========================
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const randInt = (n) => (Math.random() * n) | 0;
  const now = () => performance.now();

  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; }

  // ==========================
  // Candy Representation
  // ==========================
  // cell: {
  //   type: 0..types-1
  //   special: 'none' | 'stripedH' | 'stripedV' | 'wrapped' | 'bomb'
  //   id: unique
  // }
  let nextId = 1;
  const makeCandy = (type, special='none') => ({ type, special, id: nextId++ });

  // ==========================
  // Game State
  // ==========================
  const state = {
    levelIndex: 0,
    rows: 8,
    cols: 8,
    types: 6,

    grid: [], // [r][c] -> candy object
    jelly: [], // [r][c] -> int (0 or 1)
    blockers: [], // [r][c] -> blocker object or null
    portals: [],

    goals: [],
    score: 0,
    movesLeft: 30,
    targetScore: 5000,

    // interaction
    inputEnabled: true,
    activeBooster: null, // 'hammer', 'swap'
    pointer: {
      active: false,
      startX: 0,
      startY: 0,
      curX: 0,
      curY: 0,
      startCell: null,
      dragging: false,
      pointerId: null
    },

    // gameplay loop
    busy: false,
    chain: 0,
    chocolateSpreads: false,

    // animations
    tile: 64,
    boardPx: 512,
    offsetX: 0,
    offsetY: 0,
    dpr: 1,
    swapAnim: null,
    falling: new Map(),
    spawning: new Map(),
    clearing: new Map(),
    pulse: null,
    debug: false,
    shufflePulse: 0
  };

  // ==========================
  // Colors / Visual
  // ==========================
  const CANDY_COLORS = [
    { base: '#ff4d6d', hi: '#ffd0d9' },
    { base: '#ffb703', hi: '#fff0b3' },
    { base: '#06d6a0', hi: '#c9ffe9' },
    { base: '#4dabf7', hi: '#d5efff' },
    { base: '#a855f7', hi: '#f1d8ff' },
    { base: '#f97316', hi: '#ffe2c7' }
  ];

  function drawRoundedRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  function colorFor(candy){
    const c = CANDY_COLORS[candy.type % CANDY_COLORS.length];
    return c;
  }

  // ==========================
  // Board Setup & Validation
  // ==========================
  function inBounds(r,c){ return r>=0 && r<state.rows && c>=0 && c<state.cols; }

  function getCell(r,c){ return inBounds(r,c) ? state.grid[r][c] : null; }

  function setCell(r,c,val){ state.grid[r][c] = val; }

  function swapCells(a,b){
    const t = getCell(a.r,a.c);
    setCell(a.r,a.c, getCell(b.r,b.c));
    setCell(b.r,b.c, t);
  }

  function createEmptyGrid(){
    state.grid = Array.from({length: state.rows}, () => Array.from({length: state.cols}, () => null));
  }

  function wouldCreateImmediateMatch(r,c,type){
    // Avoid initial matches by checking left-2 and up-2 patterns.
    // Horizontal
    if (c >= 2) {
      const a = getCell(r,c-1), b = getCell(r,c-2);
      if (a && b && a.type===type && b.type===type) return true;
    }
    // Vertical
    if (r >= 2) {
      const a = getCell(r-1,c), b = getCell(r-2,c);
      if (a && b && a.type===type && b.type===type) return true;
    }
    return false;
  }

  function generateBoardNoMatches(){
    createEmptyGrid();
    for (let r=0;r<state.rows;r++){
      for (let c=0;c<state.cols;c++){
        let type = randInt(state.types);
        let guard = 0;
        while (wouldCreateImmediateMatch(r,c,type) && guard++ < 20){
          type = randInt(state.types);
        }
        setCell(r,c, makeCandy(type,'none'));
      }
    }

    // Ensure at least one possible move; if not, reshuffle.
    let tries = 0;
    while (!hasAnyPossibleMove() && tries++ < 20){
      shuffleBoard(false);
    }
  }

  // ==========================
  // Match Detection (O(n^2))
  // ==========================
  // Returns array of groups: {cells:[{r,c}], dir:'h'|'v'}
  function findRunMatches(){
    const groups = [];

    // Horizontal runs
    for (let r=0;r<state.rows;r++){
      let c=0;
      while (c < state.cols){
        const cell = getCell(r,c);
        if (!cell){ c++; continue; }
        const type = cell.type;
        let c2 = c+1;
        while (c2 < state.cols){
          const cell2 = getCell(r,c2);
          if (!cell2 || cell2.type !== type) break;
          c2++;
        }
        const len = c2 - c;
        if (len >= 3){
          const cells = [];
          for (let x=c;x<c2;x++) cells.push({r, c:x});
          groups.push({cells, dir:'h'});
        }
        c = c2;
      }
    }

    // Vertical runs
    for (let c=0;c<state.cols;c++){
      let r=0;
      while (r < state.rows){
        const cell = getCell(r,c);
        if (!cell){ r++; continue; }
        const type = cell.type;
        let r2 = r+1;
        while (r2 < state.rows){
          const cell2 = getCell(r2,c);
          if (!cell2 || cell2.type !== type) break;
          r2++;
        }
        const len = r2 - r;
        if (len >= 3){
          const cells = [];
          for (let y=r;y<r2;y++) cells.push({r:y, c});
          groups.push({cells, dir:'v'});
        }
        r = r2;
      }
    }

    return groups;
  }

  function keyOf(rc){ return rc.r + ',' + rc.c; }

  function mergeToSet(groups){
    const set = new Map(); // key -> {r,c}
    for (const g of groups){
      for (const cell of g.cells){
        set.set(keyOf(cell), cell);
      }
    }
    return set;
  }

  function findSpecialShapes(groups){
    // Identify T/L intersections to create wrapped.
    // Approach: build a map of cell -> membership in h-run and v-run.
    const hMap = new Map(); // key -> length
    const vMap = new Map();

    for (const g of groups){
      const len = g.cells.length;
      for (const cell of g.cells){
        const k = keyOf(cell);
        if (g.dir === 'h') hMap.set(k, Math.max(hMap.get(k)||0, len));
        else vMap.set(k, Math.max(vMap.get(k)||0, len));
      }
    }

    const wrappedAt = new Set();
    for (const [k, hLen] of hMap){
      const vLen = vMap.get(k) || 0;
      if (hLen >= 3 && vLen >= 3){
        wrappedAt.add(k);
      }
    }
    return wrappedAt; // keys
  }

  // ==========================
  // Possible Move Check (dead board)
  // ==========================
  function hasAnyPossibleMove(){
    // Try swapping each cell with right and down neighbor, check if match would exist.
    for (let r=0;r<state.rows;r++){
      for (let c=0;c<state.cols;c++){
        const a = {r,c};
        const dirs = [{dr:0,dc:1},{dr:1,dc:0}];
        for (const d of dirs){
          const b = {r:r+d.dr, c:c+d.dc};
          if (!inBounds(b.r,b.c)) continue;
          if (wouldMatchAfterSwap(a,b)) return true;
        }
      }
    }
    return false;
  }

  function wouldMatchAfterSwap(a,b){
    const ca = getCell(a.r,a.c);
    const cb = getCell(b.r,b.c);
    if (!ca || !cb) return false;

    // Color bomb involvement always creates an effect.
    if (ca.special === 'bomb' || cb.special === 'bomb') return true;

    swapCells(a,b);
    const groups = findRunMatches();
    swapCells(a,b);
    return groups.length > 0;
  }

  // ==========================
  // Shuffle
  // ==========================
  function shuffleBoard(consumeMove){
    // Fisher-Yates on candies (preserve specials as candies)
    const arr = [];
    for (let r=0;r<state.rows;r++) for (let c=0;c<state.cols;c++) arr.push(getCell(r,c));
    for (let i=arr.length-1;i>0;i--){
      const j = randInt(i+1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    let k=0;
    for (let r=0;r<state.rows;r++){
      for (let c=0;c<state.cols;c++) setCell(r,c, arr[k++]);
    }

    // Ensure stable: no immediate matches and has moves
    let guard = 0;
    while ((findRunMatches().length>0 || !hasAnyPossibleMove()) && guard++ < 40){
      // reshuffle
      for (let i=arr.length-1;i>0;i--){
        const j = randInt(i+1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      k=0;
      for (let r=0;r<state.rows;r++) for (let c=0;c<state.cols;c++) setCell(r,c, arr[k++]);
    }

    if (consumeMove){
      state.movesLeft = Math.max(0, state.movesLeft - 1);
      updateUI();
    }

    state.pulse = { cells: [], t0: now(), ms: ANIM_PULSE_MS };
    state.shufflePulse = 1;

    if (state.debug) logGrid('SHUFFLE');
  }

  // ==========================
  // Special Effects
  // ==========================
  function collectCellsForStriped(r,c,dir){
    const out = [];
    if (dir === 'h'){
      for (let x=0;x<state.cols;x++) out.push({r, c:x});
    } else {
      for (let y=0;y<state.rows;y++) out.push({r:y, c});
    }
    return out;
  }

  function collectCellsForWrapped(r,c){
    const out = [];
    for (let rr=r-1; rr<=r+1; rr++){
      for (let cc=c-1; cc<=c+1; cc++){
        if (inBounds(rr,cc)) out.push({r:rr, c:cc});
      }
    }
    return out;
  }

  function resolveBombSwap(bombCell, otherCell){
    // Bomb clears all candies of other type.
    const targetType = otherCell.type;
    const toClear = [];
    for (let r=0;r<state.rows;r++){
      for (let c=0;c<state.cols;c++){
        const cell = getCell(r,c);
        if (cell && cell.type === targetType) toClear.push({r,c});
      }
    }
    // Include the swapped cells too
    toClear.push({r:bombCell.r, c:bombCell.c});
    toClear.push({r:otherCell.r, c:otherCell.c});
    return uniqueCells(toClear);
  }

  function uniqueCells(cells){
    const m = new Map();
    for (const rc of cells) m.set(keyOf(rc), rc);
    return [...m.values()];
  }

  // ==========================
  // Core Resolution Loop
  // ==========================
  async function doPlayerSwap(a,b){
    if (state.busy || !state.inputEnabled) return;
    if (!inBounds(a.r,a.c) || !inBounds(b.r,b.c)) return;

    // Booster: Hammer
    if (state.activeBooster === 'hammer'){
      state.activeBooster = null;
      await resolveAndClear({ forcedClear: [a], createdSpecials: [] });
      await applyGravityAndRefill();
      checkEndConditions();
      return;
    }

    const manhattan = Math.abs(a.r-b.r) + Math.abs(a.c-b.c);
    if (manhattan !== 1) return;

    const ca = getCell(a.r,a.c);
    const cb = getCell(b.r,b.c);
    if (!ca || !cb) return;

    // Free Swap booster doesn't cost moves or revert
    const isFreeSwap = state.activeBooster === 'swap';
    if (isFreeSwap) state.activeBooster = null;

    if (state.movesLeft <= 0) return;

    state.busy = true;
    state.chain = 0;
    audio.playSwap();

    await animateSwap(a,b,false);
    swapCells(a,b);

    let valid = false;

    // Complex Special Combos
    if (ca.special !== 'none' && cb.special !== 'none') {
      valid = true;
      state.movesLeft--;
      updateUI();
      await resolveSpecialCombo(a, b, ca, cb);
    }
    // Bomb swap with regular candy
    else if (ca.special === 'bomb' || cb.special === 'bomb'){
      valid = true;
      state.movesLeft--;
      updateUI();
      const bombPos = (ca.special === 'bomb') ? a : b;
      const otherPos = (ca.special === 'bomb') ? b : a;
      await resolveAndClear({ forcedClear: resolveBombSwap(bombPos, otherPos), createdSpecials: [] });
    }
    else {
      const groups = findRunMatches();
      if (groups.length > 0){
        valid = true;
        state.movesLeft--;
        updateUI();
        await resolveMatchesAndCascades({ lastSwap: {a,b} });
      }
    }

    if (!valid && !isFreeSwap){
      audio.playError();
      await animateSwap(a,b,true);
      swapCells(a,b);
    }

    state.busy = false;
    checkEndConditions();

    if (!state.busy && findRunMatches().length === 0 && !hasAnyPossibleMove()){
      shuffleBoard(false);
    }
  }

  async function resolveSpecialCombo(pa, pb, ca, cb) {
    const s1 = ca.special, s2 = cb.special;
    let clear = [];

    if (s1 === 'bomb' && s2 === 'bomb') {
      // Clear entire board
      for (let r=0; r<state.rows; r++) for (let c=0; c<state.cols; c++) clear.push({r,c});
    } else if ((s1 === 'bomb' && (s2.includes('striped'))) || (s2 === 'bomb' && (s1.includes('striped')))) {
      // Bomb + Striped: All candies of that color become striped and activate
      const other = (s1 === 'bomb') ? cb : ca;
      const targetType = other.type;
      for (let r=0; r<state.rows; r++) {
        for (let c=0; c<state.cols; c++) {
          const cell = getCell(r,c);
          if (cell && cell.type === targetType) {
            cell.special = Math.random() > 0.5 ? 'stripedH' : 'stripedV';
            clear.push({r,c});
          }
        }
      }
      clear.push(pa, pb);
    } else if ((s1 === 'stripedH' || s1 === 'stripedV') && (s2 === 'stripedH' || s2 === 'stripedV')) {
      // Striped + Striped: Cross clear
      clear = [...collectCellsForStriped(pb.r, pb.c, 'h'), ...collectCellsForStriped(pb.r, pb.c, 'v')];
    } else if (s1 === 'wrapped' && s2 === 'wrapped') {
      // Massive explosion
      for (let r=pb.r-2; r<=pb.r+2; r++) for (let c=pb.c-2; c<=pb.c+2; c++) if (inBounds(r,c)) clear.push({r,c});
    } else {
      // Default: both trigger at once
      clear = [pa, pb];
    }

    await resolveAndClear({ forcedClear: uniqueCells(clear), createdSpecials: [] });
    await resolveMatchesAndCascades({ lastSwap: null });
  }

  async function resolveMatchesAndCascades({ lastSwap }){
    let matchesFound = false;
    while (true){
      const groups = findRunMatches();
      if (groups.length === 0) break;

      matchesFound = true;
      state.chain++;
      const createdSpecials = determineCreatedSpecials(groups, lastSwap);
      const forcedClear = buildClearList(groups, createdSpecials);
      await resolveAndClear({ forcedClear, createdSpecials });

      await applyGravityAndRefill();
      lastSwap = null;
    }

    // Chocolate spreading logic
    if (!matchesFound) {
      // If chocolate exists and no match occurred, spread chocolate
      spreadChocolate();
    }
  }

  function spreadChocolate() {
    const coords = [];
    for (let r=0; r<state.rows; r++) {
      for (let c=0; c<state.cols; c++) {
        if (state.blockers[r][c] && state.blockers[r][c].type === 'chocolate') {
          const nbs = [{r:r-1,c},{r:r+1,c},{r:r,c:c-1},{r:r,c:c+1}];
          for (const nb of nbs) {
            if (inBounds(nb.r, nb.c) && !state.blockers[nb.r][nb.c]) {
              coords.push(nb);
            }
          }
        }
      }
    }
    if (coords.length > 0) {
      const target = coords[randInt(coords.length)];
      state.blockers[target.r][target.c] = { type: 'chocolate', hp: 1 };
      setCell(target.r, target.c, null); // Consume candy
    }
  }

  function determineCreatedSpecials(groups, lastSwap){
    // Determine which special candies are created from current matches.
    // We create at most one special per distinct matched cluster (Candy Crush-like).

    const wrappedKeys = findSpecialShapes(groups);

    // Build clusters by merging overlapping groups.
    const adjacency = new Map(); // key -> set(keys)
    for (const g of groups){
      for (const cell of g.cells){
        const k = keyOf(cell);
        if (!adjacency.has(k)) adjacency.set(k, new Set());
        for (const cell2 of g.cells){
          adjacency.get(k).add(keyOf(cell2));
        }
      }
    }

    // Union-find via BFS
    const visited = new Set();
    const clusters = [];
    for (const k of adjacency.keys()){
      if (visited.has(k)) continue;
      const stack = [k];
      visited.add(k);
      const members = [];
      while (stack.length){
        const cur = stack.pop();
        members.push(cur);
        for (const nb of (adjacency.get(cur) || [])){
          if (!visited.has(nb)){
            visited.add(nb);
            stack.push(nb);
          }
        }
      }
      clusters.push(members);
    }

    const specials = [];

    for (const members of clusters){
      // Collect member cells
      const cells = members.map(k => {
        const [r,c] = k.split(',').map(Number);
        return {r,c};
      });

      // Determine if this cluster implies special
      // Priority: bomb (5 in a line), wrapped (T/L), striped (4 in a line)
      let make = null;

      // Check bomb: any run of length>=5 in groups belonging to cluster
      let bombCell = null;
      for (const g of groups){
        if (g.cells.length >= 5){
          // does group belong to this cluster?
          const inCluster = g.cells.some(rc => members.includes(keyOf(rc)));
          if (!inCluster) continue;
          make = { special: 'bomb', at: chooseSpecialCreationCell(g.cells, lastSwap) };
          bombCell = make.at;
          break;
        }
      }

      if (!make){
        // wrapped if any intersection cell in cluster
        const intersection = cells.find(rc => wrappedKeys.has(keyOf(rc)));
        if (intersection){
          make = { special: 'wrapped', at: chooseSpecialCreationCell([intersection], lastSwap) };
        }
      }

      if (!make){
        // striped if any run length==4 in cluster
        for (const g of groups){
          if (g.cells.length === 4){
            const inCluster = g.cells.some(rc => members.includes(keyOf(rc)));
            if (!inCluster) continue;
            const dir = (g.dir === 'h') ? 'stripedH' : 'stripedV';
            make = { special: dir, at: chooseSpecialCreationCell(g.cells, lastSwap) };
            break;
          }
        }
      }

      if (make){
        // Prevent making special on an already-special candy to reduce weirdness.
        specials.push(make);
      }
    }

    return specials;
  }

  function chooseSpecialCreationCell(cells, lastSwap){
    // Prefer one of swapped cells if included; otherwise use first.
    if (lastSwap){
      for (const candidate of [lastSwap.a, lastSwap.b]){
        if (cells.some(rc => rc.r===candidate.r && rc.c===candidate.c)) return {r:candidate.r, c:candidate.c};
      }
    }
    return {r: cells[0].r, c: cells[0].c};
  }

  function buildClearList(groups, createdSpecials){
    // Clear all matched cells EXCEPT those where we create specials (they remain, transformed).
    const matchedSet = mergeToSet(groups);
    const keep = new Set(createdSpecials.map(s => keyOf(s.at)));

    const clear = [];
    for (const rc of matchedSet.values()){
      if (!keep.has(keyOf(rc))) clear.push(rc);
    }

    return clear;
  }

  async function resolveAndClear({ forcedClear, createdSpecials }){
    // Expand clears by triggering specials in the clear list.
    const expanded = expandByTriggeredSpecials(forcedClear);

    // Apply special creation transformations
    for (const sp of createdSpecials){
      const cell = getCell(sp.at.r, sp.at.c);
      if (cell) cell.special = sp.special;
    }

    // Blockers / Jelly check
    for (const rc of expanded) {
      // Clear jelly
      if (state.jelly[rc.r] && state.jelly[rc.r][rc.c] > 0) {
        state.jelly[rc.r][rc.c]--;
        state.goals.filter(g => g.type === 'jelly').forEach(g => g.current++);
      }
      // Adjacent blockers (Frosting/Chocolate)
      const neighbors = [{r:rc.r-1,c:rc.c},{r:rc.r+1,c:rc.c},{r:rc.r,c:rc.c-1},{r:rc.r,c:rc.c+1}];
      for (const nb of neighbors) {
        if (!inBounds(nb.r, nb.c)) continue;
        const b = state.blockers[nb.r][nb.c];
        if (b) {
          b.hp--;
          if (b.hp <= 0) {
            state.blockers[nb.r][nb.c] = null;
            state.goals.filter(g => g.type === 'blocker').forEach(g => g.current++);
          }
        }
      }
      // Track collection goals
      const candy = getCell(rc.r, rc.c);
      if (candy) {
        state.goals.filter(g => g.type === 'collect' && g.color === candy.type).forEach(g => g.current++);
      }
    }

    // Animate
    const t0 = now();
    audio.playMatch();
    for (const rc of expanded){
      const cell = getCell(rc.r, rc.c);
      if (cell) state.clearing.set(cell.id, { t0, ms: ANIM_CLEAR_MS });
    }

    // Score
    let add = Math.round(expanded.length * BASE_SCORE_PER_CANDY * (1 + (state.chain - 1) * 0.4));
    state.score += add;
    updateUI();

    await waitMs(ANIM_CLEAR_MS);

    for (const rc of expanded){
      setCell(rc.r, rc.c, null);
    }
    state.clearing.clear();
  }

  function expandByTriggeredSpecials(initial){
    // When a special candy is cleared as part of a match, it triggers.
    // Also handle chain triggering by iteratively expanding.
    const queue = [...initial];
    const out = new Map();
    for (const rc of initial) out.set(keyOf(rc), rc);

    while (queue.length){
      const rc = queue.pop();
      const cell = getCell(rc.r, rc.c);
      if (!cell) continue;

      if (cell.special === 'stripedH' || cell.special === 'stripedV'){
        audio.playSpecial();
        const dir = cell.special === 'stripedH' ? 'h' : 'v';
        const cells = collectCellsForStriped(rc.r, rc.c, dir);
        for (const x of cells){
          const k = keyOf(x);
          if (!out.has(k)){ out.set(k, x); queue.push(x); }
        }
      } else if (cell.special === 'wrapped'){
        audio.playSpecial();
        // 5x5 explosion area for wrapped
        for (let rr=rc.r-2; rr<=rc.r+2; rr++){
          for (let cc=rc.c-2; cc<=rc.c+2; cc++){
            if (inBounds(rr,cc)){
              const k = keyOf({r:rr,c:cc});
              if (!out.has(k)){ out.set(k, {r:rr,c:cc}); queue.push({r:rr,c:cc}); }
            }
          }
        }
      } else if (cell.special === 'bomb'){
        audio.playSpecial();
        // Color bomb clears all candies of a random (or the bomb's type)
        const targetType = cell.type;
        for (let r=0;r<state.rows;r++){
          for (let c=0;c<state.cols;c++){
            const cc = getCell(r,c);
            if (cc && cc.type === targetType){
              const x = {r,c};
              const k = keyOf(x);
              if (!out.has(k)){
                out.set(k, x);
                queue.push(x);
              }
            }
          }
        }
      }
    }

    return [...out.values()];
  }

  async function applyGravityAndRefill(){
    // Gravity: collapse each column
    const t0 = now();

    // Compute final positions and animate falling by candy id
    state.falling.clear();
    state.spawning.clear();

    for (let c=0;c<state.cols;c++){
      let writeRow = state.rows - 1;
      for (let r=state.rows-1; r>=0; r--){
        const cell = getCell(r,c);
        if (cell){
          if (writeRow !== r){
            // move
            setCell(writeRow,c, cell);
            setCell(r,c, null);
            state.falling.set(cell.id, { fromY: r, toY: writeRow, t0, ms: ANIM_FALL_MS, col: c });
          }
          writeRow--;
        }
      }

      // Fill remaining with new candies
      for (let r=writeRow; r>=0; r--){
        const type = randInt(state.types);
        const cell = makeCandy(type,'none');
        setCell(r,c, cell);
        // spawn from above
        state.spawning.set(cell.id, { fromY: - (writeRow - r + 1), toY: r, t0, ms: ANIM_SPAWN_MS, col: c });
      }
    }

    // Wait until animations complete
    await waitMs(Math.max(ANIM_FALL_MS, ANIM_SPAWN_MS));
    state.falling.clear();
    state.spawning.clear();

    // Prevent infinite refill loops by limiting post-refill shuffle attempts
    let guard = 0;
    while (findRunMatches().length > 0 && guard++ < 12){
      // Allow cascades normally; but if we keep matching due to refill patterns without player action,
      // it's fine. The guard is here mainly to avoid pathological cases.
      break;
    }

    if (!hasAnyPossibleMove()){
      shuffleBoard(false);
    }
  }

  // ==========================
  // Swap Animation
  // ==========================
  async function animateSwap(a,b,revert){
    state.swapAnim = { a, b, t0: now(), ms: ANIM_SWAP_MS, revert };
    await waitMs(ANIM_SWAP_MS);
    state.swapAnim = null;
  }

  function waitMs(ms){
    return new Promise(res => setTimeout(res, ms));
  }

  // ==========================
  // Rendering
  // ==========================
  function resize(){
    const rect = canvas.getBoundingClientRect();
    state.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // Board fits width of its container. Use square board.
    const cssW = rect.width;
    const cssH = rect.height;

    // If no CSS height yet, set one based on width.
    // We control canvas size via JS for crisp rendering.
    const desired = Math.floor(cssW);

    state.boardPx = desired;
    canvas.style.height = desired + 'px';

    canvas.width = Math.floor(desired * state.dpr);
    canvas.height = Math.floor(desired * state.dpr);

    ctx.setTransform(state.dpr,0,0,state.dpr,0,0);

    // tile size in CSS pixels
    state.tile = state.boardPx / state.cols;
    state.offsetX = 0;
    state.offsetY = 0;
  }

  function boardToCanvas(r,c){
    return {
      x: state.offsetX + c * state.tile,
      y: state.offsetY + r * state.tile
    };
  }

  function canvasToCell(x,y){
    const bx = x - state.offsetX;
    const by = y - state.offsetY;
    const c = Math.floor(bx / state.tile);
    const r = Math.floor(by / state.tile);
    if (!inBounds(r,c)) return null;
    return {r,c};
  }

  function candyDrawPos(r,c,candy){
    // Base position
    let x = state.offsetX + c * state.tile;
    let y = state.offsetY + r * state.tile;

    // Swap anim offsets
    if (state.swapAnim){
      const {a,b,t0,ms} = state.swapAnim;
      const t = clamp((now()-t0)/ms, 0, 1);
      const e = easeInOutCubic(t);
      const isA = (a.r===r && a.c===c);
      const isB = (b.r===r && b.c===c);
      if (isA || isB){
        const from = isA ? a : b;
        const to = isA ? b : a;
        const dx = (to.c - from.c) * state.tile;
        const dy = (to.r - from.r) * state.tile;
        x += dx * e;
        y += dy * e;
      }
    }

    // Falling / spawning overrides y
    const fall = state.falling.get(candy.id);
    if (fall){
      const t = clamp((now()-fall.t0)/fall.ms, 0, 1);
      const e = easeOutCubic(t);
      y = state.offsetY + (fall.fromY + (fall.toY - fall.fromY) * e) * state.tile;
      x = state.offsetX + fall.col * state.tile;
    }

    const spawn = state.spawning.get(candy.id);
    if (spawn){
      const t = clamp((now()-spawn.t0)/spawn.ms, 0, 1);
      const e = easeOutCubic(t);
      y = state.offsetY + (spawn.fromY + (spawn.toY - spawn.fromY) * e) * state.tile;
      x = state.offsetX + spawn.col * state.tile;
    }

    return {x,y};
  }

  function draw(){
    const w = state.boardPx;
    const h = state.boardPx;
    ctx.clearRect(0,0,w,h);
    const tile = state.tile;

    // Background layer (Jelly)
    for (let r=0; r<state.rows; r++) {
      for (let c=0; c<state.cols; c++) {
        if (state.jelly[r] && state.jelly[r][c] > 0) {
          ctx.fillStyle = 'rgba(236, 72, 153, 0.3)';
          ctx.fillRect(c*tile + 2, r*tile + 2, tile - 4, tile - 4);
        }
      }
    }

    // Grid lines
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = 'white';
    for (let r=0; r<=state.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r*tile); ctx.lineTo(w, r*tile); ctx.stroke(); }
    for (let c=0; c<=state.cols; c++) { ctx.beginPath(); ctx.moveTo(c*tile, 0); ctx.lineTo(c*tile, h); ctx.stroke(); }
    ctx.restore();

    // Blockers layer
    for (let r=0; r<state.rows; r++) {
      for (let c=0; c<state.cols; c++) {
        const b = state.blockers[r][c];
        if (b) {
          ctx.fillStyle = b.type === 'frosting' ? '#e2e8f0' : '#451a03';
          drawRoundedRect(ctx, c*tile+4, r*tile+4, tile-8, tile-8, 8);
          ctx.fill();
          if (b.hp > 1) {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(b.hp, c*tile + tile/2, r*tile + tile/2 + 4);
          }
        }
      }
    }

    // Highlight
    if (state.pointer.active && state.pointer.startCell){
      const {r,c} = state.pointer.startCell;
      ctx.strokeStyle = 'white'; ctx.lineWidth = 4;
      drawRoundedRect(ctx, c*tile+2, r*tile+2, tile-4, tile-4, 12);
      ctx.stroke();
    }

    // Candies
    for (let r=0;r<state.rows;r++){
      for (let c=0;c<state.cols;c++){
        const candy = getCell(r,c);
        if (!candy) continue;
        const pos = candyDrawPos(r,c,candy);
        drawCandy(candy, pos.x, pos.y, tile);
      }
    }

    // HUD pulse on shuffle
    if (state.shufflePulse > 0){
      state.shufflePulse *= 0.92;
      if (state.shufflePulse < 0.02) state.shufflePulse = 0;
      ctx.save();
      ctx.globalAlpha = 0.12 * state.shufflePulse;
      ctx.fillStyle = 'white';
      drawRoundedRect(ctx, 6, 6, w-12, h-12, 16);
      ctx.fill();
      ctx.restore();
    }

    requestAnimationFrame(draw);
  }

  function drawCandy(candy, x, y, tile){
    const pad = tile * 0.11;
    const w = tile - pad*2;
    const h = tile - pad*2;
    const r = Math.min(16, tile*0.26);

    const {base, hi} = colorFor(candy);

    // Clearing anim scale/fade
    let alpha = 1;
    let scale = 1;
    const clr = state.clearing.get(candy.id);
    if (clr){
      const t = clamp((now()-clr.t0)/clr.ms, 0, 1);
      alpha = 1 - t;
      scale = 1 - 0.25*t;
    }

    ctx.save();
    ctx.translate(x + tile/2, y + tile/2);
    ctx.scale(scale, scale);
    ctx.translate(-tile/2, -tile/2);
    ctx.globalAlpha = alpha;

    // Base body
    const gx = pad;
    const gy = pad;

    // Shadow
    ctx.save();
    ctx.globalAlpha *= 0.35;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    drawRoundedRect(ctx, gx+2, gy+5, w, h, r);
    ctx.fill();
    ctx.restore();

    // Fill gradient
    const grad = ctx.createLinearGradient(gx, gy, gx+w, gy+h);
    grad.addColorStop(0, hi);
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, shade(base, -18));

    ctx.fillStyle = grad;
    drawRoundedRect(ctx, gx, gy, w, h, r);
    ctx.fill();

    // Gloss
    ctx.save();
    ctx.globalAlpha *= 0.22;
    ctx.fillStyle = 'white';
    drawRoundedRect(ctx, gx+4, gy+3, w-8, h*0.42, r);
    ctx.fill();
    ctx.restore();

    // Outline
    ctx.save();
    ctx.globalAlpha *= 0.55;
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, gx+0.75, gy+0.75, w-1.5, h-1.5, r);
    ctx.stroke();
    ctx.restore();

    // Special overlays
    if (candy.special !== 'none'){
      drawSpecialOverlay(candy, gx, gy, w, h, r);
    }

    ctx.restore();
  }

  function drawSpecialOverlay(candy, x, y, w, h, r){
    if (candy.special === 'stripedH' || candy.special === 'stripedV'){
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineWidth = Math.max(3, Math.min(7, w*0.12));
      ctx.lineCap = 'round';
      const stripes = 3;
      for (let i=1;i<=stripes;i++){
        const t = i/(stripes+1);
        if (candy.special === 'stripedH'){
          const yy = y + h * t;
          ctx.beginPath();
          ctx.moveTo(x+8, yy);
          ctx.lineTo(x+w-8, yy);
          ctx.stroke();
        } else {
          const xx = x + w * t;
          ctx.beginPath();
          ctx.moveTo(xx, y+8);
          ctx.lineTo(xx, y+h-8);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (candy.special === 'wrapped'){
      ctx.save();
      ctx.globalAlpha *= 0.95;
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      drawRoundedRect(ctx, x+4, y+4, w-8, h-8, r);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x+w/2, y+h/2, Math.min(w,h)*0.22, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    } else if (candy.special === 'bomb'){
      // Color bomb: dark core with rainbow ring
      ctx.save();
      ctx.globalAlpha *= 0.95;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.beginPath();
      ctx.arc(x+w/2, y+h/2, Math.min(w,h)*0.28, 0, Math.PI*2);
      ctx.fill();

      const ringR = Math.min(w,h)*0.34;
      const colors = ['#ff4d6d','#ffb703','#06d6a0','#4dabf7','#a855f7','#f97316'];
      ctx.lineWidth = Math.max(4, w*0.10);
      for (let i=0;i<colors.length;i++){
        ctx.strokeStyle = colors[i];
        ctx.beginPath();
        const a0 = (i/colors.length) * Math.PI*2;
        const a1 = ((i+1)/colors.length) * Math.PI*2;
        ctx.arc(x+w/2, y+h/2, ringR, a0, a1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function shade(hex, amt){
    // amt negative -> darker
    const c = hex.replace('#','');
    const num = parseInt(c,16);
    let r = (num>>16)&255;
    let g = (num>>8)&255;
    let b = num&255;
    r = clamp(r+amt,0,255);
    g = clamp(g+amt,0,255);
    b = clamp(b+amt,0,255);
    return '#' + ((1<<24) + (r<<16) + (g<<8) + b).toString(16).slice(1);
  }

  // ==========================
  // Input (Pointer Events)
  // ==========================
  function attachInput(){
    canvas.addEventListener('pointerdown', onPointerDown, {passive:false});
    canvas.addEventListener('pointermove', onPointerMove, {passive:false});
    canvas.addEventListener('pointerup', onPointerUp, {passive:false});
    canvas.addEventListener('pointercancel', onPointerUp, {passive:false});
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  function pointerPos(e){
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left),
      y: (e.clientY - rect.top)
    };
  }

  function onPointerDown(e){
    if (!state.inputEnabled || state.busy) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const p = pointerPos(e);
    const cell = canvasToCell(p.x, p.y);
    if (!cell) return;

    state.pointer.active = true;
    state.pointer.pointerId = e.pointerId;
    state.pointer.startX = p.x;
    state.pointer.startY = p.y;
    state.pointer.curX = p.x;
    state.pointer.curY = p.y;
    state.pointer.startCell = cell;
    state.pointer.dragging = false;
  }

  function onPointerMove(e){
    if (!state.pointer.active || state.pointer.pointerId !== e.pointerId) return;
    e.preventDefault();
    const p = pointerPos(e);
    state.pointer.curX = p.x;
    state.pointer.curY = p.y;

    const dx = p.x - state.pointer.startX;
    const dy = p.y - state.pointer.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (!state.pointer.dragging){
      if (Math.hypot(dx,dy) > POINTER_DEADZONE_PX){
        state.pointer.dragging = true;
      } else {
        return;
      }
    }

    if (Math.max(adx, ady) < SWIPE_MIN_PX) return;

    // Determine direction and perform swap once
    const start = state.pointer.startCell;
    if (!start) return;

    let dir = null;
    if (adx > ady){
      dir = dx > 0 ? {dr:0,dc:1} : {dr:0,dc:-1};
    } else {
      dir = dy > 0 ? {dr:1,dc:0} : {dr:-1,dc:0};
    }

    const target = {r: start.r + dir.dr, c: start.c + dir.dc};
    state.pointer.active = false; // consume
    state.pointer.startCell = null;

    doPlayerSwap(start, target);
  }

  function onPointerUp(e){
    if (state.pointer.pointerId !== e.pointerId) return;
    e.preventDefault();
    state.pointer.active = false;
    state.pointer.startCell = null;
    state.pointer.dragging = false;
    state.pointer.pointerId = null;
  }

  // ==========================
  // UI / Level / End Conditions
  // ==========================
  function updateUI(){
    const L = LEVELS[state.levelIndex];
    uiLevel.textContent = String(L.id);
    uiMoves.textContent = String(state.movesLeft);
    uiTarget.textContent = String(L.targetScore);
    uiScore.textContent = String(state.score);

    // Goal List
    goalList.innerHTML = '';
    state.goals.forEach(g => {
      const div = document.createElement('div');
      div.className = 'flex items-center justify-between p-2 bg-white/5 rounded-lg';
      let icon = '🎯';
      if (g.type === 'jelly') icon = '🍮';
      if (g.type === 'blocker') icon = '🧊';
      if (g.type === 'collect') {
        const color = CANDY_COLORS[g.color].base;
        icon = `<span class="w-3 h-3 rounded-full" style="background:${color}"></span>`;
      }
      div.innerHTML = `<div class="flex items-center gap-2">${icon} <span>${g.name || g.type}</span></div> <b>${g.current}/${g.target}</b>`;
      goalList.appendChild(div);
    });
  }

  function showOverlay(kind){
    overlay.classList.remove('hidden');
    btnNext.classList.add('hidden');
    if (kind === 'win'){
      audio.playWin();
      overlayTitle.textContent = 'Sweet Victory!';
      overlayMsg.textContent = `Final Score: ${state.score}`;
      if (state.levelIndex < LEVELS.length - 1) btnNext.classList.remove('hidden');
    } else {
      overlayTitle.textContent = 'Sugar Crash';
      overlayMsg.textContent = 'Out of moves!';
    }
  }

  function hideOverlay(){ overlay.classList.add('hidden'); }

  function checkEndConditions(){
    const allGoalsMet = state.goals.every(g => g.current >= g.target);
    const scoreMet = state.score >= LEVELS[state.levelIndex].targetScore;
    if (allGoalsMet || scoreMet){
      state.inputEnabled = false;
      showOverlay('win');
    } else if (state.movesLeft <= 0){
      state.inputEnabled = false;
      showOverlay('lose');
    }
  }

  function loadLevel(index){
    state.levelIndex = clamp(index, 0, LEVELS.length-1);
    const L = LEVELS[state.levelIndex];

    state.rows = L.rows || 8;
    state.cols = L.cols || 8;
    state.types = L.types || 6;
    state.movesLeft = L.moves || 30;
    state.score = 0;
    state.busy = false;
    state.inputEnabled = true;
    state.goals = (L.goals || []).map(g => ({...g, current: 0}));

    state.jelly = L.jelly ? JSON.parse(JSON.stringify(L.jelly)) : Array.from({length:state.rows}, ()=>Array(state.cols).fill(0));
    state.blockers = Array.from({length:state.rows}, ()=>Array(state.cols).fill(null));
    if (L.blockers) L.blockers.forEach(b => state.blockers[b.r][b.c] = { type: b.type, hp: b.hp });
    if (L.chocolate) L.chocolate.forEach(c => state.blockers[c.r][c.c] = { type: 'chocolate', hp: 1 });

    generateBoardNoMatches();
    resize();
    updateUI();
    hideOverlay();
  }

  function restartLevel(){
    loadLevel(state.levelIndex);
  }

  // ==========================
  // Debug
  // ==========================
  function logGrid(tag='GRID'){
    const mapSpecial = (s) => {
      if (s==='none') return '';
      if (s==='stripedH') return 'H';
      if (s==='stripedV') return 'V';
      if (s==='wrapped') return 'W';
      if (s==='bomb') return 'B';
      return '?';
    };
    const lines = [];
    for (let r=0;r<state.rows;r++){
      const row = [];
      for (let c=0;c<state.cols;c++){
        const cell = getCell(r,c);
        if (!cell) row.push(' . ');
        else row.push(`${cell.type}${mapSpecial(cell.special)}`.padStart(3,' '));
      }
      lines.push(row.join(' '));
    }
    console.log(`[${tag}] moves=${state.movesLeft} score=${state.score}`);
    console.log(lines.join('\n'));
  }

  function toggleDebug(){
    state.debug = !state.debug;
    const label = state.debug ? 'Debug: On' : 'Debug: Off';
    if (btnDebug) btnDebug.textContent = label;
    if (btnDebug2) btnDebug2.textContent = label;
    if (state.debug) logGrid('DEBUG ON');
  }

  // ==========================
  // Wire Buttons
  // ==========================
  function wireUI(){
    btnRestart?.addEventListener('click', () => restartLevel());
    btnRetry?.addEventListener('click', () => restartLevel());
    btnNext?.addEventListener('click', () => loadLevel(state.levelIndex+1));
    btnSound?.addEventListener('click', () => {
      const on = audio.toggle();
      btnSound.textContent = on ? '🔊 Sound: On' : '🔇 Sound: Off';
      audio.init();
    });

    boostHammer?.addEventListener('click', () => {
      if (state.busy) return;
      state.activeBooster = 'hammer';
      audio.playSpecial();
    });
    boostShuffle?.addEventListener('click', () => {
      if (state.busy) return;
      shuffleBoard(false);
      audio.playSpecial();
    });
    boostSwap?.addEventListener('click', () => {
      if (state.busy) return;
      state.activeBooster = 'swap';
      audio.playSpecial();
    });

    // Audio init on first interaction
    window.addEventListener('pointerdown', () => audio.init(), {once:true});
  }

  // ==========================
  // Boot
  // ==========================
  function boot(){
    // Give canvas an initial size based on container width
    // by setting width:100% in CSS; JS will set height.
    resize();
    window.addEventListener('resize', () => {
      resize();
    });

    attachInput();
    wireUI();

    loadLevel(0);
    requestAnimationFrame(draw);
  }

  boot();
})();
