import './style.css';
import {Simulation} from './simulation.js';
import {Viewer} from './viewer.js';

const $=id=>document.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const app={playing:false,busy:false,speed:1,sim:null,viewer:null,forceHistory:Array(150).fill(0),loaded:false};
let resolveReady,rejectReady;
const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
function status(label,kind=''){ $('status-text').textContent=label;$('status-pill').className='status-pill '+kind; }
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function pause(){app.playing=false;$('play-label').textContent='继续运行';$('play-icon').textContent='▶';if(app.loaded)status(app.sim.fault?'保护暂停':'已暂停',app.sim.fault?'error':'');}
function play(){
  if(!app.loaded)return;
  if(app.sim.fault||app.sim.finished)reset();
  app.playing=true;$('play-label').textContent='暂停';$('play-icon').textContent='Ⅱ';status('策略运行中','running');message('拖拽机器人施力，或开启腕部弹簧，观察策略的响应。');
}
function reset(){
  pause();app.viewer.releaseDrag();app.sim.reset();app.forceHistory.fill(0);app.viewer.home();
  $('play-label').textContent='运行策略';status('已就绪');message('片段已复位。点击「运行策略」开始。');update();
}
async function pump(){
  for(;;){
    if(!app.playing||app.busy||document.hidden){await sleep(20);continue;}
    const started=performance.now();
    try{app.inStep=true;const committed=await app.sim.step();app.inStep=false;if(committed&&app.sim.finished){pause();status('片段完成');$('play-label').textContent='重新运行';message('10 秒片段已完成。可以更换动作或力条件后重新运行。');}}
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
  const s=app.sim;$('time').textContent=s.time.toFixed(2)+' s';$('timeline-progress').style.width=Math.min(100,s.time/s.duration*100)+'%';
  $('physics-steps').innerHTML=(s.steps*4).toLocaleString()+' <small>steps</small>';
  $('inference-ms').innerHTML=s.policyMs.toFixed(2)+' <small>ms</small>';$('measured-force').innerHTML=s.lastForce.toFixed(1)+' <small>N</small>';
  $('fps').textContent=app.viewer.fps?Math.round(app.viewer.fps)+' FPS':'— FPS';
  if(app.playing){app.forceHistory.shift();app.forceHistory.push(s.lastForce);}chart();
}
async function main(){
  try{
    app.sim=new Simulation((value,text)=>{$('loading-progress').style.width=(value*100)+'%';$('loading-text').textContent=text;});
    await app.sim.init();app.viewer=new Viewer($('viewport'),app.sim);app.loaded=true;
    $('controls').disabled=false;$('loading').classList.add('hidden');status('已就绪');
    resolveReady(true);pump();setInterval(update,100);
  }catch(error){status('加载失败','error');$('loading-text').textContent=error.message;message('页面加载失败，可刷新重试。'+error.message,true);rejectReady(error);console.error(error);}
}
$('play').addEventListener('click',()=>app.playing?pause():play());$('reset').addEventListener('click',reset);
$('motion').addEventListener('change',async event=>{
  pause();app.viewer.releaseDrag();app.busy=true;status('正在切换');
  try{await app.sim.selectMotion(event.target.value);app.forceHistory.fill(0);app.viewer.home();$('motion-description').textContent=app.sim.config.motions.find(m=>m.id===event.target.value).description;$('play-label').textContent='运行策略';status('已就绪');message('动作已切换。点击「运行策略」运行新的闭环片段。');}
  catch(error){message(error.message,true);status('加载失败','error');}finally{app.busy=false;}
});
$('force-limit').addEventListener('input',event=>{const value=Number(event.target.value);$('force-value').innerHTML=value+'<span> N</span>';if(app.sim)app.sim.forceLimit=value;});
$('spring').addEventListener('change',event=>{app.sim.spring=event.target.checked;message(event.target.checked?'腕部弹簧已开启。为比较相同条件，建议复位后重新运行。':'腕部弹簧已关闭。');});
$('drag-mode').addEventListener('click',()=>{app.viewer.dragMode=!app.viewer.dragMode;$('drag-mode').setAttribute('aria-pressed',app.viewer.dragMode);message(app.viewer.dragMode?'施力模式：直接拖动机器人；松开立即撤力。':'视角模式：拖动旋转；按 Shift 可临时施力。');});
$('push').addEventListener('click',()=>{if(!app.playing)play();app.sim.push();message('向躯干施加 10 N、约 0.25 秒的外力。');});
$('home-camera').addEventListener('click',()=>app.viewer?.home());
$('ghost-button').addEventListener('click',()=>{app.viewer.ghostVisible=!app.viewer.ghostVisible;$('ghost-button').setAttribute('aria-pressed',app.viewer.ghostVisible);});
$('fullscreen-button').addEventListener('click',()=>{if(document.fullscreenElement)document.exitFullscreen();else document.querySelector('.viewport-wrap').requestFullscreen?.();});
document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>{app.speed=Number(button.dataset.speed);document.querySelectorAll('[data-speed]').forEach(b=>b.classList.toggle('active',b===button));}));
for(const id of ['about-button','limitations-button'])$(id).addEventListener('click',()=>$('about').showModal());
$('close-about').addEventListener('click',()=>$('about').close());$('about').addEventListener('click',event=>{if(event.target===$('about')){const r=$('about').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('about').close();}});
document.addEventListener('keydown',event=>{if(/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)||$('about').open)return;if(event.code==='Space'){event.preventDefault();app.playing?pause():play();}if(event.code==='KeyR'&&app.loaded)reset();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&app.playing){pause();message('标签页已隐藏，仿真自动暂停。');}});
window.addEventListener('pagehide',()=>{pause();app.viewer?.dispose();app.sim?.dispose();});
// Deterministic acceptance interface also supports reproducible scientific checks.
window.__R1_DEBUG__={ready,app,async runSteps(count){pause();while(app.inStep)await sleep(5);app.busy=true;try{let peakForce=0;for(let i=0;i<count;i++){await app.sim.step();peakForce=Math.max(peakForce,app.sim.lastForce);}update();return {steps:app.sim.steps,time:app.sim.time,root:app.sim.root,force:app.sim.lastForce,peakForce,fault:app.sim.fault};}finally{app.busy=false;}}};
main();
