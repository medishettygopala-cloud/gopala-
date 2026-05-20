/* simulation.js - Complete Biochemical & Animation Engines */

// --- Canvas roundRect Polyfill for Backward Compatibility ---
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    else if (Array.isArray(r)) {
      if (r.length === 1) r = [r[0], r[0], r[0], r[0]];
      else if (r.length === 2) r = [r[0], r[1], r[0], r[1]];
      else if (r.length === 3) r = [r[0], r[1], r[2], r[1]];
    } else r = [0, 0, 0, 0];
    let r1 = r[0], r2 = r[1], r3 = r[2], r4 = r[3];
    if (w < r1 + r2) { let ratio = w / (r1 + r2); r1 *= ratio; r2 *= ratio; }
    if (h < r2 + r3) { let ratio = h / (r2 + r3); r2 *= ratio; r3 *= ratio; }
    if (w < r3 + r4) { let ratio = w / (r3 + r4); r3 *= ratio; r4 *= ratio; }
    if (h < r4 + r1) { let ratio = h / (r4 + r1); r4 *= ratio; r1 *= ratio; }
    this.beginPath();
    this.moveTo(x + r1, y);
    this.lineTo(x + w - r2, y);
    this.arcTo(x + w, y, x + w, y + r2, r2);
    this.lineTo(x + w, y + h - r3);
    this.arcTo(x + w, y + h, x + w - r3, y + h, r3);
    this.lineTo(x + r4, y + h);
    this.arcTo(x, y + h, x, y + h - r4, r4);
    this.lineTo(x, y + r1);
    this.arcTo(x, y, x + r1, y, r1);
    this.closePath();
    return this;
  };
}

// --- GLOBAL STATE ---
let currentSimView = 'batch'; // 'batch' or 'continuous'
let simIsPlaying = false;
let simTime = 0; // Current simulated day
let maxSimTime = 30; // Max days based on OLR retention period
let simSpeed = 1; // Speed multiplier (simulated days per real-time minute)
let runCompareMode = true; // Plot baseline alongside enhanced

// Numerical integration state variables (Continuous ODE)
let state_S = 10.0;    // g COD/L (Organic Substrate)
let state_SVFA = 0.5;   // g COD/L (Volatile Fatty Acids)
let state_Xa = 0.5;     // g/L (Acidogenic biomass)
let state_Xm = 0.2;     // g/L (Methanogenic biomass)
let state_Alk = 60.0;   // meq/L (Bicarbonate Alkalinity)
let accumGasYield = 0;  // Cumulative biogas (L)

// Time series logs for plotting
let plotData = {
  batch: { days: [], yieldBase: [], yieldEnh: [], rateBase: [], rateEnh: [] },
  continuous: { days: [], S: [], SVFA: [], Xa: [], Xm: [], pH: [], rateGas: [], cumGas: [] }
};

// Waste properties pre-configured database
const feedstockDB = {
  food:   { name: 'Food Waste',   ts: 0.20, vs: 0.88, cn: 15, bmp: 420, kh: 0.20, cod: 220 },
  sludge: { name: 'Sewage Sludge', ts: 0.05, vs: 0.75, cn: 9,  bmp: 310, kh: 0.12, cod: 80 },
  crop:   { name: 'Crop Residues', ts: 0.85, vs: 0.90, cn: 65, bmp: 350, kh: 0.08, cod: 300 },
  manure: { name: 'Cattle Manure', ts: 0.08, vs: 0.80, cn: 25, bmp: 260, kh: 0.10, cod: 70 }
};

// Active user controls state
let inputs = {
  food: 40, sludge: 20, crop: 20, manure: 20, // Feedstock % (normalized to 100)
  temp: 37,
  olr: 3.0,
  retention: 30,
  enhThermal: false,
  enhEnzymatic: false,
  enhBiochar: false,
  enhNano: false,
  enhBuffer: false
};

// Canvas Particle Engine setup
let canvas, ctx;
let particles = [];
let impellersAngle = 0;
let animationFrameId = null;
let liquidSurfaceY = 0;
let currentLiquidHeight = 0;

// Chart.js references
let simulationChart = null;

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('reactorCanvas');
  ctx = canvas.getContext('2d');
  
  // Fit canvas to CSS dimensions
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // Initialize Chart
  initChart();
  
  // Set default sliders from initial inputs
  syncUI();
  updateFeedstockMix();
  
  // Start Particle Animation loop (runs even when paused, showing floating motion)
  startAnimationLoop();
  
  // Trigger initial simulation plotting
  runSimulationModel();

  // Automatically start playing the simulation on load
  playSimulation();
});

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

// --- VIEW & PRESET MANAGEMENT ---
function switchView(view) {
  currentSimView = view;
  document.body.className = `view-${view}`;
  
  const tabBatch = document.getElementById('tabBatch');
  const tabContinuous = document.getElementById('tabContinuous');
  
  if (view === 'batch') {
    tabBatch.classList.add('active');
    tabContinuous.classList.remove('active');
    document.getElementById('chartTitle').innerText = 'Cumulative Biogas Production (Batch Trial)';
    document.getElementById('labelRetention').innerText = 'Simulation Period (Days)';
  } else {
    tabBatch.classList.remove('active');
    tabContinuous.classList.add('active');
    document.getElementById('chartTitle').innerText = 'Dynamic Reactor Parameters (Continuous CSTR)';
    document.getElementById('labelRetention').innerText = 'Hydraulic Retention Time (Days)';
  }
  
  resetSimulation();
}

function syncUI() {
  document.getElementById('inputFood').value = inputs.food;
  document.getElementById('inputSludge').value = inputs.sludge;
  document.getElementById('inputCrop').value = inputs.crop;
  document.getElementById('inputManure').value = inputs.manure;
  document.getElementById('inputTemp').value = inputs.temp;
  document.getElementById('inputOLR').value = inputs.olr;
  document.getElementById('inputRetention').value = inputs.retention;
  
  document.getElementById('enhThermal').checked = inputs.enhThermal;
  document.getElementById('enhEnzymatic').checked = inputs.enhEnzymatic;
  document.getElementById('enhBiochar').checked = inputs.enhBiochar;
  document.getElementById('enhNano').checked = inputs.enhNano;
  document.getElementById('enhBuffer').checked = inputs.enhBuffer;
  
  // Sync textual readouts
  document.getElementById('valFood').innerText = inputs.food + '%';
  document.getElementById('valSludge').innerText = inputs.sludge + '%';
  document.getElementById('valCrop').innerText = inputs.crop + '%';
  document.getElementById('valManure').innerText = inputs.manure + '%';
  document.getElementById('valTemp').innerText = inputs.temp + '°C';
  document.getElementById('valOLR').innerText = inputs.olr + ' g/L/d';
  document.getElementById('valRetention').innerText = inputs.retention + ' Days';
}

function updateFeedstockMix() {
  // Read sliders
  let f = parseFloat(document.getElementById('inputFood').value);
  let s = parseFloat(document.getElementById('inputSludge').value);
  let c = parseFloat(document.getElementById('inputCrop').value);
  let m = parseFloat(document.getElementById('inputManure').value);
  
  // Prevent all zeros
  let total = f + s + c + m;
  if (total === 0) {
    f = 25; s = 25; c = 25; m = 25;
    total = 100;
  }
  
  // Normalize to 100%
  inputs.food = Math.round((f / total) * 100);
  inputs.sludge = Math.round((s / total) * 100);
  inputs.crop = Math.round((c / total) * 100);
  inputs.manure = Math.round((m / total) * 100);
  
  // Readjust slider values visually without looping
  document.getElementById('valFood').innerText = inputs.food + '%';
  document.getElementById('valSludge').innerText = inputs.sludge + '%';
  document.getElementById('valCrop').innerText = inputs.crop + '%';
  document.getElementById('valManure').innerText = inputs.manure + '%';
  
  calculateCompositeProperties();
  
  if (!simIsPlaying) {
    runSimulationModel();
  }
}

function updateOperationParams() {
  inputs.temp = parseInt(document.getElementById('inputTemp').value);
  inputs.olr = parseFloat(document.getElementById('inputOLR').value);
  inputs.retention = parseInt(document.getElementById('inputRetention').value);
  maxSimTime = inputs.retention;
  
  document.getElementById('valTemp').innerText = inputs.temp + '°C';
  document.getElementById('valOLR').innerText = inputs.olr.toFixed(1) + ' g COD/L/d';
  document.getElementById('valRetention').innerText = inputs.retention + ' Days';
  
  if (!simIsPlaying) {
    runSimulationModel();
  }
}

function toggleEnhancement() {
  inputs.enhThermal = document.getElementById('enhThermal').checked;
  inputs.enhEnzymatic = document.getElementById('enhEnzymatic').checked;
  inputs.enhBiochar = document.getElementById('enhBiochar').checked;
  inputs.enhNano = document.getElementById('enhNano').checked;
  inputs.enhBuffer = document.getElementById('enhBuffer').checked;
  
  if (!simIsPlaying) {
    runSimulationModel();
  }
}

function toggleCompareMode() {
  runCompareMode = !runCompareMode;
  const btn = document.getElementById('runCompareBtn');
  if (runCompareMode) {
    btn.classList.add('active');
    btn.innerText = 'Compare Baseline';
  } else {
    btn.classList.remove('active');
    btn.innerText = 'Show Single Curve';
  }
  runSimulationModel();
}

