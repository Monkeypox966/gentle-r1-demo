import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {CONFIG_FILE} from '../src/bundle.js';

test('all frozen policy, model and reference assets match the provenance manifest',()=>{
  const root=new URL('../public/assets/r1/',import.meta.url);
  const config=JSON.parse(fs.readFileSync(new URL('config.json',root)));
  const provenance=JSON.parse(fs.readFileSync(new URL('../ASSET_PROVENANCE.json',import.meta.url)));
  assert.equal(config.checkpoint_sha256,'61a5b331557f8e031de4f05fd71b48f58892e8d020578eaaeb1ea45f104af9c5');
  assert.equal(config.onnx_sha256,provenance.onnx_sha256);
  assert.deepEqual(config.files,provenance.assets);
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL(CONFIG_FILE,root))),config);
  assert.equal(CONFIG_FILE,`config-${createHash('sha256').update(fs.readFileSync(new URL('config.json',root))).digest('hex').slice(0,12)}.json`);
  for(const [path,expected] of Object.entries(config.files)){
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL(path,root))).digest('hex'),expected,path);
  }
});
