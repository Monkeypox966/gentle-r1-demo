// Rendering follows the MuJoCo WASM community's mesh mapping approach.
// Z-up throughout. Always copy mesh arrays: mutating a WASM view changes physics.
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(container,simulation) {
    this.sim=simulation;this.container=container;this.scene=new THREE.Scene();
    this.scene.background=new THREE.Color('#f3f1ec');this.scene.fog=new THREE.Fog('#f3f1ec',8,20);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.75));
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1;this.renderer.domElement.setAttribute('aria-label','R1 真实物理仿真三维画面');
    container.append(this.renderer.domElement);
    this.camera=new THREE.PerspectiveCamera(36,1,.01,80);this.camera.up.set(0,0,1);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);
    this.controls.enableDamping=true;this.controls.dampingFactor=.08;this.controls.minDistance=1.1;this.controls.maxDistance=6;
    this.controls.maxPolarAngle=Math.PI*.49;this.home();
    this.scene.add(new THREE.HemisphereLight(0xf6f8ff,0xc6b9a8,1.5));
    const key=new THREE.DirectionalLight(0xfff4e6,2);key.position.set(2,-3,5);key.castShadow=true;
    key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-2;key.shadow.camera.right=2;key.shadow.camera.top=2;key.shadow.camera.bottom=-2;key.shadow.normalBias=.015;this.scene.add(key);
    const rim=new THREE.DirectionalLight(0xb3d6d1,1);rim.position.set(-3,1,3);this.scene.add(rim);
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshStandardMaterial({color:0xece9e2,roughness:.96}));
    ground.position.z=-.002;ground.receiveShadow=true;this.scene.add(ground);
    const grid=new THREE.GridHelper(40,100,0xc7c3b9,0xd8d3ca);grid.rotation.x=Math.PI/2;grid.position.z=.001;grid.material.transparent=true;grid.material.opacity=.28;this.scene.add(grid);
    this.geometries=new Map();this.meshes=this.buildRobot(false);this.ghosts=this.buildRobot(true);
    this.ghostVisible=false;this.follow=true;this.previousRoot=new THREE.Vector3(...simulation.root);
    this.forceArrows=Array.from({length:4},()=>{const a=new THREE.ArrowHelper(new THREE.Vector3(1,0,0),new THREE.Vector3(),.2,0xdc6b35,.045,.022);a.visible=false;this.scene.add(a);return a;});
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.plane=new THREE.Plane();this.dragMode=false;
    this.bindDrag();this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
    this.animate=this.animate.bind(this);this.lastFrame=performance.now();this.frames=0;this.fps=0;this.frameStart=this.lastFrame;this.animate();
  }
  geometry(meshId) {
    if(this.geometries.has(meshId))return this.geometries.get(meshId);
    const m=this.sim.model,g=new THREE.BufferGeometry();
    const start=m.mesh_vertadr[meshId]*3,count=m.mesh_vertnum[meshId]*3;
    g.setAttribute('position',new THREE.BufferAttribute(Float32Array.from(m.mesh_vert.slice(start,start+count)),3));
    const face=m.mesh_faceadr[meshId]*3,length=m.mesh_facenum[meshId]*3;
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.mesh_face.slice(face,face+length)),1));
    g.computeVertexNormals();g.computeBoundingSphere();this.geometries.set(meshId,g);return g;
  }
  buildRobot(ghost) {
    const m=this.sim.model,out=[],visualBodies=new Set();
    for(let g=0;g<m.ngeom;g++)if(m.geom_group[g]===1)visualBodies.add(m.geom_bodyid[g]);
    for(let g=0;g<m.ngeom;g++){
      const body=m.geom_bodyid[g],type=m.geom_type[g];
      if(body===0 || type!==7 || (m.geom_group[g]!==1 && visualBodies.has(body)))continue;
      const rgba=Array.from(m.geom_rgba.slice(g*4,g*4+4));
      const material=new THREE.MeshStandardMaterial({color:ghost?0x15827b:new THREE.Color(rgba[0],rgba[1],rgba[2]),
        roughness:.38,metalness:ghost?0:.1,transparent:ghost,opacity:ghost?.16:1,depthWrite:!ghost});
      const mesh=new THREE.Mesh(this.geometry(m.geom_dataid[g]),material);
      mesh.castShadow=!ghost;mesh.receiveShadow=!ghost;mesh.userData={geom:g,body};mesh.renderOrder=ghost?1:0;
      this.scene.add(mesh);out.push(mesh);
    }
    return out;
  }
  updateMeshes(meshes,data,visible=true){
    const matrix=new THREE.Matrix4();
    for(const mesh of meshes){
      mesh.visible=visible;if(!visible)continue;
      const g=mesh.userData.geom,p=data.geom_xpos,r=data.geom_xmat;
      mesh.position.set(p[3*g],p[3*g+1],p[3*g+2]);const j=9*g;
      matrix.set(r[j],r[j+1],r[j+2],0,r[j+3],r[j+4],r[j+5],0,r[j+6],r[j+7],r[j+8],0,0,0,0,1);
      mesh.quaternion.setFromRotationMatrix(matrix);
    }
  }
  home(){this.camera.position.set(2.2,-2.25,1.45);this.controls.target.set(0,0,.68);this.controls.update();}
  resize(){const {width,height}=this.container.getBoundingClientRect();this.renderer.setSize(width,height);this.camera.aspect=width/Math.max(height,1);this.camera.updateProjectionMatrix();}
  pick(event){const rect=this.renderer.domElement.getBoundingClientRect();this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);return this.raycaster.intersectObjects(this.meshes,false)[0];}
  bindDrag(){
    const canvas=this.renderer.domElement;
    canvas.addEventListener('pointerdown',event=>{
      if(!(event.shiftKey||this.dragMode)||event.button!==0)return;
      const hit=this.pick(event);if(!hit)return;
      event.preventDefault();this.controls.enabled=false;canvas.setPointerCapture(event.pointerId);
      const body=hit.object.userData.body,p=this.sim.data.xpos.slice(body*3,body*3+3),r=this.sim.data.xmat.slice(body*9,body*9+9);
      const delta=hit.point.toArray().map((x,i)=>x-p[i]);
      const local=[0,1,2].map(i=>r[i]*delta[0]+r[3+i]*delta[1]+r[6+i]*delta[2]);
      this.plane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()),hit.point);
      this.sim.drag={body,local,anchor:hit.point.toArray()};this.dragging=true;
    },true);
    canvas.addEventListener('pointermove',event=>{
      if(!this.dragging)return;
      const rect=canvas.getBoundingClientRect();this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
      this.raycaster.setFromCamera(this.pointer,this.camera);const point=new THREE.Vector3();
      if(this.raycaster.ray.intersectPlane(this.plane,point))this.sim.drag.anchor=point.toArray();
    });
    const stop=()=>{this.dragging=false;this.sim.drag=null;this.controls.enabled=true;};
    canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);window.addEventListener('blur',stop);
  }
  animate(){
    if(this.disposed)return;this.raf=requestAnimationFrame(this.animate);
    this.updateMeshes(this.meshes,this.sim.data);this.updateMeshes(this.ghosts,this.sim.referenceData,this.ghostVisible);
    const root=new THREE.Vector3(...this.sim.root);
    if(this.follow){const d=root.clone().sub(this.previousRoot);this.camera.position.add(d);this.controls.target.add(d);}
    this.previousRoot.copy(root);
    this.forceArrows.forEach((a,i)=>{const f=this.sim.forceVectors[i];a.visible=!!f&&Math.hypot(...f.force)>.1;
      if(a.visible){const dir=new THREE.Vector3(...f.force),magnitude=dir.length();a.position.set(...f.point);a.setDirection(dir.normalize());a.setLength(magnitude*.018,.05,.025);}});
    this.controls.update();this.renderer.render(this.scene,this.camera);this.frames++;
    const now=performance.now();if(now-this.frameStart>1000){this.fps=this.frames*1000/(now-this.frameStart);this.frames=0;this.frameStart=now;}
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();this.controls.dispose();for(const g of this.geometries.values())g.dispose();for(const m of [...this.meshes,...this.ghosts])m.material.dispose();this.renderer.dispose();}
}