// Load a predefined recipe/preset
function loadPreset(presetName) {
  // Clear active styling on presets
  document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active-preset'));
  
  if (presetName === 'presetMunicipal') {
    document.getElementById('preset1').classList.add('active-preset');
    inputs = {
      food: 30, sludge: 40, crop: 10, manure: 20,
      temp: 37, olr: 3.0, retention: 30,
      enhThermal: false, enhEnzymatic: false, enhBiochar: false, enhNano: false, enhBuffer: false
    };
  } else if (presetName === 'presetHighYield') {
    document.getElementById('preset2').classList.add('active-preset');
    inputs = {
      food: 60, sludge: 10, crop: 10, manure: 20,
      temp: 37, olr: 4.5, retention: 25,
      enhThermal: true, enhEnzymatic: false, enhBiochar: true, enhNano: true, enhBuffer: true
    };
  } else if (presetName === 'presetAcidic') {
    document.getElementById('preset3').classList.add('active-preset');
    inputs = {
      food: 80, sludge: 5, crop: 5, manure: 10,
      temp: 35, olr: 8.5, retention: 15, // High OLR, low retention triggers soured crash
      enhThermal: false, enhEnzymatic: false, enhBiochar: false, enhNano: false, enhBuffer: false
    };
  } else if (presetName === 'presetManureOnly') {
    document.getElementById('preset4').classList.add('active-preset');
    inputs = {
      food: 0, sludge: 0, crop: 0, manure: 100,
      temp: 37, olr: 2.0, retention: 35,
      enhThermal: false, enhEnzymatic: false, enhBiochar: false, enhNano: false, enhBuffer: false
    };
  }
  
  syncUI();
  updateFeedstockMix();
  resetSimulation();
}

// --- BIOCHEMICAL MATH MODELS ---
let compositeWaste = {
  ts: 0.10, vs: 0.80, cn: 25, bmp: 350, kh: 0.12, cod: 100
};

function calculateCompositeProperties() {
  let totalPct = inputs.food + inputs.sludge + inputs.crop + inputs.manure;
  if (totalPct === 0) totalPct = 100;
  
  let tsSum = 0, vsSum = 0, cnNum = 0, cnDen = 0, bmpSum = 0, khSum = 0, codSum = 0;
  
  const keys = ['food', 'sludge', 'crop', 'manure'];
  keys.forEach(k => {
    let p = inputs[k] / 100;
    let prop = feedstockDB[k];
    tsSum += prop.ts * p;
    vsSum += prop.vs * p; // VS as a fraction of TS
    
    // C/N weighted average. N is estimated around 2-5% of TS.
    // Crop is high carbon (high C/N), manure/sludge is high nitrogen (low C/N).
    // Weighted C/N = Sum(C)/Sum(N)
    let cFraction = prop.ts * prop.vs * (prop.cn / (prop.cn + 1));
    let nFraction = prop.ts * prop.vs * (1 / (prop.cn + 1));
    cnNum += cFraction * p;
    cnDen += nFraction * p;
    
    bmpSum += prop.bmp * p;
    khSum += prop.kh * p;
    codSum += prop.cod * p;
  });
  
  compositeWaste.ts = tsSum;
  compositeWaste.vs = vsSum;
  compositeWaste.cn = cnDen > 0 ? (cnNum / cnDen) : 20;
  compositeWaste.bmp = bmpSum;
  compositeWaste.kh = khSum;
  compositeWaste.cod = codSum;
  
  // Render Mixer Details in HUD
  document.getElementById('mixCN').innerText = compositeWaste.cn.toFixed(1);
  document.getElementById('mixTS').innerText = (compositeWaste.ts * 100).toFixed(1) + '%';
  document.getElementById('mixVS').innerText = (compositeWaste.vs * 100).toFixed(1) + '% of TS';
  document.getElementById('mixBMP').innerText = Math.round(compositeWaste.bmp) + ' L/kg VS';
  
  // Styling warnings based on C/N ratio bounds
  const cnEl = document.getElementById('mixCN');
  if (compositeWaste.cn < 16) {
    cnEl.className = 'mix-metric-val red';
    cnEl.title = 'Warning: Low C/N ratio indicates risk of Ammonia Toxicity!';
  } else if (compositeWaste.cn > 40) {
    cnEl.className = 'mix-metric-val red';
    cnEl.title = 'Warning: High C/N ratio limits microbial nitrogen access, slowing rates!';
  } else {
    cnEl.className = 'mix-metric-val green';
    cnEl.title = 'Optimum C/N range (20-30)';
  }
}

// RUN THE BIOCHEMICAL MODELS OVER simulated range
function runSimulationModel() {
  if (currentSimView === 'batch') {
    simulateBatchGompertz();
  } else {
    simulateContinuousODE();
  }
}

// BATCH SIMULATION: Modified Gompertz Curves
function simulateBatchGompertz() {
  plotData.batch.days = [];
  plotData.batch.yieldBase = [];
  plotData.batch.yieldEnh = [];
  plotData.batch.rateBase = [];
  plotData.batch.rateEnh = [];
  
  // Establish parameters based on feedstock composite and operational parameters
  let P_base = compositeWaste.bmp; // mL/g VS
  let Rm_base = compositeWaste.bmp * compositeWaste.kh * 0.2; // L/kg VS/day
  let lambda_base = 3.5 - (compositeWaste.kh * 10); // days lag. Manure has fast start, crops have high lag.
  if (lambda_base < 0.8) lambda_base = 0.8;
  
  // Temperature factor (Mesophilic optimum around 37-40C, Arrhenius-like scaling)
  let tempFactor = 1.0;
  if (inputs.temp < 37) {
    tempFactor = Math.exp(-0.06 * (37 - inputs.temp));
  } else if (inputs.temp > 40) {
    tempFactor = Math.exp(-0.08 * (inputs.temp - 40)); // Thermophilic dip unless calibrated
  }
  Rm_base *= tempFactor;
  lambda_base /= (tempFactor + 0.1);
  
  // Enhanced Parameters
  let P_enh = P_base;
  let Rm_enh = Rm_base;
  let lambda_enh = lambda_base;
  
  if (inputs.enhThermal) {
    lambda_enh *= 0.35; // 65% reduction in lag phase
    Rm_enh *= 1.35;    // 35% rate increase
    P_enh *= 1.15;     // 15% dissolution expansion
  }
  if (inputs.enhEnzymatic) {
    lambda_enh *= 0.60; 
    Rm_enh *= 1.20;
    P_enh *= 1.10;
  }
  if (inputs.enhBiochar) {
    Rm_enh *= 1.25;
    P_enh *= 1.12;
    lambda_enh *= 0.80;
  }
  if (inputs.enhNano) {
    Rm_enh *= 1.15;
    P_enh *= 1.08;
  }
  
  // Generate daily profiles
  let totalDays = inputs.retention;
  for (let d = 0; d <= totalDays; d++) {
    plotData.batch.days.push(d);
    
    // Gompertz formula
    // y(t) = P * exp(-exp( (Rm * e / P) * (lambda - t) + 1 ))
    let e = Math.E;
    
    let baseVal = 0;
    if (d > 0) {
      let termBase = (Rm_base * e / P_base) * (lambda_base - d) + 1;
      baseVal = P_base * Math.exp(-Math.exp(termBase));
    }
    plotData.batch.yieldBase.push(baseVal);
    
    let enhVal = 0;
    if (d > 0) {
      let termEnh = (Rm_enh * e / P_enh) * (lambda_enh - d) + 1;
      enhVal = P_enh * Math.exp(-Math.exp(termEnh));
    }
    plotData.batch.yieldEnh.push(enhVal);
    
    // Daily rates (difference)
    if (d === 0) {
      plotData.batch.rateBase.push(0);
      plotData.batch.rateEnh.push(0);
    } else {
      plotData.batch.rateBase.push(plotData.batch.yieldBase[d] - plotData.batch.yieldBase[d-1]);
      plotData.batch.rateEnh.push(plotData.batch.yieldEnh[d] - plotData.batch.yieldEnh[d-1]);
    }
  }
  
  updateBatchCharts();
  updateKPIs(totalDays);
}

