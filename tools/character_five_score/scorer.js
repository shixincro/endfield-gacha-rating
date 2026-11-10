'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Deterministic natural-six renewal-cycle mean, with marginal P5=.08 and
// six-star resets of five-star pity. Rush guarantees upgrade four-star only.
const BASELINE = Object.freeze({mainRate:0.13411295200285397, rushMean:1.1980598575793349});
const VERSION = 'five-flat-v1';
function normalCDF(x) {
  const sign=Math.sign(x), a=Math.abs(x)/Math.SQRT2, t=1/(1+.3275911*a);
  const erf=sign*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a));
  return (1+erf)/2;
}
function rawZ({N,R,F}) {
  for(const [name,value] of Object.entries({N,R,F})) {
    if(!Number.isSafeInteger(value)||value<0)throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  if(N===0&&R===0&&F===0)return null;
  if(N===0||!Number.isSafeInteger(N+10*R)||F>N+10*R||R>Math.floor(N/30))throw new RangeError('Inconsistent standard-banner main/rush/five counts');
  const p=BASELINE.mainRate+BASELINE.rushMean*R/N;
  if(!(p>0&&p<1))throw new RangeError('Unsupported baseline rate');
  return (F-N*p)/Math.sqrt(N*p*(1-p));
}
function validateParameters(parameters) {
  if(!parameters||parameters.version!==VERSION||!Number.isFinite(parameters.mu)||
    !Number.isFinite(parameters.sigma)||parameters.sigma<=0)throw new RangeError('Invalid calibration parameters');
  for(const key of ['mainRate','rushMean']) {
    const value=parameters.baseline?.[key];
    if(!Number.isFinite(value)||Math.abs(value-BASELINE[key])>1e-12)throw new RangeError('Calibration mechanism mismatch');
  }
}
let cachedParameters;
function loadParameters() {
  if(!cachedParameters) {
    const candidate=JSON.parse(fs.readFileSync(path.join(__dirname,'parameters.json'),'utf8'));
    validateParameters(candidate);
    candidate.baseline=Object.freeze(candidate.baseline);
    cachedParameters=Object.freeze(candidate);
  }
  return cachedParameters;
}
function scoreFive(record,parameters=loadParameters()) {
  validateParameters(parameters);
  const z=rawZ(record);
  return z===null?null:100*normalCDF((z-parameters.mu)/parameters.sigma);
}
function fit(training) {
  const zs=training.map(rawZ);
  if(zs.length<2||zs.some(z=>z===null))throw new RangeError('Need two or more nonempty training records');
  const mu=zs.reduce((s,z)=>s+z,0)/zs.length;
  const sigma=Math.sqrt(zs.reduce((s,z)=>s+(z-mu)**2,0)/(zs.length-1));
  const fitted={version:VERSION,mu,sigma,baseline:BASELINE,trainingN:zs.length};
  validateParameters(fitted);
  return fitted;
}
module.exports={BASELINE,VERSION,rawZ,normalCDF,scoreFive,fit,validateParameters,loadParameters};
