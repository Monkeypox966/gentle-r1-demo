import './style.css';
import {Simulation} from './simulation.js';
import {Viewer} from './viewer.js';

const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const app={playing:false,busy:false,speed:1,sim:null,viewer:null,forceHistory:Array(150).fill(0),loaded:false,selectionRequest:0,resumeAfterSelection:false};
let resolveReady,rejectReady;
const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
function status(label,kind=''){ $('status-text').textContent=label;$('status-pill').className='status-pill '+kind; }
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function pause(){app.playing=false;$('play-label').textContent='继续运行';$('play-icon').textContent='▶';if(app.loaded)status(app.sim.fault?'保护暂停':'已暂停',app.sim.fault?'error':'');}
function play(){
  if(!app.loaded||app.busy)return;
  if(app.sim.fault)reset();
  app.playing=true;$('play-label').textContent='暂停';$('play-icon').textContent='Ⅱ';status('策略运行中','running');message('拖拽机器人施力，或开启腕部弹簧，观察策略的响应。');
}
function reset(){
  if(app.busy)return;
  pause();app.viewer.releaseDrag();app.sim.reset();app.forceHistory.fill(0);app.viewer.home();
  $('play-label').textContent='运行策略';status('已就绪');message('');update();
}
async function pump(){
  for(;;){
    if(!app.playing||app.busy||document.hidden){await sleep(20);continue;}
    const started=performance.now();
    try{app.inStep=true;await app.sim.step();app.inStep=false;}
    catch(error){app.inStep=false;pause();status('保护暂停','error');message(error.message+'，请复位后重试。',true);console.warn('Simulation paused:',error.message);}
    await sleep(Math.max(0,20/app.speed-(performance.now()-started)));
  }
}
function chart(){
  const canvas=$('force-chart'),ctx=canvas.getContext('2d'),w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio,2);
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#edf0e6';ctx.lineWidth=1;for(let k=1;k<=2;k++){ctx.beginPath();ctx.moveTo(0,h*k/3);ctx.lineTo(w,h*k/3);ctx.stroke();}
  const values=app.forceHistory;ctx.beginPath();ctx.moveTo(0,h);
  values.forEach((v,i)=>ctx.lineTo(i/(values.length-1)*w,h-4-Math.min(v,30)/30*(h-8)));ctx.lineTo(w,h);ctx.closePath();ctx.fillStyle='#db8a4920';ctx.fill();
  ctx.beginPath();values.forEach((v,i)=>{const x=i/(values.length-1)*w,y=h-4-Math.min(v,30)/30*(h-8);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle='#c18855';ctx.lineWidth=1.4;ctx.stroke();
}
function update(){
  if(!app.loaded)return;
  const s=app.sim;$('time').textContent=s.time.toFixed(2)+' s';
  $('inference-ms').innerHTML=s.policyMs.toFixed(2)+' <small>ms</small>';$('measured-force').innerHTML=s.lastForce.toFixed(1)+' <small>N</small>';
  $('fps').textContent=app.viewer.fps?Math.round(app.viewer.fps)+' FPS':'— FPS';
  if(app.playing){app.forceHistory.shift();app.forceHistory.push(s.lastForce);}chart();
}
async function main(){
  try{
    app.sim=new Simulation((value,text)=>{$('loading-progress').style.width=(value*100)+'%';$('loading-text').textContent=text;});
    await app.sim.init();app.viewer=new Viewer($('viewport'),app.sim);app.loaded=true;
    $('motion').replaceChildren(...app.sim.config.motions.map(entry=>new Option(entry.label,entry.id)));
    $('policy').replaceChildren(...app.sim.config.policies.map(entry=>new Option(entry.label,entry.id)));
    $('policy').value=app.sim.policyId;motionDescription();policyDescription();
    $('controls').disabled=false;$('loading').classList.add('hidden');status('已就绪');
    $('interaction-help').showModal();$('interaction-help').focus({preventScroll:true});
    resolveReady(true);pump();setInterval(update,100);
  }catch(error){status('加载失败','error');$('loading-text').textContent=error.message;message('页面加载失败，可刷新重试。'+error.message,true);rejectReady(error);console.error(error);}
}
$('play').addEventListener('click',()=>app.playing?pause():play());$('reset').addEventListener('click',reset);
function motionDescription(){
  const entry=app.sim.config.motions.find(m=>m.id===app.sim.motionId);
  $('motion-description').textContent=entry.label+' · '+entry.description;
}
function policyDescription(){
  const entry=app.sim.policy;
  $('policy-description').textContent=entry.description;
  $('force-limit').disabled=app.busy||!entry.force_conditioned;
  $('force-value').innerHTML=entry.force_conditioned?$('force-limit').value+'<span> N</span>':'—';
  $('force-note').textContent=entry.force_conditioned?'网络条件输入，不是实际接触力上限。':'该策略不使用柔顺力调节，仍可拖动施力。';
  $('force-control').classList.toggle('inactive',!entry.force_conditioned);
}
async function selectReferenceOrPolicy(){
  const motionId=$('motion').value,policyId=$('policy').value,request=++app.selectionRequest;
  app.resumeAfterSelection=app.playing||(app.busy&&app.resumeAfterSelection);
  pause();app.viewer.releaseDrag();app.busy=true;
  for(const id of ['play','reset','push','spring','force-limit'])$(id).disabled=true;
  status('正在切换');message('');
  try{
    const committed=await app.sim.select({motionId,policyId});
    if(request!==app.selectionRequest||!committed)return;
    app.forceHistory.fill(0);app.viewer.follow=!!app.sim.config.motions.find(m=>m.id===motionId).locomotion;
    app.viewer.home();motionDescription();$('motion').value=app.sim.motionId;$('policy').value=app.sim.policyId;
    $('play-label').textContent='运行策略';status('已就绪');message('');
    app.busy=false;policyDescription();if(app.resumeAfterSelection)play();update();
  }catch(error){
    if(request!==app.selectionRequest)return;
    $('motion').value=app.sim.motionId;$('policy').value=app.sim.policyId;motionDescription();
    message('切换失败：'+error.message,true);status('切换失败','error');
  }finally{
    if(request===app.selectionRequest){
      app.busy=false;app.resumeAfterSelection=false;
      for(const id of ['play','reset','push','spring'])$(id).disabled=false;
      policyDescription();
    }
  }
}
$('motion').addEventListener('change',selectReferenceOrPolicy);
$('policy').addEventListener('change',selectReferenceOrPolicy);
$('force-limit').addEventListener('input',event=>{const value=Number(event.target.value);$('force-value').innerHTML=value+'<span> N</span>';if(app.sim)app.sim.forceLimit=value;});
$('spring').addEventListener('change',event=>{app.sim.setSpring(event.target.checked);message('');});
$('push').addEventListener('click',()=>{if(!app.playing)play();app.sim.push();message('向躯干施加 10 N、约 0.25 秒的外力。');});
$('home-camera').addEventListener('click',()=>app.viewer?.home());
$('ghost-button').addEventListener('click',()=>{app.viewer.ghostVisible=!app.viewer.ghostVisible;$('ghost-button').setAttribute('aria-pressed',app.viewer.ghostVisible);});
$('fullscreen-button').addEventListener('click',()=>{if(document.fullscreenElement)document.exitFullscreen();else document.querySelector('.viewport-wrap').requestFullscreen?.();});
document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>{app.speed=Number(button.dataset.speed);document.querySelectorAll('[data-speed]').forEach(b=>b.classList.toggle('active',b===button));}));
$('about-button').addEventListener('click',()=>$('about').showModal());
$('close-about').addEventListener('click',()=>$('about').close());$('about').addEventListener('click',event=>{if(event.target===$('about')){const r=$('about').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('about').close();}});
function dismissInteractionHelp(){
  const hint=$('interaction-help');if(!hint.open||hint.classList.contains('leaving'))return;
  hint.classList.add('leaving');
  setTimeout(()=>{hint.close();hint.classList.remove('leaving');$('play').focus();},matchMedia('(prefers-reduced-motion: reduce)').matches?0:240);
}
$('interaction-help').addEventListener('click',dismissInteractionHelp);
$('interaction-help').addEventListener('cancel',event=>{event.preventDefault();dismissInteractionHelp();});
document.addEventListener('keydown',event=>{if(/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)||document.querySelector('dialog[open]'))return;if(event.code==='Space'){event.preventDefault();app.playing?pause():play();}if(event.code==='KeyR'&&app.loaded)reset();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&app.playing){pause();message('标签页已隐藏，仿真自动暂停。');}});
window.addEventListener('pagehide',()=>{pause();app.viewer?.dispose();app.sim?.dispose();});
// Deterministic acceptance interface also supports reproducible scientific checks.
window.__R1_DEBUG__={ready,app,async runSteps(count){pause();while(app.inStep)await sleep(5);app.busy=true;try{let peakForce=0;for(let i=0;i<count;i++){await app.sim.step();peakForce=Math.max(peakForce,app.sim.lastForce);}update();return {steps:app.sim.steps,time:app.sim.time,root:app.sim.root,force:app.sim.lastForce,peakForce,fault:app.sim.fault};}finally{app.busy=false;}}};
main();