// CONTINUOUS SIMULATION: Dynamic 4-State CSTR Model
// RK4 Solver running step-by-step
function simulateContinuousODE() {
  plotData.continuous.days = [];
  plotData.continuous.S = [];
  plotData.continuous.SVFA = [];
  plotData.continuous.Xa = [];
  plotData.continuous.Xm = [];
  plotData.continuous.pH = [];
  plotData.continuous.rateGas = [];
  plotData.continuous.cumGas = [];
  
  // Reset integration variables to initial state
  state_S = 12.0;    // g COD/L
  state_SVFA = 0.6;   // g COD/L
  state_Xa = 0.6;     // g/L
  state_Xm = 0.25;    // g/L
  state_Alk = inputs.enhBuffer ? 110.0 : 65.0; // meq/L
  if (inputs.enhBiochar) state_Alk += 15.0;  // Biochar alkalinity contribution
  accumGasYield = 0;
  
  let OLR = inputs.olr; // g COD/L/d
  let HRT = inputs.retention; // days
  let D = 1.0 / HRT;   // Dilution rate [d^-1]
  
  // Influent substrate COD
  let S_in = OLR / D; 
  let SVFA_in = 0.05 * S_in; // 5% volatile acids in feedstock
  
  // Dynamic parameters calibrated to solid waste co-digestion
  let k_h = compositeWaste.kh; // default hydrolysis rate
  if (inputs.enhThermal) k_h *= 2.2;     // Significant boost
  if (inputs.enhEnzymatic) k_h *= 1.5;
  
  let Y_VFA = 0.75; // Stoichiometry COD_vfa / COD_s
  let Y_m = 0.08;   // Methanogenic yield
  let k_da = 0.02;  // Acidogen decay rate
  let k_dm = 0.015; // Methanogen decay rate
  
  // Microbial growth constants
  let mu_max_a = 1.2; // d^-1
  let K_S = 4.0;      // g COD/L
  let mu_max_m = 0.35; // d^-1. Methanogens grow much slower
  if (inputs.enhNano) mu_max_m *= 1.25;   // Direct interspecies electron acceleration
  if (inputs.enhBiochar) mu_max_m *= 1.20;
  let K_VFA = 0.8;    // g COD/L
  
  // Integration setup
  let totalDays = 60; // Render continuous behavior over 60 days
  let dt = 0.01;      // integration steps (100 steps per day)
  let stepsPerDay = 100;
  
  for (let day = 0; day <= totalDays; day++) {
    // Log daily values before integration steps
    let pH = calculatePH(state_SVFA, state_Alk);
    let mu_m = calculateMethanogenGrowth(state_SVFA, pH, mu_max_m, K_VFA);
    let gasRate = mu_m * state_Xm * 2.5; // Methane gas rate scaling (L/L/day)
    
    plotData.continuous.days.push(day);
    plotData.continuous.S.push(state_S);
    plotData.continuous.SVFA.push(state_SVFA);
    plotData.continuous.Xa.push(state_Xa);
    plotData.continuous.Xm.push(state_Xm);
    plotData.continuous.pH.push(pH);
    plotData.continuous.rateGas.push(gasRate);
    
    accumGasYield += gasRate;
    plotData.continuous.cumGas.push(accumGasYield);
    
    // Integrate for 1 day
    for (let step = 0; step < stepsPerDay; step++) {
      // 4-state ODE Derivatives solver (Euler integration is too unstable for bacteria, using RK4)
      let derivatives = (S, SVFA, Xa, Xm, Alk) => {
        let current_pH = calculatePH(SVFA, Alk);
        
        // Kinetics
        let r_h = k_h * S * Xa;
        
        // Acidogen growth
        let pH_i_a = Math.exp(-3 * Math.pow((current_pH - 6.8)/1.5, 2)); // slight acid inhibition
        let mu_a = mu_max_a * (S / (K_S + S)) * pH_i_a;
        
        // Methanogen growth with full VFA and pH inhibition
        let mu_m = calculateMethanogenGrowth(SVFA, current_pH, mu_max_m, K_VFA);
        
        // Mass balances
        let dS = D * (S_in - S) - r_h;
        let dSVFA = D * (SVFA_in - SVFA) + Y_VFA * r_h - (1.0 / Y_m) * mu_m * Xm;
        let dXa = (mu_a - k_da - D) * Xa;
        let dXm = (mu_m - k_dm - D) * Xm;
        
        // Alkalinity dynamics (consumed by VFA accumulation, buffered by loading/additives)
        let Alk_in = inputs.enhBuffer ? 110.0 : 65.0;
        let dAlk = D * (Alk_in - Alk);
        
        return [dS, dSVFA, dXa, dXm, dAlk];
      };
      
      // RK4 step
      let [S_t, SVFA_t, Xa_t, Xm_t, Alk_t] = [state_S, state_SVFA, state_Xa, state_Xm, state_Alk];
      
      let k1 = derivatives(S_t, SVFA_t, Xa_t, Xm_t, Alk_t);
      let k2 = derivatives(S_t + k1[0]*dt/2, SVFA_t + k1[1]*dt/2, Xa_t + k1[2]*dt/2, Xm_t + k1[3]*dt/2, Alk_t + k1[4]*dt/2);
      let k3 = derivatives(S_t + k2[0]*dt/2, SVFA_t + k2[1]*dt/2, Xa_t + k2[2]*dt/2, Xm_t + k2[3]*dt/2, Alk_t + k2[4]*dt/2);
      let k4 = derivatives(S_t + k3[0]*dt, SVFA_t + k3[1]*dt, Xa_t + k3[2]*dt, Xm_t + k3[3]*dt, Alk_t + k3[4]*dt);
      
      state_S += (k1[0] + 2*k2[0] + 2*k3[0] + k4[0]) * dt / 6;
      state_SVFA += (k1[1] + 2*k2[1] + 2*k3[1] + k4[1]) * dt / 6;
      state_Xa += (k1[2] + 2*k2[2] + 2*k3[2] + k4[2]) * dt / 6;
      state_Xm += (k1[3] + 2*k2[3] + 2*k3[3] + k4[3]) * dt / 6;
      state_Alk += (k1[4] + 2*k2[4] + 2*k3[4] + k4[4]) * dt / 6;
      
      // Floor checking to prevent numerical rounding negative values
      if (state_S < 0) state_S = 0;
      if (state_SVFA < 0) state_SVFA = 0;
      if (state_Xa < 1e-4) state_Xa = 1e-4;
      if (state_Xm < 1e-4) state_Xm = 1e-4;
    }
  }
  
  updateContinuousCharts();
  updateKPIs(totalDays);
}

// Bicarbonate Buffering pH calculation helper
function calculatePH(vfa, alk) {
  // Henderson-Hasselbalch-like simplification:
  // pH is governed by Bicarbonate-CO2 buffering, with VFA acts as consuming acidity
  let ratio = (alk - vfa * 8.0) / (vfa * 8.0 + 1.0); // scale factor to meq
  if (ratio <= 0.01) return 4.5;
  let pH = 6.4 + Math.log10(ratio);
  
  if (pH > 8.5) return 8.5;
  if (pH < 4.0) return 4.0;
  return pH;
}

// Methanogen Growth calculation with multi-inhibition factors
function calculateMethanogenGrowth(vfa, pH, mu_max, K_VFA) {
  // pH Inhibition: bell curve centered at 7.15, methanogens crash completely below 6.0 and above 8.2
  let pH_inhibition = 0;
  if (pH > 5.8 && pH < 8.4) {
    pH_inhibition = Math.exp(-5.0 * Math.pow((pH - 7.15)/1.15, 2));
  }
  
  // VFA Monod term
  let monod = vfa / (K_VFA + vfa);
  
  // High VFA self-inhibition (Haldane equation variant)
  let Ki_VFA = 12.0; // high organic loading VFA inhibition threshold
  let haldane = vfa / (K_VFA + vfa + Math.pow(vfa, 2)/Ki_VFA);
  
  // Direct Interspecies Electron Transfer (DIET) boost if biochar/nanoparticles are added, making methanogens highly resilient
  if (inputs.enhBiochar || inputs.enhNano) {
    haldane = vfa / (K_VFA*0.5 + vfa + Math.pow(vfa, 2)/(Ki_VFA*1.8)); // cuts affinity constant and doubles resilience
  }
  
  return mu_max * haldane * pH_inhibition;
}

// --- REAL-TIME PLAYBACK TIMER & ENGINE RUN ---
let simIntervalId = null;

function playSimulation() {
  if (simIsPlaying) return;
  simIsPlaying = true;
  document.getElementById('btnPlay').classList.add('active-run');
  document.getElementById('btnPause').classList.remove('active-run');
  
  // Reset variables if playing from end
  if (simTime >= maxSimTime) {
    resetSimulation();
    simIsPlaying = true;
    document.getElementById('btnPlay').classList.add('active-run');
  }
  
  // Interval speed mapping: 1x speed is ~0.5 day/sec
  // 5x is ~2.5 days/sec. Refresh tick is 100ms
  let msTick = 100;
  simIntervalId = setInterval(() => {
    let dayStep = (simSpeed / 20.0);
    simTime += dayStep;
    
    if (simTime >= maxSimTime) {
      simTime = maxSimTime;
    }
    
    // Update live particle targets, impeller spins
    updateLiveBioreactorAesthetics();
    
    // Redraw graphs at current time horizon
    renderLiveChartHorizon();
    
  }, msTick);
}

function pauseSimulation() {
  simIsPlaying = false;
  document.getElementById('btnPlay').classList.remove('active-run');
  document.getElementById('btnPause').classList.add('active-run');
  if (simIntervalId) {
    clearInterval(simIntervalId);
    simIntervalId = null;
  }
}

function resetSimulation() {
  pauseSimulation();
  document.getElementById('btnPlay').classList.remove('active-run');
  document.getElementById('btnPause').classList.remove('active-run');
  simTime = 0;
  maxSimTime = currentSimView === 'batch' ? inputs.retention : 60;
  
  // Rerun models to regenerate fresh static log arrays
  runSimulationModel();
  
  // Reset particle pool
  initParticleEngine();
  
  // Redraw
  renderLiveChartHorizon();
  updateLiveBioreactorAesthetics();
}

function setSimSpeed(speed) {
  simSpeed = speed;
  document.querySelectorAll('.speed-badge').forEach(badge => {
    if (badge.id !== 'runCompareBtn') badge.classList.remove('active');
  });
  document.getElementById(`speed${speed}x`).classList.add('active');
}

// --- INTERACTIVE ANIME REACTOR ENGINE (<CANVAS>) ---

// Dynamic connected vessel geometry and helper variables
let liquidSurfaceY1 = 0;
let liquidSurfaceY2 = 0;
let gasExitCount = 0;
let gasFlowRate = 0;

