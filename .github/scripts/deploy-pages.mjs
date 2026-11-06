// GitHub Pages API publisher. The official deploy-pages action cancels pending
// deployments after a hard maximum of 10 minutes, even during file/page sync.
// Keep the same OIDC/artifact authorization with a bounded 25-minute monitor.
import {appendFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';

const env=process.env;
for(const key of ['GH_TOKEN','GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_SHA','ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN','GITHUB_OUTPUT']){
  if(!env[key])throw Error(`Missing Actions environment: ${key}`);
}
const apiRoot=env.GITHUB_API_URL||'https://api.github.com';
const repo=`/repos/${env.GITHUB_REPOSITORY}`;
let deploymentId=null,terminal=false,canceling=false;

async function api(path,method='GET',body){
  const response=await fetch(apiRoot+path,{method,signal:AbortSignal.timeout(30000),headers:{
    Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'
  },body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.status===204?null:response.json();
}
async function cancelOwned(){
  if(!deploymentId||terminal||canceling)return;
  canceling=true;
  try{await api(`${repo}/pages/deployments/${deploymentId}/cancel`,'POST');console.log('Canceled this workflow’s incomplete Pages deployment.');}
  catch(error){console.error(`Cancellation failed: ${error.message}`);}
}
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{await cancelOwned();process.exit(1);});

try{
  const artifacts=await api(`${repo}/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100`);
  const matches=artifacts.artifacts.filter(a=>a.name==='github-pages'&&!a.expired);
  if(matches.length!==1)throw Error(`Expected one verified Pages artifact, found ${matches.length}`);
  const oidcResponse=await fetch(env.ACTIONS_ID_TOKEN_REQUEST_URL,{signal:AbortSignal.timeout(30000),headers:{
    Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
  }});
  if(!oidcResponse.ok)throw Error(`OIDC request failed: HTTP ${oidcResponse.status}`);
  const {value:oidcToken}=await oidcResponse.json();
  if(!oidcToken)throw Error('Missing OIDC token');
  const deployment=await api(`${repo}/pages/deployments`,'POST',{
    artifact_id:matches[0].id,pages_build_version:env.GITHUB_SHA,oidc_token:oidcToken
  });
  deploymentId=deployment.id;
  if(!deploymentId)throw Error('GitHub did not return a deployment ID');
  console.log(`Publishing verified artifact ${matches[0].id}, commit ${env.GITHUB_SHA}.`);
  const deadline=Date.now()+25*60*1000;
  let previous=null,lastLog=0,errors=0;
  while(Date.now()<deadline){
    let status;
    try{
      ({status}=await api(`${repo}/pages/deployments/${deploymentId}?poll=${Date.now()}`));errors=0;
    }catch(error){
      if(++errors>=5)throw error;
      console.warn(`Transient status read failure (${errors}/5).`);await sleep(10000);continue;
    }
    if(status!==previous||Date.now()-lastLog>=60000){console.log(`Pages stage: ${status||'pending status'}`);previous=status;lastLog=Date.now();}
    if(status==='succeed'){
      terminal=true;
      const url=deployment.page_url||(await api(`${repo}/pages`)).html_url;
      if(typeof url!=='string'||!url.startsWith('https://')||/[\r\n]/.test(url))throw Error('Invalid Pages URL');
      await appendFile(env.GITHUB_OUTPUT,`page_url=${url}\n`);
      console.log(`Published ${url}`);break;
    }
    if(/failed|cancelled|canceled|lost/.test(status||'')){terminal=true;throw Error(`Pages deployment ended: ${status}`);}
    await sleep(10000);
  }
  if(!terminal)throw Error('Pages synchronization exceeded the bounded 25-minute deadline');
}catch(error){
  console.error(error.message);await cancelOwned();process.exitCode=1;
}