function getGeometry() {
  let w = canvas.width;
  let h = canvas.height;
  
  let vessel1Width = w * 0.40;
  let vessel1X = w * 0.07;
  let v1CenterX = vessel1X + vessel1Width / 2;
  
  let vessel2Width = w * 0.40;
  let vessel2X = w * 0.53;
  let v2CenterX = vessel2X + vessel2Width / 2;
  
  let bottomY = h * 0.90;
  let topY = h * 0.28;
  
  let pipeY = topY + 20;
  let exhaustY = h * 0.08;
  
  return {
    w, h,
    v1Width: vessel1Width, v1X: vessel1X, v1CenterX,
    v2Width: vessel2Width, v2X: vessel2X, v2CenterX,
    bottomY, topY, pipeY, exhaustY
  };
}

function getLivePH() {
  let idx = Math.floor(simTime);
  if (currentSimView === 'continuous') {
    return plotData.continuous.pH[idx] || 7.15;
  }
  return 7.15;
}

class Particle {
  constructor(type) {
    this.type = type; // 'solid', 'soluble', 'vfa', 'bubble', 'acidogen', 'methanogen', 'gas'
    this.reset();
  }
  
  reset() {
    let geom = getGeometry();
    this.dead = false;
    this.life = 1.0;
    this.pulse = Math.random() * 10;
    
    // Assign vessel:
    // Solids, solubles, VFAs, and acidogens can now carry over or be present in Vessel 2 (finishing reactor)
    if (this.type === 'solid') {
      this.vessel = Math.random() < 0.65 ? 1 : 2; // 65% in V1, 35% in V2 (Make sure food is beautifully visible in V2)
    } else if (this.type === 'soluble') {
      this.vessel = Math.random() < 0.65 ? 1 : 2; // 65% in V1, 35% in V2
    } else if (this.type === 'vfa') {
      this.vessel = Math.random() < 0.65 ? 1 : 2; // 65% in V1, 35% in V2
    } else if (this.type === 'acidogen') {
      this.vessel = Math.random() < 0.65 ? 1 : 2; // 65% in V1, 35% in V2
    } else if (this.type === 'methanogen' || this.type === 'bubble') {
      this.vessel = Math.random() < 0.50 ? 1 : 2; // 50% in V1, 50% in V2 (methanogens thrive in secondary)
    } else if (this.type === 'gas') {
      this.vessel = 1;
      this.gasState = 'v1_headspace';
    }
    
    this.relX = Math.random();
    this.relDepth = Math.random();
    
    let xMin = this.vessel === 1 ? geom.v1X : geom.v2X;
    let xMax = this.vessel === 1 ? (geom.v1X + geom.v1Width) : (geom.v2X + geom.v2Width);
    let liquidSurf = this.vessel === 1 ? liquidSurfaceY1 : liquidSurfaceY2;
    
    this.x = xMin + 8 + this.relX * (xMax - xMin - 16);
    this.y = liquidSurf + 10 + this.relDepth * (geom.bottomY - liquidSurf - 20);
    
    this.vx = (Math.random() - 0.5) * 0.8;
    this.vy = (Math.random() - 0.5) * 0.5;
    
    this.size = 2;
    this.color = '#fff';
    
    if (this.type === 'solid') {
      this.size = 4 + Math.random() * 5;
      const organicColors = ['#5c2e16', '#7c3f1a', '#42200f', '#2d5a27', '#a0522d', '#8b5a2b', '#556b2f', '#cd853f'];
      this.solidColor = organicColors[Math.floor(Math.random() * organicColors.length)];
      
      this.pebblePoints = [];
      let numPoints = 5 + Math.floor(Math.random() * 4);
      for (let i = 0; i < numPoints; i++) {
        let angle = (i / numPoints) * Math.PI * 2;
        let radiusOffset = 0.75 + Math.random() * 0.5;
        this.pebblePoints.push({
          cos: Math.cos(angle) * radiusOffset,
          sin: Math.sin(angle) * radiusOffset
        });
      }
      
      if (currentSimView === 'batch') {
        this.relX = 0.15 + Math.random() * 0.7;
        let vWidth = this.vessel === 1 ? geom.v1Width : geom.v2Width;
        let vX = this.vessel === 1 ? geom.v1X : geom.v2X;
        this.x = vX + this.relX * vWidth;
        
        let centerX = this.vessel === 1 ? geom.v1CenterX : geom.v2CenterX;
        let dx = (this.x - centerX) / (vWidth * 0.35);
        let heapHeight = this.vessel === 1 ? (geom.h * 0.18) : (geom.h * 0.11);
        let heapSurfaceY = (geom.bottomY - 6) - heapHeight * Math.exp(-dx * dx);
        let baseFloor = geom.bottomY - 4;
        let groundY = baseFloor - (baseFloor - heapSurfaceY) * this.relDepth;
        
        this.y = groundY;
        this.vx = 0;
        this.vy = 0;
      }
    } else if (this.type === 'soluble') {
      this.size = 2.5 + Math.random() * 2.5;
      this.color = 'rgba(16, 185, 129, 0.75)';
    } else if (this.type === 'vfa') {
      this.size = 1.5 + Math.random() * 1.5;
      this.color = 'rgba(239, 68, 68, 0.85)';
    } else if (this.type === 'bubble') {
      this.size = 1.5 + Math.random() * 3;
      this.color = 'rgba(34, 211, 238, 0.6)';
      this.vy = -0.8 - Math.random() * 1.0;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.y = geom.bottomY - 10 - Math.random() * 30; // starts deep
    } else if (this.type === 'acidogen') {
      this.size = 6.5;
      this.color = '#eab308';
      if (currentSimView === 'batch') {
        this.relX = 0.2 + Math.random() * 0.6;
        let vWidth = this.vessel === 1 ? geom.v1Width : geom.v2Width;
        let vX = this.vessel === 1 ? geom.v1X : geom.v2X;
        this.x = vX + this.relX * vWidth;
        
        let centerX = this.vessel === 1 ? geom.v1CenterX : geom.v2CenterX;
        let dx = (this.x - centerX) / (vWidth * 0.35);
        let heapHeight = this.vessel === 1 ? (geom.h * 0.18) : (geom.h * 0.11);
        let heapSurfaceY = (geom.bottomY - 6) - heapHeight * Math.exp(-dx * dx);
        let baseFloor = geom.bottomY - 4;
        this.y = baseFloor - (baseFloor - heapSurfaceY) * this.relDepth;
        this.vx = 0;
        this.vy = 0;
      }
    } else if (this.type === 'methanogen') {
      this.size = 5.5;
      this.color = '#ec4899';
      if (currentSimView === 'batch') {
        this.relX = 0.2 + Math.random() * 0.6;
        let vWidth = this.vessel === 1 ? geom.v1Width : geom.v2Width;
        let vX = this.vessel === 1 ? geom.v1X : geom.v2X;
        this.x = vX + this.relX * vWidth;
        
        let centerX = this.vessel === 1 ? geom.v1CenterX : geom.v2CenterX;
        let dx = (this.x - centerX) / (vWidth * 0.35);
        let heapHeight = this.vessel === 1 ? (geom.h * 0.18) : (geom.h * 0.11);
        let heapSurfaceY = (geom.bottomY - 6) - heapHeight * Math.exp(-dx * dx);
        let baseFloor = geom.bottomY - 4;
        this.y = baseFloor - (baseFloor - heapSurfaceY) * this.relDepth;
        this.vx = 0;
        this.vy = 0;
      }
    } else if (this.type === 'gas') {
      this.size = 1.5 + Math.random() * 1.5;
      this.color = 'rgba(34, 211, 238, 0.85)';
      this.gasState = 'v1_headspace';
    }
  }
  
  update(agitationSpeed, liquidColorHex) {
    this.pulse += 0.05;
    let geom = getGeometry();
    
    // 1. Gas particle special pipeline physics
    if (this.type === 'gas') {
      if (this.gasState === 'v1_headspace') {
        this.vx += 0.03 + (Math.random() - 0.4) * 0.05;
        this.vy += -0.04 + (Math.random() - 0.5) * 0.05;
        
        this.x += this.vx;
        this.y += this.vy;
        
        this.vx *= 0.92;
        this.vy *= 0.92;
        
        if (this.x < geom.v1X + 4) { this.x = geom.v1X + 4; this.vx = -this.vx * 0.2; }
        if (this.y < geom.topY + 6) { this.y = geom.topY + 6; this.vy = -this.vy * 0.2; }
        
        // Sucked into connecting pipe
        if (this.x >= geom.v1X + geom.v1Width - 4 && this.y >= geom.pipeY - 12 && this.y <= geom.pipeY + 12) {
          this.gasState = 'connecting_pipe';
          this.y = geom.pipeY + (Math.random() - 0.5) * 4;
          this.vx = 1.5;
          this.vy = 0;
        } else if (this.x >= geom.v1X + geom.v1Width - 4) {
          this.x = geom.v1X + geom.v1Width - 4;
          this.vx = -this.vx * 0.2;
        }
      } 
      else if (this.gasState === 'connecting_pipe') {
        this.x += this.vx;
        this.vx = 1.5 + Math.random() * 0.5;
        this.vy = 0;
        
        if (this.y < geom.pipeY - 5) this.y = geom.pipeY - 5;
        if (this.y > geom.pipeY + 5) this.y = geom.pipeY + 5;
        
        if (this.x >= geom.v2X + 4) {
          this.gasState = 'v2_headspace';
          this.vx = (Math.random() - 0.5) * 0.5;
          this.vy = -0.5;
        }
      } 
      else if (this.gasState === 'v2_headspace') {
        let dx = geom.v2CenterX - this.x;
        this.vx += dx * 0.01 + (Math.random() - 0.5) * 0.08;
        this.vy += -0.05 + (Math.random() - 0.5) * 0.05;
        
        this.x += this.vx;
        this.y += this.vy;
        
        this.vx *= 0.94;
        this.vy *= 0.94;
        
        if (this.x < geom.v2X + 4) { this.x = geom.v2X + 4; this.vx = -this.vx * 0.2; }
        if (this.x > geom.v2X + geom.v2Width - 4) { this.x = geom.v2X + geom.v2Width - 4; this.vx = -this.vx * 0.2; }
        if (this.y < geom.topY + 6) { this.y = geom.topY + 6; this.vy = -this.vy * 0.2; }
        
        if (Math.abs(this.x - geom.v2CenterX) < 6 && this.y <= geom.topY + 8) {
          this.gasState = 'exhaust_vertical';
          this.x = geom.v2CenterX + (Math.random() - 0.5) * 2;
          this.vy = -1.8;
          this.vx = 0;
        }
      } 
      else if (this.gasState === 'exhaust_vertical') {
        this.y += this.vy;
        this.vy = -1.8 - Math.random() * 0.4;
        this.x = geom.v2CenterX;
        
        if (this.y <= geom.exhaustY) {
          this.gasState = 'exhaust_horizontal';
          this.y = geom.exhaustY;
          this.vx = 2.0;
          this.vy = 0;
        }
      } 
      else if (this.gasState === 'exhaust_horizontal') {
        this.x += this.vx;
        this.vx = 2.0 + Math.random() * 0.6;
        this.y = geom.exhaustY;
        
        if (this.x >= geom.w - 4) {
          this.dead = true;
          gasExitCount++;
        }
      }
      return;
    }
    
    // Normal particles agitation vortex effect
    let centerX = this.vessel === 1 ? geom.v1CenterX : geom.v2CenterX;
    let centerY = geom.bottomY - (geom.bottomY - geom.topY) * 0.35;
    let liquidSurf = this.vessel === 1 ? liquidSurfaceY1 : liquidSurfaceY2;
    
    let isSubmersed = this.y >= liquidSurf;
    
    if (agitationSpeed > 0 && isSubmersed) {
      let dx = this.x - centerX;
      let dy = this.y - centerY;
      let dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist > 10) {
        let force = (agitationSpeed * 0.15) / (dist * 0.02 + 1.0);
        if (this.vessel === 2) force *= 0.15; // secondary reactor is calm
        this.vx += (-dy / dist) * force;
        this.vy += (dx / dist) * force;
      }
    }
    
    if (currentSimView === 'batch' && !isSubmersed) {
      if (this.type === 'solid' || this.type === 'acidogen' || this.type === 'methanogen') {
        let vWidth = this.vessel === 1 ? geom.v1Width : geom.v2Width;
        let vCenterX = this.vessel === 1 ? geom.v1CenterX : geom.v2CenterX;
        let dx = (this.x - vCenterX) / (vWidth * 0.35);
        let heapHeight = this.vessel === 1 ? (geom.h * 0.18) : (geom.h * 0.11);
        let heapSurfaceY = (geom.bottomY - 6) - heapHeight * Math.exp(-dx * dx);
        let baseFloor = geom.bottomY - 4;
        let groundY = baseFloor - (baseFloor - heapSurfaceY) * this.relDepth;
        
        if (this.y < groundY) {
          this.vy += 0.25;
          this.vx *= 0.90;
        } else {
          this.y = groundY;
          this.vy = 0;
          this.vx = 0;
        }
      }
    }
    
    this.x += this.vx;
    this.y += this.vy;
    
    this.vx *= 0.95;
    this.vy *= 0.95;
    
    let xMin = this.vessel === 1 ? geom.v1X : geom.v2X;
    let xMax = this.vessel === 1 ? (geom.v1X + geom.v1Width) : (geom.v2X + geom.v2Width);
    
    if (this.x < xMin + 6) { this.x = xMin + 6; this.vx = -this.vx * 0.4; }
    if (this.x > xMax - 6) { this.x = xMax - 6; this.vx = -this.vx * 0.4; }
    
    if (isSubmersed) {
      if (this.y < liquidSurf + 2 && this.type !== 'bubble') {
        this.y = liquidSurf + 2;
        this.vy = -this.vy * 0.1;
      }
    }
    
    if (this.y > geom.bottomY - 6) {
      this.y = geom.bottomY - 6;
      this.vy = -this.vy * 0.2;
    }
    
    // Transformations
    if (this.type === 'bubble') {
      if (this.y <= liquidSurf + 4) {
        this.dead = true;
        spawnParticle('gas', this.x, liquidSurf - 2);
      }
    } else if (this.type === 'solid') {
      if (simIsPlaying) {
        let baseDecay = (0.0007 + Math.random() * 0.0011) * simSpeed;
        let tempFactor = 1.0 + (inputs.temp - 30) * 0.04;
        baseDecay *= tempFactor;
        
        if (inputs.enhThermal) baseDecay *= 2.2;
        if (inputs.enhEnzymatic) baseDecay *= 1.5;
        
        this.life -= baseDecay;
        if (this.life <= 0) {
          this.type = 'soluble';
          this.size = 2.5 + Math.random() * 2.5;
          this.color = 'rgba(16, 185, 129, 0.75)';
          this.vx = (Math.random() - 0.5) * 1.0;
          this.vy = (Math.random() - 0.5) * 0.6;
          this.life = 1.0;
        }
      }
    } else if (this.type === 'soluble') {
      if (simIsPlaying) {
        particles.forEach(p => {
          if (p.type === 'acidogen' && p.vessel === this.vessel) {
            let dist = Math.hypot(this.x - p.x, this.y - p.y);
            if (dist < 15 && Math.random() < 0.07 * simSpeed) {
              this.type = 'vfa';
              this.size = 1.5 + Math.random() * 1.5;
              this.color = 'rgba(239, 68, 68, 0.85)';
              this.vx = (Math.random() - 0.5) * 0.8;
              this.vy = (Math.random() - 0.5) * 0.6;
              this.life = 1.0;
            }
          }
        });
      }
    } else if (this.type === 'vfa') {
      if (simIsPlaying) {
        particles.forEach(p => {
          if (p.type === 'methanogen' && p.activeState !== false && p.vessel === this.vessel) {
            let dist = Math.hypot(this.x - p.x, this.y - p.y);
            let reactionProb = 0.07;
            if (inputs.enhBiochar) reactionProb *= 1.6;
            if (inputs.enhNano) reactionProb *= 1.35;
            
            if (dist < 18 && Math.random() < reactionProb * simSpeed) {
              this.type = 'bubble';
              this.size = 1.5 + Math.random() * 3;
              this.color = 'rgba(34, 211, 238, 0.6)';
              this.vy = -0.8 - Math.random() * 1.0;
              this.vx = (Math.random() - 0.5) * 0.3;
              this.y = this.y - 4;
            }
          }
        });
      }
    }
  }
  
  draw() {
    ctx.save();
    
    if (this.type === 'solid') {
      ctx.beginPath();
      if (this.pebblePoints && this.pebblePoints.length > 0) {
        let firstPoint = this.pebblePoints[0];
        ctx.moveTo(this.x + firstPoint.cos * this.size * this.life, this.y + firstPoint.sin * this.size * this.life);
        for (let i = 1; i < this.pebblePoints.length; i++) {
          let pt = this.pebblePoints[i];
          ctx.lineTo(this.x + pt.cos * this.size * this.life, this.y + pt.sin * this.size * this.life);
        }
      } else {
        ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      }
      ctx.closePath();
      ctx.fillStyle = this.solidColor || '#4a2511';
      ctx.fill();
      ctx.strokeStyle = '#1e0e06';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if (this.type === 'soluble') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.shadowBlur = 3;
      ctx.shadowColor = '#10b981';
      ctx.fill();
    } else if (this.type === 'vfa') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    } else if (this.type === 'bubble') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else if (this.type === 'acidogen') {
      let width = this.size * 1.5;
      let height = this.size * 0.6;
      ctx.translate(this.x, this.y);
      ctx.rotate(this.pulse * 0.2);
      ctx.beginPath();
      ctx.roundRect(-width/2, -height/2, width, height, height/2);
      ctx.fillStyle = this.color;
      ctx.shadowBlur = 6;
      ctx.shadowColor = '#eab308';
      ctx.fill();
    } else if (this.type === 'methanogen') {
      let pulseSize = this.size + Math.sin(this.pulse) * 1.2;
      ctx.beginPath();
      ctx.arc(this.x, this.y, pulseSize, 0, Math.PI * 2);
      ctx.fillStyle = this.activeState === false ? '#4b5563' : this.color;
      ctx.shadowBlur = this.activeState === false ? 0 : 8;
      ctx.shadowColor = '#ec4899';
      ctx.fill();
    } else if (this.type === 'gas') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#22d3ee';
      ctx.fill();
    }
    
    ctx.restore();
  }
}

// Particle spawning pool
function initParticleEngine() {
  particles = [];
  
  // Populate starting biomass
  for (let i = 0; i < 7; i++) {
    particles.push(new Particle('acidogen'));
  }
  for (let i = 0; i < 7; i++) {
    particles.push(new Particle('methanogen'));
  }
  
  if (currentSimView === 'batch') {
    let solidCount = 50; // Higher density starting solids pool for rich aesthetics
    for (let i = 0; i < solidCount; i++) {
      particles.push(new Particle('solid'));
    }
  } else {
    for (let i = 0; i < 25; i++) particles.push(new Particle('solid'));
    for (let i = 0; i < 25; i++) particles.push(new Particle('soluble'));
    for (let i = 0; i < 20; i++) particles.push(new Particle('vfa'));
    for (let i = 0; i < 15; i++) particles.push(new Particle('bubble'));
  }
}

function spawnParticle(type, x, y) {
  let p = new Particle(type);
  p.x = x;
  p.y = y;
  
  if (type === 'gas') {
    let geom = getGeometry();
    if (x >= geom.v2X) {
      p.vessel = 2;
      p.gasState = 'v2_headspace';
    } else {
      p.vessel = 1;
      p.gasState = 'v1_headspace';
    }
  }
  
  particles.push(p);
  if (particles.length > 180) {
    let index = particles.findIndex(pa => pa.type !== 'acidogen' && pa.type !== 'methanogen' && pa.type !== 'gas');
    if (index !== -1) particles.splice(index, 1);
  }
}

// Global animation render loop
function startAnimationLoop() {
  // Inner helper for drawing glass vessels
  function drawVesselShell(x, width, topY, bottomY, liquidSurf, liquidColor) {
    let r = 16;
    
    // 1. Draw Liquid fill (if liquid height > 0)
    if (liquidSurf < bottomY) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x + r, bottomY);
      ctx.arcTo(x + width, bottomY, x + width, bottomY - r, r);
      ctx.lineTo(x + width, liquidSurf);
      ctx.lineTo(x, liquidSurf);
      ctx.lineTo(x, bottomY - r);
      ctx.arcTo(x, bottomY, x + r, bottomY, r);
      ctx.closePath();
      
      ctx.fillStyle = liquidColor;
      ctx.fill();
      ctx.restore();
    }
    
    // 2. Draw Glass Shell Outer Border
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, bottomY);
    ctx.arcTo(x + width, bottomY, x + width, bottomY - r, r);
    ctx.lineTo(x + width, topY + r);
    ctx.arcTo(x + width, topY, x + width - r, topY, r);
    ctx.lineTo(x + r, topY);
    ctx.arcTo(x, topY, x, topY + r, r);
    ctx.lineTo(x, bottomY - r);
    ctx.arcTo(x, bottomY, x + r, bottomY, r);
    ctx.closePath();
    
    let glassGrad = ctx.createLinearGradient(x, topY, x + width, bottomY);
    glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    glassGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
    glassGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = glassGrad;
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 2.0;
    ctx.stroke();
    
    // 3. Reflection Highlight Sheen
    ctx.beginPath();
    ctx.moveTo(x + 5, bottomY - 20);
    ctx.lineTo(x + 5, topY + 20);
    ctx.arcTo(x + 5, topY + 5, x + 20, topY + 5, 10);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    ctx.restore();
  }

  // Inner helper to draw connecting and exhaust pipes
  function drawPipes(geom) {
    ctx.save();
    
    // 1. Horizontal connecting pipe between headspaces
    ctx.beginPath();
    ctx.rect(geom.v1X + geom.v1Width, geom.pipeY - 6, geom.v2X - (geom.v1X + geom.v1Width), 12);
    let pipeGrad = ctx.createLinearGradient(0, geom.pipeY - 6, 0, geom.pipeY + 6);
    pipeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
    pipeGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.04)');
    pipeGrad.addColorStop(1, 'rgba(255, 255, 255, 0.10)');
    ctx.fillStyle = pipeGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    // 2. Exhaust pipe (Vessel 2 top center -> top -> right border)
    ctx.beginPath();
    ctx.moveTo(geom.v2CenterX, geom.topY);
    ctx.lineTo(geom.v2CenterX, geom.exhaustY);
    ctx.lineTo(geom.w, geom.exhaustY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    // Inner gas flow path (cyan highlight)
    ctx.beginPath();
    ctx.moveTo(geom.v2CenterX, geom.topY + 2);
    ctx.lineTo(geom.v2CenterX, geom.exhaustY);
    ctx.lineTo(geom.w, geom.exhaustY);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.3)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    ctx.restore();
  }

  // Inner helper to draw mechanical impeller stirrer inside Vessel 1
  function drawStirrer(geom, angle) {
    let shaftX = geom.v1CenterX;
    let shaftTopY = geom.topY + 10;
    let shaftBottomY = geom.bottomY - (geom.bottomY - geom.topY) * 0.40;
    
    ctx.save();
    
    // Shaft
    ctx.beginPath();
    ctx.moveTo(shaftX, shaftTopY);
    ctx.lineTo(shaftX, shaftBottomY);
    let shaftGrad = ctx.createLinearGradient(shaftX - 2, 0, shaftX + 2, 0);
    shaftGrad.addColorStop(0, '#374151');
    shaftGrad.addColorStop(0.5, '#9ca3af');
    shaftGrad.addColorStop(1, '#1f2937');
    ctx.strokeStyle = shaftGrad;
    ctx.lineWidth = 3.0;
    ctx.stroke();
    
    // 3D Perspective Blades
    let bladeWidth = geom.v1Width * 0.55;
    let scaleX = Math.cos(angle);
    
    ctx.beginPath();
    ctx.rect(shaftX - (bladeWidth / 2) * scaleX, shaftBottomY - 5, bladeWidth * scaleX, 10);
    let bladeGrad = ctx.createLinearGradient(0, shaftBottomY - 5, 0, shaftBottomY + 5);
    bladeGrad.addColorStop(0, '#9ca3af');
    bladeGrad.addColorStop(0.5, '#4b5563');
    bladeGrad.addColorStop(1, '#1f2937');
    ctx.fillStyle = bladeGrad;
    ctx.fill();
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    
    // Paddle tips
    ctx.fillStyle = '#374151';
    ctx.fillRect(shaftX - (bladeWidth / 2) * scaleX - 1.5, shaftBottomY - 8, 3, 16);
    ctx.fillRect(shaftX + (bladeWidth / 2) * scaleX - 1.5, shaftBottomY - 8, 3, 16);
    
    ctx.restore();
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let geom = getGeometry();
    
    // Calculate current running pH
    let current_pH = getLivePH();
    
    let liquidColor = 'rgba(16, 185, 129, 0.12)';
    let borderStyle = 'rgba(255, 255, 255, 0.08)';
    let statusText = "System Status: Stable";
    let statusColor = 'var(--color-green)';
    
    if (current_pH < 6.5) {
      liquidColor = 'rgba(239, 68, 68, 0.18)';
      borderStyle = '#ef4444';
      statusText = "System Status: SOURING RISK";
      statusColor = 'var(--color-red)';
    } else if (current_pH < 6.8) {
      liquidColor = 'rgba(245, 158, 11, 0.14)';
      borderStyle = '#f59e0b';
      statusText = "System Status: Mild Acidification";
      statusColor = 'var(--color-gold)';
    }
    
    document.getElementById('reactorCanvas').style.borderColor = borderStyle;
    document.getElementById('reactorStatusText').innerText = statusText;
    document.getElementById('reactorStatusText').style.color = statusColor;
    
    // Dynamic liquid height calculation for both containers
    let levelFraction1 = 1.0;
    let levelFraction2 = 1.0;
    
    if (currentSimView === 'batch') {
      let maxPotential = Math.max(...plotData.batch.yieldEnh, 1);
      let idx = Math.floor(simTime);
      let currentYield = plotData.batch.yieldEnh[idx] || 0;
      let progress = Math.min(currentYield / maxPotential, 1.0);
      
      levelFraction1 = progress * 0.95; // rises with digestion, filling totally to 95% capacity
      levelFraction2 = 0.35;            // stable polishing buffer
    } else {
      levelFraction1 = 0.95;            // primary container is totally filled in continuous mode
      levelFraction2 = 0.70;            // secondary container steady fill
    }
    
    let maxLiquidHeight = geom.bottomY - geom.topY;
    let liquidHeight1 = maxLiquidHeight * levelFraction1;
    let liquidHeight2 = maxLiquidHeight * levelFraction2;
    
    liquidSurfaceY1 = geom.bottomY - liquidHeight1;
    liquidSurfaceY2 = geom.bottomY - liquidHeight2;
    
    // 1. Draw connecting and exhaust pipes (drawn behind the glass shells)
    drawPipes(geom);
    
    // 2. Draw Vessel 1 (Primary Left) liquid and glass shell
    drawVesselShell(geom.v1X, geom.v1Width, geom.topY, geom.bottomY, liquidSurfaceY1, liquidColor);
    
    // 3. Draw Vessel 2 (Secondary Right) liquid and glass shell
    drawVesselShell(geom.v2X, geom.v2Width, geom.topY, geom.bottomY, liquidSurfaceY2, liquidColor);
    
    // 4. Draw Rotating Impeller Stirrer inside Vessel 1
    let agitationFactor = 1.0;
    if (simIsPlaying) {
      agitationFactor = 1.5 + (inputs.temp - 30) * 0.1;
      impellersAngle += 0.08 * agitationFactor;
    }
    drawStirrer(geom, impellersAngle);
    
    // 5. Update and Draw active particles
    particles.forEach(p => {
      if (p.type === 'methanogen') {
        p.activeState = current_pH >= 6.1;
      }
      p.update(simIsPlaying ? agitationFactor : 0.1, liquidColor);
    });
    
    // Filter dead particles
    particles = particles.filter(p => !p.dead);
    
    // Draw all particles
    particles.forEach(p => {
      p.draw();
    });
    
    // 6. Smooth rolling average for escaping gas to fuel burner flame
    gasFlowRate = gasFlowRate * 0.94 + gasExitCount * 0.06;
    gasExitCount = 0; // reset for next frame
    
    // 7. Update burner flame directly in anim loop for maximum frame-by-frame smoothness
    const flame = document.getElementById('biogasFlame');
    const flameContainer = document.getElementById('flameContainer');
    
    let flameScale = Math.min(gasFlowRate * 12.0, 2.5);
    if (currentSimView === 'batch' && simTime >= maxSimTime && simIsPlaying) {
      flameScale = 1.2;
    }
    
    if (flameScale < 0.08 || !simIsPlaying) {
      if (flameContainer) flameContainer.style.transform = 'scale(0)';
    } else {
      if (flameContainer) flameContainer.style.transform = `scale(${flameScale})`;
      if (flame) {
        if (current_pH < 6.4) {
          flame.style.background = 'radial-gradient(circle at center, #f59e0b 20%, #ef4444 60%, rgba(239, 68, 68, 0) 80%)';
          flame.style.filter = 'drop-shadow(0 0 10px rgba(239, 68, 68, 0.9))';
        } else {
          flame.style.background = 'radial-gradient(circle at center, #a5f3fc 15%, #06b6d4 50%, rgba(6, 182, 212, 0) 75%)';
          flame.style.filter = 'drop-shadow(0 0 12px rgba(6, 182, 212, 0.8))';
        }
      }
    }
    
    animationFrameId = requestAnimationFrame(animate);
  }
  
  initParticleEngine();
  animate();
}

// --- DYNAMIC PARTICLE DENSITY ADJUSTER ---
function adjustParticlePopulations(solidT, solubleT, vfaT, bubbleT, acidogenT, methanogenT) {
  let adjustType = (type, targetCount) => {
    let current = particles.filter(p => p.type === type);
    let diff = targetCount - current.length;
    
    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        let p = new Particle(type);
        particles.push(p);
      }
    } else if (diff < 0) {
      let numToRemove = Math.abs(diff);
      let removed = 0;
      for (let i = particles.length - 1; i >= 0; i--) {
        if (particles[i].type === type) {
          particles.splice(i, 1);
          removed++;
          if (removed >= numToRemove) break;
        }
      }
    }
  };

  adjustType('solid', solidT);
  adjustType('soluble', solubleT);
  adjustType('vfa', vfaT);
  adjustType('bubble', bubbleT);
  adjustType('acidogen', acidogenT);
  adjustType('methanogen', methanogenT);
}

// --- DYNAMIC DASHBOARD AESTHETICS (Flame, Warnings, KPIs) ---
function updateLiveBioreactorAesthetics() {
  // Read current live simulation values
  let idx = Math.floor(simTime);
  let live_pH = 7.15;
  let live_gasRate = 0;
  
  if (currentSimView === 'batch') {
    live_gasRate = plotData.batch.rateEnh[idx] || 0;
    live_pH = 7.15; // static mesophilic optimal
  } else {
    live_pH = plotData.continuous.pH[idx] || 7.15;
    live_gasRate = plotData.continuous.rateGas[idx] || 0;
  }

  // Dynamic particle count adjustment based on simulation state
  let solidTarget = 20;
  let solubleTarget = 20;
  let vfaTarget = 15;
  let bubbleTarget = 15;
  let acidogenTarget = 10;
  let methanogenTarget = 10;
  
  if (currentSimView === 'batch') {
    let maxPotential = Math.max(...plotData.batch.yieldEnh, 1);
    let currentYield = plotData.batch.yieldEnh[idx] || 0;
    let progress = Math.min(currentYield / maxPotential, 1.0);
    
    let currentRate = plotData.batch.rateEnh[idx] || 0;
    let maxRate = Math.max(...plotData.batch.rateEnh, 1.0);
    let rateRatio = Math.min(currentRate / maxRate, 1.0);
    
    if (simTime >= maxSimTime) {
      // Keep a steady active baseline of particles so the visualization doesn't freeze or go empty at the end!
      solidTarget = 15;
      solubleTarget = 15;
      vfaTarget = 12;
      bubbleTarget = 15;
      acidogenTarget = 10;
      methanogenTarget = 10;
    } else {
      solidTarget = Math.round(45 * (1.0 - progress));
      solubleTarget = Math.round(30 * rateRatio * (1.0 - progress * 0.5));
      vfaTarget = Math.round(25 * rateRatio * (1.0 - progress * 0.5));
      bubbleTarget = Math.round(30 * rateRatio);
      
      acidogenTarget = Math.round(6 + 6 * progress);
      methanogenTarget = Math.round(6 + 6 * progress);
    }
  } else {
    let live_S = plotData.continuous.S[idx] || 10.0;
    let live_VFA = plotData.continuous.SVFA[idx] || 0.5;
    let live_Xa = plotData.continuous.Xa[idx] || 0.5;
    let live_Xm = plotData.continuous.Xm[idx] || 0.2;
    
    solidTarget = Math.round(inputs.olr * 6.5);
    solubleTarget = Math.min(Math.round(live_S * 2.5), 40);
    vfaTarget = Math.min(Math.round(live_VFA * 4.0), 40);
    bubbleTarget = Math.min(Math.round(live_gasRate * 10.0), 35);
    
    acidogenTarget = Math.min(Math.round(live_Xa * 12), 15);
    methanogenTarget = Math.min(Math.round(live_Xm * 24), 15);
  }
  
  adjustParticlePopulations(solidTarget, solubleTarget, vfaTarget, bubbleTarget, acidogenTarget, methanogenTarget);
  
  // 2. ACIDIFICATION CRITICAL WARNING SYSTEM
  const warningBanner = document.getElementById('reactorWarning');
  if (currentSimView === 'continuous' && live_pH < 6.4) {
    warningBanner.style.display = 'flex';
    if (live_pH < 6.1) {
      document.getElementById('warningHeadline').innerText = "REACTOR CRASHED (Soured)";
      document.getElementById('warningBody').innerText = "Methanogen archaea have died due to critical VFA acidification. Toggle Bicarbonate Buffer or Biochar and reset the system immediately.";
    } else {
      document.getElementById('warningHeadline').innerText = "Severe Acidification Warning!";
      document.getElementById('warningBody').innerText = `pH has dropped to ${live_pH.toFixed(2)}. Methanogenesis is shutting down. Add sodium bicarbonate immediately to restore buffering!`;
    }
  } else {
    warningBanner.style.display = 'none';
  }
  
  // 3. STEP-BY-STEP EXPLAINER CORRESPONDENCE
  // Highlight active biological stages in sync with simulator time
  document.querySelectorAll('.guide-step').forEach(step => step.classList.remove('active'));
  if (simIsPlaying) {
    if (currentSimView === 'batch') {
      if (simTime < 3) {
        document.getElementById('guideStep1').classList.add('active');
      } else if (simTime < 10) {
        document.getElementById('guideStep2').classList.add('active');
      } else {
        document.getElementById('guideStep3').classList.add('active');
      }
    } else {
      // Continuous: look at substrate conversion dynamics
      let live_S = plotData.continuous.S[idx] || 10;
      let live_VFA = plotData.continuous.SVFA[idx] || 0.5;
      if (live_S > 8.0) {
        document.getElementById('guideStep1').classList.add('active');
      } else if (live_VFA > 3.0) {
        document.getElementById('guideStep2').classList.add('active');
      } else {
        document.getElementById('guideStep3').classList.add('active');
      }
    }
  }
}

// KPI Dashboard metrics calculation
function updateKPIs(totalDays) {
  let gasYieldVal = 0;
  let purityVal = 0;
  let phVal = 7.15;
  let benefitVal = 0;
  let carbonOffsetVal = 0;
  
  if (currentSimView === 'batch') {
    // Read final day values for cumulative metrics
    let finalBase = plotData.batch.yieldBase[totalDays] || 0;
    let finalEnh = plotData.batch.yieldEnh[totalDays] || 0;
    
    gasYieldVal = finalEnh;
    purityVal = 62.0 + (inputs.enhBiochar ? 3.5 : 0) + (inputs.enhNano ? 1.5 : 0);
    phVal = 7.15;
    
    // Compare baseline percentage
    let ratio = finalBase > 0 ? ((finalEnh - finalBase) / finalBase * 100) : 0;
    document.getElementById('kpiGasTrendVal').innerText = `${ratio.toFixed(1)}% vs. Baseline`;
    document.getElementById('kpiGasTrend').className = ratio >= 0 ? 'kpi-trend up' : 'kpi-trend down';
    
    // Est. benefit: $ per ton processed. Assume standard solid waste generates 120m3/ton.
    // Enhanced yields bring more gas. Biogas sells at ~$0.45/m3 equivalent energy
    let totalSolidVolume = 1500; // tons processed annually
    benefitVal = Math.round((gasYieldVal / 1000) * totalSolidVolume * 0.45 * 2.8);
    carbonOffsetVal = (gasYieldVal / 1000) * totalSolidVolume * 0.0018; // t CO2e/yr
    
    document.getElementById('kpiMethanePurity').innerText = purityVal.toFixed(1) + '%';
    document.getElementById('kpiPH').innerText = phVal.toFixed(2);
    document.getElementById('pHCard').className = 'kpi-card green';
    document.getElementById('kpIPhStatus').innerText = 'Healthy Meshophilic';
    
  } else {
    // Continuous view: show current live running metrics
    let idx = Math.floor(simTime);
    let cumGasArr = plotData.continuous.cumGas;
    gasYieldVal = cumGasArr[idx] || 0;
    
    let pHArr = plotData.continuous.pH;
    phVal = pHArr[idx] || 7.15;
    
    purityVal = 60.0;
    if (phVal > 6.7) {
      purityVal += (inputs.enhBiochar ? 4.0 : 0) + (inputs.enhNano ? 2.0 : 0);
    } else {
      purityVal -= (7.0 - phVal) * 15.0; // Purity drops severely if soured
    }
    if (purityVal < 30.0) purityVal = 30.0;
    
    // Net Benefit for dynamic continuous reactor
    let activeFlowScale = 2500; // tons/yr scale
    benefitVal = Math.round(gasYieldVal * activeFlowScale * 0.38);
    carbonOffsetVal = gasYieldVal * activeFlowScale * 0.0015;
    
    document.getElementById('kpiGasTrendVal').innerText = "Live Yield Accrual";
    document.getElementById('kpiGasTrend').className = 'kpi-trend neutral';
    
    document.getElementById('kpiMethanePurity').innerText = purityVal.toFixed(1) + '%';
    document.getElementById('kpiPH').innerText = phVal.toFixed(2);
    
    // Dynamically color pH card border/text
    const phCard = document.getElementById('pHCard');
    const phStatus = document.getElementById('kpIPhStatus');
    if (phVal < 6.2) {
      phCard.className = 'kpi-card red';
      phStatus.innerText = 'REACTOR CRASHED (Soured)';
    } else if (phVal < 6.8) {
      phCard.className = 'kpi-card gold';
      phStatus.innerText = 'Acidification Risk';
    } else {
      phCard.className = 'kpi-card green';
      phStatus.innerText = 'Stable Mesophilic';
    }
  }
  
  // Render KPI visual text
  document.getElementById('kpiGasYield').innerText = Math.round(gasYieldVal) + ' m³';
  document.getElementById('kpiNetBenefit').innerText = '$' + benefitVal.toLocaleString() + ' / yr';
  document.getElementById('kpiCarbonOffset').innerText = carbonOffsetVal.toFixed(1) + ' t CO₂e Offset';
  
  // Render Bottom Estimator Metrics
  // Methane to Electricity (1 m³ methane has ~10 kWh thermal energy. CHP Electrical efficiency ~35%)
  let totalGasVolume = gasYieldVal * 2500; // annual projection
  let electricalEnergy = (totalGasVolume * (purityVal/100) * 9.94 * 0.35) / 1000; // MWh
  document.getElementById('calcElectricity').innerText = electricalEnergy.toFixed(1) + ' MWh / yr';
  document.getElementById('calcCarbon').innerText = carbonOffsetVal.toFixed(1) + ' tons / yr';
  
  // Equivalent homes powered (avg home consumes ~3.8 MWh/yr)
  let homes = electricalEnergy / 3.8;
  document.getElementById('calcHomes').innerText = homes.toFixed(1) + ' Households';
  
  // Digestate bio-fertilizer yield (approx 85% of solid waste feed is returned as digestate)
  let digestateFertilizer = 2500 * (compositeWaste.ts) * 0.85;
  document.getElementById('calcFertilizer').innerText = digestateFertilizer.toFixed(1) + ' tons / yr';
}

// --- CHART MANAGER (CHART.JS) ---
function initChart() {
  const chartCtx = document.getElementById('simulationChart').getContext('2d');
  
  // Custom dark mode theme styling for charts
  Chart.defaults.color = '#9ca3af';
  Chart.defaults.font.family = 'Inter';
  
  simulationChart = new Chart(chartCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: []
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            boxWidth: 12,
            font: { weight: 600, family: 'Outfit' }
          }
        },
        tooltip: {
          backgroundColor: '#0c1222',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleFont: { family: 'Outfit', size: 14 }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          title: { display: true, text: 'Time (Days)' }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          title: { display: true, text: 'Biogas (L/kg VS)' }
        }
      }
    }
  });
}

function updateBatchCharts() {
  if (!simulationChart) return;
  simulationChart.data.labels = plotData.batch.days;
  
  let datasets = [];
  
  if (runCompareMode) {
    datasets.push({
      label: 'Standard Baseline',
      data: plotData.batch.yieldBase,
      borderColor: 'rgba(156, 163, 175, 0.65)',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [5, 5],
      pointRadius: 0
    });
  }
  
  datasets.push({
    label: 'Enhanced Biogas Yield',
    data: plotData.batch.yieldEnh,
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
    fill: true,
    borderWidth: 3.5,
    pointRadius: 0,
    tension: 0.1
  });
  
  simulationChart.data.datasets = datasets;
  
  // Hide secondary pH scale from Continuous view
  if (simulationChart.options.scales.yPH) {
    simulationChart.options.scales.yPH.display = false;
  }
  
  simulationChart.options.scales.y.title.text = 'Cumulative Biogas (m³ / ton)';
  simulationChart.update('none'); // silent draw
}

function updateContinuousCharts() {
  if (!simulationChart) return;
  simulationChart.data.labels = plotData.continuous.days;
  
  // Continuous tracks multi-variables: S, SVFA, Xm, pH
  simulationChart.data.datasets = [
    {
      label: 'Organic Substrate (g COD/L)',
      data: plotData.continuous.S,
      borderColor: '#3b82f6',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      yAxisID: 'y'
    },
    {
      label: 'VFA Concentration (g COD/L)',
      data: plotData.continuous.SVFA,
      borderColor: '#ef4444',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      yAxisID: 'y'
    },
    {
      label: 'Methanogen Archaea (g/L)',
      data: plotData.continuous.Xm,
      borderColor: '#ec4899',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [3, 3],
      pointRadius: 0,
      yAxisID: 'y'
    },
    {
      label: 'Reactor pH',
      data: plotData.continuous.pH,
      borderColor: '#f59e0b',
      backgroundColor: 'transparent',
      borderWidth: 3,
      pointRadius: 0,
      yAxisID: 'yPH'
    }
  ];
  
  // Setup multi-axis limits for pH on right scale
  simulationChart.options.scales.yPH = {
    type: 'linear',
    position: 'right',
    min: 4.0,
    max: 8.5,
    title: { display: true, text: 'pH Scale' },
    grid: { drawOnChartArea: false } // don't overlap grids
  };
  
  simulationChart.options.scales.y.title.text = 'Components (g/L)';
  simulationChart.update('none');
}

// Slice plotting arrays dynamically matching real-time playback horizon
function renderLiveChartHorizon() {
  if (!simulationChart) return;
  let idx = Math.floor(simTime);
  
  if (currentSimView === 'batch') {
    simulationChart.data.labels = plotData.batch.days.slice(0, idx + 1);
    
    if (runCompareMode) {
      simulationChart.data.datasets[0].data = plotData.batch.yieldBase.slice(0, idx + 1);
      simulationChart.data.datasets[1].data = plotData.batch.yieldEnh.slice(0, idx + 1);
    } else {
      simulationChart.data.datasets[0].data = plotData.batch.yieldEnh.slice(0, idx + 1);
    }
  } else {
    // Continuous
    simulationChart.data.labels = plotData.continuous.days.slice(0, idx + 1);
    simulationChart.data.datasets[0].data = plotData.continuous.S.slice(0, idx + 1);
    simulationChart.data.datasets[1].data = plotData.continuous.SVFA.slice(0, idx + 1);
    simulationChart.data.datasets[2].data = plotData.continuous.Xm.slice(0, idx + 1);
    simulationChart.data.datasets[3].data = plotData.continuous.pH.slice(0, idx + 1);
  }
  
  simulationChart.update('none');
  updateKPIs(idx);
}

// --- EDUCATIONAL COMPARTMENT ACCORDION ---
function toggleEducationalDrawer() {
  const drawer = document.getElementById('educationalDrawerContent');
  const icon = document.getElementById('drawerToggleIcon');
  if (drawer.style.display === 'none') {
    drawer.style.display = 'grid';
    icon.innerText = '▲';
  } else {
    drawer.style.display = 'none';
    icon.innerText = '▼';
  }
}

// --- DATA EXPORT UTILITIES ---
function exportDataCSV() {
  let csvContent = "data:text/csv;charset=utf-8,";
  
  if (currentSimView === 'batch') {
    csvContent += "Day,Baseline Cumulative Biogas (m3/ton),Enhanced Cumulative Biogas (m3/ton),Baseline Daily Rate (m3/ton/d),Enhanced Daily Rate (m3/ton/d)\n";
    plotData.batch.days.forEach((day, i) => {
      csvContent += `${day},${plotData.batch.yieldBase[i].toFixed(2)},${plotData.batch.yieldEnh[i].toFixed(2)},${plotData.batch.rateBase[i].toFixed(2)},${plotData.batch.rateEnh[i].toFixed(2)}\n`;
    });
  } else {
    csvContent += "Day,Organic Substrate (g COD/L),VFA (g COD/L),Acidogens (g/L),Methanogens (g/L),pH,Biogas Rate (L/L/d),Cumulative Biogas (L)\n";
    plotData.continuous.days.forEach((day, i) => {
      csvContent += `${day},${plotData.continuous.S[i].toFixed(3)},${plotData.continuous.SVFA[i].toFixed(3)},${plotData.continuous.Xa[i].toFixed(3)},${plotData.continuous.Xm[i].toFixed(3)},${plotData.continuous.pH[i].toFixed(2)},${plotData.continuous.rateGas[i].toFixed(3)},${plotData.continuous.cumGas[i].toFixed(2)}\n`;
    });
  }
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `biogas_simulation_${currentSimView}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
